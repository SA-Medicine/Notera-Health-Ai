# Setup — Notera-Health-Ai

Gemini via **AI Studio only** (Vertex is off; flip it later by changing one env var).
Follow top-to-bottom. Steps marked **[dev]** get you running locally in minutes;
**[prod]** are for real Firebase + Cloud Run.

---

## 0. What you need to obtain

| Item | Where to get it | Needed for |
|------|-----------------|------------|
| **Gemini AI Studio API key** | https://aistudio.google.com/apikey | Note generation (already copied into `.env`) |
| **Firebase project** | https://console.firebase.google.com | Real data storage (`[prod]`, or real-data `[dev]`) |
| **Service-account JSON** | Firebase console → Project settings → Service accounts → Generate key | Firestore access from your laptop |

Your `.env` already exists at the repo root with your old Gemini key filled in.
Open it and check the two `✏️` lines if you want real Firebase; otherwise the
defaults run against an in-memory store.

---

## 1. [dev] Run locally with the in-memory store (fastest)

No Firebase needed — `FIRESTORE_DRIVER=memory` is the default.

```bash
cd Notera-Health-Ai
npm install                 # installs workspace deps (schema/backend/eval)

# Terminal A — backend (reads .env automatically)
npm run start:backend       # → http://localhost:8080  ("listening on :8080")

# Terminal B — frontend
cd web && npm install && npm run dev    # → http://localhost:3000
```

Open http://localhost:3000 → **Load sample** → **Generate draft note**.
That exercises: Gemini generation → schema structuring → guardrails → review → sign-off.

> Optional: the medical NER sidecar. It's not required (the app degrades gracefully),
> but to enable the medication cross-check:
> ```bash
> cd ner && python -m venv .venv && source .venv/bin/activate
> pip install -r requirements.txt        # + the two model wheels in requirements.txt
> uvicorn main:app --port 8000
> ```

---

## 2. Initialize Firebase (real data)

### 2a. Create the project & database
1. Go to https://console.firebase.google.com → **Add project** (or pick an existing one).
2. In the project, open **Build → Firestore Database → Create database** → **Native mode** → choose a region (keep it consistent for data residency).
3. Copy your **Project ID** (Project settings → General).

### 2b. Point this repo at it
Edit `.firebaserc` and replace `your-firebase-project-id` with your Project ID.
Then in `.env` set:
```
FIRESTORE_DRIVER=firestore
GCP_PROJECT=your-firebase-project-id
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
```

### 2c. Get a service-account key (for local access)
Firebase console → **Project settings → Service accounts → Generate new private key**.
Save the downloaded JSON as `Notera-Health-Ai/service-account.json`
(it's already git-ignored — never commit it).

### 2d. Install the Firebase CLI & deploy the security rules
```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,firestore:indexes
```
This pushes `deploy/firestore.rules` (PHI collections are backend-only) and
`deploy/firestore.indexes.json`.

### 2e. Run against real Firebase
Restart the backend (`npm run start:backend`). It will now read/write your Firestore.
Watch the Firestore console populate as you generate and approve notes:
`consults/`, `deidMaps/`, `auditLog/`.

---

## 3. [prod] Deploy everything to Cloud Run

Everything stays on Google. One script builds and deploys web + backend + NER,
wires IAM, and stores your Gemini key in Secret Manager:

```bash
PROJECT_ID=your-firebase-project-id \
GEMINI_API_KEY=your_ai_studio_key \
REGION=us-central1 \
deploy/deploy-all.sh
```

Then apply the Firestore rules (step 2d) and open the printed web URL.

---

## 4. Verify

```bash
npm test                       # backend smoke + eval metric tests
curl localhost:8080/healthz    # {"ok":true,...}
node data/build_dataset.mjs    # builds the schema dataset + tuning files from data/gold
node eval/run_eval.mjs --limit 2   # end-to-end scorecard (uses your Gemini key)
```

---

## Switching to Vertex later (when you're ready)

You said Gemini/AI-Studio for now. When you want the HIPAA-eligible path, no code
changes are needed — set in `.env`:
```
LLM_BACKEND=vertex
GCP_PROJECT=your-project
VERTEX_LOCATION=us-central1
```
and remove `GEMINI_API_KEY` (Vertex uses your Google credentials). Same models,
same prompts; de-identification for the LLM hop becomes optional under the BAA.

---

## Troubleshooting

- **"GEMINI_API_KEY is missing"** — check the key line in `.env`; the backend loads it on start.
- **Generation errors / model-not-found** — set `GEMINI_MODEL_PRO`/`GEMINI_MODEL_FLASH` in `.env` to a model your key can access (list at https://ai.google.dev/gemini-api/docs/models).
- **Firestore permission denied from the browser** — expected: the browser never touches Firestore directly; all PHI goes through the private backend (doc `09 §4`).
- **NER returns no entities** — the sidecar is off or the model wheels aren't installed; the app still works, only the medication cross-check is skipped.
