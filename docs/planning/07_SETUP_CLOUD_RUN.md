# 07 — Setup: Cloud Run (backend + NER sidecar)

How to initialize and deploy the two services that make up our compute: the **Node backend/API** and the **Python NER sidecar**. Both run on **Cloud Run** — autoscaling, pay-per-use, scales to zero when idle (great for the $2k credit).

> Prereqs: GCP project with billing enabled, `gcloud` CLI installed, Docker installed (or use Cloud Build).

---

## 1. One-time project setup

```bash
# Log in and pick your project
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable the APIs we need
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  speech.googleapis.com \
  secretmanager.googleapis.com

# Pick a region (use one near you / your data-residency requirement)
gcloud config set run/region us-central1

# Create an Artifact Registry repo for container images
gcloud artifacts repositories create scribe \
  --repository-format=docker \
  --location=us-central1
```

---

## 2. Store secrets (never in code)

```bash
# Gemini AI Studio API key
echo -n "YOUR_GEMINI_AI_STUDIO_KEY" | \
  gcloud secrets create gemini-api-key --data-file=-

# (later) any other keys the same way
```

Grant the Cloud Run service account access at deploy time (shown below).

---

## 3. Service A — Node backend/API

This is the orchestrator: receives audio/transcript, calls ASR, calls the NER sidecar, calls Gemini, validates, writes to Firestore.

**`backend/Dockerfile`**
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
CMD ["node", "server.js"]
```

**`backend/server.js` (skeleton)**
```js
import express from "express";
const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/generate-note", async (req, res) => {
  const { transcript, specialty, noteType } = req.body;
  // 1. call NER sidecar
  // 2. de-identify
  // 3. call Gemini (AI Studio) with transcript + entities + schema
  // 4. validate against schema + cross-check meds vs NER
  // 5. write draft to Firestore
  res.json({ ok: true /* , draftId */ });
});

app.listen(process.env.PORT || 8080);
```

**Deploy** (Cloud Build builds the image, then deploy):
```bash
gcloud builds submit backend \
  --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/scribe/backend

gcloud run deploy scribe-backend \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/scribe/backend \
  --allow-unauthenticated=false \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --min-instances=0 --max-instances=10 \
  --memory=512Mi --cpu=1 --concurrency=40
```

> `--allow-unauthenticated=false` keeps it private; the Next.js app calls it with an identity token, or you put it behind API Gateway / IAP. Never expose a PHI endpoint publicly.

---

## 4. Service B — Python NER sidecar

A tiny FastAPI service that loads scispaCy + Med7 + medspaCy once and returns entities as JSON.

**`ner/Dockerfile`**
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# download spaCy models at build time
RUN python -m spacy download en_core_web_sm
COPY . .
ENV PORT=8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

**`ner/requirements.txt`**
```
fastapi
uvicorn[standard]
spacy
scispacy
medspacy
# Med7 + scispaCy model wheels are pip-installed from their release URLs
```

**`ner/main.py` (skeleton)**
```python
from fastapi import FastAPI
from pydantic import BaseModel
import spacy

app = FastAPI()
# load once at cold start
med7 = spacy.load("en_core_med7_lg")      # medications: drug, dose, freq...
sci  = spacy.load("en_ner_bc5cdr_md")     # diseases + chemicals

class Req(BaseModel):
    text: str

@app.get("/healthz")
def health(): return {"ok": True}

@app.post("/ner")
def ner(req: Req):
    ents = []
    for doc, src in [(med7(req.text), "med7"), (sci(req.text), "scispacy")]:
        for e in doc.ents:
            ents.append({"text": e.text, "label": e.label_,
                         "start": e.start_char, "end": e.end_char, "source": src})
    return {"entities": ents}
```

**Deploy:**
```bash
gcloud builds submit ner \
  --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/scribe/ner

gcloud run deploy scribe-ner \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/scribe/ner \
  --no-allow-unauthenticated \
  --min-instances=0 --max-instances=5 \
  --memory=2Gi --cpu=2 --concurrency=10
```

> NER models are memory-hungry — give it 2Gi. Keep it **private**; only the backend calls it (service-to-service auth via ID token).

---

## 5. Wiring the two together (private call)

The backend calls the NER service with a Google-signed ID token:

```js
import { GoogleAuth } from "google-auth-library";
const auth = new GoogleAuth();
const NER_URL = process.env.NER_URL; // https://scribe-ner-xxxx.run.app

async function extractEntities(text) {
  const client = await auth.getIdTokenClient(NER_URL);
  const r = await client.request({
    url: `${NER_URL}/ner`, method: "POST", data: { text },
  });
  return r.data.entities;
}
```

Grant the backend's service account permission to invoke the NER service:
```bash
gcloud run services add-iam-policy-binding scribe-ner \
  --member="serviceAccount:BACKEND_SA_EMAIL" \
  --role="roles/run.invoker"
```

---

## 6. Cost & scaling notes (for the $2k credit)

- **Scale to zero** (`--min-instances=0`): you pay nothing when idle. Good while piloting.
- If cold starts hurt UX, set `--min-instances=1` on the backend once you have real users (small always-on cost).
- **Concurrency**: Node handles many requests per instance (set ~40); NER is heavier (set ~10).
- The dominant cost is **not** Cloud Run — it's Gemini tokens + ASR minutes. Cloud Run at low volume is cents.

---

## 7. Checklist

- [ ] APIs enabled, region set, Artifact Registry repo created.
- [ ] Gemini key in Secret Manager.
- [ ] Backend deployed, private, secret mounted.
- [ ] NER sidecar deployed, private, 2Gi memory.
- [ ] Backend→NER service-to-service auth working.
- [ ] `/healthz` returns ok on both.

> Next: `08_SETUP_ASR.md` — enable and call medical speech-to-text.
