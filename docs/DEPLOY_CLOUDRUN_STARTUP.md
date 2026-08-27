# Notera — Ground‑Up Startup Deployment (Cloud Run + Cloud SQL + Vercel)

A step‑by‑step, from‑zero guide to ship **only the clinical pipeline** (not the dev/admin testing lab) as a lean, scale‑to‑zero service on Google Cloud, with the frontend on Vercel. Optimised for a startup with few early users and near‑$0 idle cost, with a clear path to scale.

**What we deploy:** the clinician API (`POST /api/consults` → the note pipeline) + database, on Cloud Run's free tier, fronted by your Vercel frontend.
**What we exclude:** the entire admin/Testing‑Lab (`/api/runs`, `/api/results`, `/api/metrics`, `/api/prompts`, `/api/patients`, `/api/lab`, `/api/judge`, `/api/config`, `/api/session`, `/api/scripts`). Those are developer tools and stay out of production entirely (Step 3).

---

## 0. The PHI de‑identification firewall — is it a good idea? (Yes. You already have it.)

**Short answer: it's a legitimate, well‑established pattern — "PHI minimization by tokenization" — and Notera already does it.** In `packages/backend/src/orchestrator/generateNote.js` the flow is:

```
raw transcript
   │  NER finds PERSON/NAME spans  ──▶ nameHints
   ▼
deidentify(transcript, {mode:'redact', nameHints})  ──▶  { safeTranscript, deidMap }
   ▼
ENTIRE pipeline (Gemini/Vertex, Speech, all agents) runs on safeTranscript   ← Google sees ONLY redacted text
   ▼
reidentify(note, deidMap)   ← real names restored LOCALLY into the final note
```

The `deidMap` (the only thing that can re‑identify) **never leaves your server**. This is the correct architecture and you should keep it as a hard gate.

**What it buys you** — only de‑identified text crosses the network to Google; the re‑identification key stays inside your trust boundary; you shrink your PHI exposure surface dramatically.

**The honest caveats** (so you don't over‑trust it):
1. **De‑identification of free‑text is never perfect.** HIPAA Safe Harbor requires removing **18 identifier types** (names, dates finer than year, geographic detail smaller than state, MRNs, phone/email, employer, relatives, rare conditions, etc.). Clinical dialogue leaks these in ways a name‑only redactor misses. Residual identifiers = **still PHI legally**.
2. **Therefore de‑id is defense‑in‑depth, not a licence to skip a BAA.** For real patients you should still sign the **Google Cloud BAA** and use **Vertex AI** (Step 8). De‑id + BAA together is the belt‑and‑suspenders posture; de‑id *alone* to avoid a BAA is risky unless you do formal Expert Determination.
3. **Over‑redaction hurts note quality** (you saw this with date normalization) — tune it, don't max it.

**How to make it robust (recommended upgrades to your existing `deid/deidentify.js`):**
- Add **Microsoft Presidio** (open‑source, `presidio-analyzer` + `presidio-anonymizer`, spaCy‑based) as a second pass, or a clinical NER model (`medspaCy`/`scispaCy`), running **locally** in your NER sidecar. Presidio ships recognizers for the HIPAA‑18 identifier classes.
- Keep deterministic regex fallbacks for phones, emails, MRNs, dates, postal codes — belt over the ML.
- **Enforce a hard invariant:** *nothing* reaches a Google/third‑party call unless it passed through `deidentify()`. Add a startup assertion + an audit log entry per call (you already log `transcript.deidentified` with a map fingerprint — extend it so any raw‑text egress throws).
- Never send raw text to **DeepSeek** (Second Opinion) in production — it has no BAA. Keep it disabled (`DEEPSEEK_API_KEY` unset).

> Google also offers **Cloud DLP / Sensitive Data Protection** for de‑id, but it *sends the data to Google* (BAA‑covered) — so it doesn't keep data off Google's servers. Your **local** Presidio pass is better if the goal is "nothing identifiable ever leaves our infrastructure."

**Bottom line:** keep the redact→process→re‑identify flow (you have it), strengthen the NER, enforce it as a gate, and still use Vertex + BAA. That's the industry‑standard startup posture.

---

## 1. Accounts & tools (once)

1. Create a **Google Cloud project** dedicated to Notera; enable **billing**.
2. **Sign the Google Cloud BAA** (Console → search "Business Associate Agreement") before any real PHI.
3. Install the **gcloud CLI** and Docker locally; `gcloud init`; `gcloud auth login`.
4. Have a **domain** (e.g. `notera.health`) — you'll use `app.` for Vercel and `api.` for Cloud Run.

```bash
export PROJECT_ID="notera-prod"
export REGION="us-central1"        # a HIPAA-eligible region in your jurisdiction
gcloud config set project "$PROJECT_ID"
```

## 2. Enable the APIs you need

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com \
  speech.googleapis.com \
  cloudbuild.googleapis.com
```

## 3. Separate the admin panel OUT of production (env‑gated)

Your `server.js` currently dispatches admin prefixes to `adminHandler` for everyone. Gate that behind a flag so production never mounts it. Edit `packages/backend/server.js`:

```js
// ── Admin / Testing-Lab API — DEV ONLY. Not mounted in production. ──
const ADMIN_ENABLED = process.env.ENABLE_ADMIN === '1';
if (ADMIN_ENABLED) {
  app.use((req, res, next) => {
    if (ADMIN_PREFIXES.some((pre) => req.path === pre || req.path.startsWith(pre + '/'))) {
      return adminHandler(req, res, next);
    }
    next();
  });
} else {
  // Hard 404 for any admin path in prod (never expose the lab surface).
  app.use((req, res, next) => {
    if (ADMIN_PREFIXES.some((pre) => req.path === pre || req.path.startsWith(pre + '/')))
      return res.status(404).json({ error: 'not found' });
    next();
  });
}
```

You set `ENABLE_ADMIN=1` only on your **local/dev** machine. Cloud Run never gets it → the whole Testing‑Lab surface is absent from production. Optionally, `import { adminHandler }` behind a dynamic `if (ADMIN_ENABLED) await import(...)` so the admin code isn't even bundled.

**Critical security fix in the same file.** The current clinician auth middleware has a dev shortcut that **bypasses auth in production**:

```js
if (config.nodeEnv === 'production') return next();   // ← DELETE THIS LINE
return res.status(401).json({ error: 'unauthorized' });
```

Replace the whole block with the real `requireAuth` from the auth module (Part G of `HOSTING_GCP_SELF_HOSTED.md`) so every `/api/consults*` call needs a valid session. Also **lock CORS** to your Vercel origin instead of `*`:

```js
const ALLOW = process.env.CORS_ORIGIN || 'https://app.notera.health';
res.setHeader('Access-Control-Allow-Origin', ALLOW);
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

## 4. Backend Dockerfile (Cloud Run runs a container)

Create `packages/backend/Dockerfile` (multi‑stage keeps it small). Cloud Run injects `PORT` — make the server listen on it.

```dockerfile
# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json turbo.json ./
COPY packages ./packages
COPY schema ./schema
RUN npm ci --omit=dev --workspace @notera/backend

# ---- run ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/packages/backend
EXPOSE 8080
CMD ["node", "server.js"]
```

In `server.js`, ensure: `const PORT = process.env.PORT || 8080; app.listen(PORT, ...)`.

> The **NER sidecar** (Python) is a second container. On Cloud Run, deploy it as its own service (`notera-ner`) and point `NER_URL` at it — or, for the leanest start, run with `NER_DISABLED=1` (your code already has a circuit breaker + disable flag) and rely on the LLM extractor. Add NER back when you need the recall.

## 5. Database — Cloud SQL for PostgreSQL (cheapest tier)

Cloud Run is stateless, so the DB is a managed Cloud SQL instance (this is the trade‑off for scale‑to‑zero; there is **no truly free managed Postgres** — the smallest shared‑core instance is ~$8–10/mo).

```bash
gcloud sql instances create notera-db \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \                     # cheapest shared-core; upgrade later
  --region="$REGION" \
  --storage-size=10GB --storage-auto-increase \
  --backup --backup-start-time=03:00 \     # automated daily backups
  --require-ssl

gcloud sql databases create notera --instance=notera-db
gcloud sql users create notera_admin --instance=notera-db --password='<STRONG_PW>'

# Note the connection name (PROJECT:REGION:INSTANCE):
gcloud sql instances describe notera-db --format='value(connectionName)'
```

Apply your schemas (Cloud SQL Proxy locally, then run your SQL/migrations):

```bash
# from your machine, with cloud-sql-proxy running:
psql "host=127.0.0.1 dbname=notera user=notera_admin" -f db/schema.lab.sql
psql ... -f db/schema.auth.sql      # the users/auth tables from the hosting guide, Part G
```

> **Truly‑$0 alternative (pilot only):** run backend **and** Postgres on a single **`e2-micro`** VM, which is in GCP's *Always Free* tier (1 per month in `us-central1`/`us-west1`/`us-east1`). It has only 1 GB RAM, so run lean (NER disabled). Good for a synthetic/de‑identified pilot; move to Cloud SQL before real load. This also restores your original "DB on the same instance" wish.

## 6. Secrets — Secret Manager

```bash
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create ADMIN_SESSION_SECRET --data-file=-
printf '%s' '<STRONG_PW>'             | gcloud secrets create DB_PASSWORD --data-file=-
# add SMTP creds etc. the same way
```

## 7. Service account & IAM (least privilege)

```bash
gcloud iam service-accounts create notera-run

for ROLE in roles/cloudsql.client roles/aiplatform.user roles/speech.client \
            roles/secretmanager.secretAccessor roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:notera-run@${PROJECT_ID}.iam.gserviceaccount.com" --role="$ROLE"
done
```

Cloud Run uses this SA's identity automatically (Application Default Credentials) — **no key file needed**, which is more secure than a mounted JSON key.

## 8. Vertex AI Gemini (BAA‑covered LLM)

For real PHI, route Gemini through **Vertex AI**, not the public `generativelanguage.googleapis.com` API key. Your `LLMService`/`proxy.js` currently uses the API‑key endpoint; add a Vertex code path selected by env:

- `GEMINI_PROVIDER=vertex`, `GCP_PROJECT=$PROJECT_ID`, `GCP_LOCATION=$REGION`.
- On Vertex, auth is the SA's ADC (Step 7) — no API key. The model call goes to `…-aiplatform.googleapis.com/v1/projects/$PROJECT/locations/$REGION/publishers/google/models/<model>:generateContent`.
- Pick the model per cost: bulk agents on **`gemini-2.5-flash-lite`**, the final grounding pass on **`gemini-2.5-flash`** (see cost note below).

Because you de‑identify first (Section 0), even this call carries only redacted text — Vertex + BAA is then defense‑in‑depth.

## 9. Deploy the backend to Cloud Run (free‑tier friendly)

Build to Artifact Registry and deploy with **`--min-instances=0`** (scale to zero = $0 when idle):

```bash
gcloud artifacts repositories create notera --repository-format=docker --location="$REGION"

# Build & push (Cloud Build)
gcloud builds submit --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/notera/backend:latest" \
  --config=/dev/stdin <<'EOF'
steps:
- name: gcr.io/cloud-builders/docker
  args: ['build','-f','packages/backend/Dockerfile','-t','${_IMG}','.']
images: ['${_IMG}']
EOF

export CONN=$(gcloud sql instances describe notera-db --format='value(connectionName)')

gcloud run deploy notera-backend \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/notera/backend:latest" \
  --region="$REGION" \
  --service-account="notera-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$CONN" \
  --min-instances=0 --max-instances=3 \
  --cpu=1 --memory=1Gi --concurrency=4 --timeout=300 \
  --no-allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,ENABLE_ADMIN=0,NER_DISABLED=1,GEMINI_PROVIDER=vertex,GCP_PROJECT=${PROJECT_ID},GCP_LOCATION=${REGION},CORS_ORIGIN=https://app.notera.health,DATABASE_URL=postgres://notera_admin@/notera?host=/cloudsql/${CONN}" \
  --set-secrets="ADMIN_SESSION_SECRET=ADMIN_SESSION_SECRET:latest,DB_PASSWORD=DB_PASSWORD:latest"
```

Key flags:
- **`--min-instances=0`** → true scale‑to‑zero, $0 idle (accept ~1–3 s cold start).
- **`--timeout=300`** → note generation takes 10–25 s; give headroom.
- **`--concurrency=4`** → each container handles a few notes at once (the pipeline is I/O‑bound on the LLM).
- **`--no-allow-unauthenticated`** is optional; since you gate with your own session cookie, you can allow unauthenticated at the Cloud Run layer and rely on `requireAuth`. If you keep it locked, put the Vercel rewrite behind an ID‑token — simpler to allow‑unauth + your app auth.
- The `DATABASE_URL` uses the **Cloud SQL unix socket** `/cloudsql/CONN` — that's how Cloud Run reaches Cloud SQL privately, no public IP.

Map the custom domain: `gcloud run domain-mappings create --service=notera-backend --domain=api.notera.health --region=$REGION`, then add the shown DNS record.

## 10. Frontend on Vercel (proxy to Cloud Run — no CORS/cookie pain)

1. Import the repo in Vercel; **Root Directory = `apps/web`**.
2. Make the rewrite target an env var in `apps/web/next.config.js`:
   ```js
   async rewrites() {
     return [{ source: '/backend/:path*', destination: `${process.env.BACKEND_URL}/:path*` }];
   }
   ```
3. Vercel env var: `BACKEND_URL=https://api.notera.health`.
4. Custom domain `app.notera.health`.

The browser only ever calls `app.notera.health`; Vercel proxies `/backend/*` to Cloud Run server‑side. Your host‑only `SameSite=Lax` session cookie stays first‑party → **auth works unchanged, no CORS.** (One caveat: long multi‑minute jobs can exceed Vercel's proxy timeout — but your production surface is single‑note generation at 10–25 s, well within limits.)

## 11. Cost at startup scale (100 notes/day)

| Component | Monthly |
|---|---|
| Cloud Run (min‑instances 0, ~3,000 notes/mo) | **~$0** — within free tier (180K vCPU‑s / 360K GiB‑s / 2M requests) |
| Cloud SQL `db-f1-micro` (always on) | ~$8–10 |
| Vertex Gemini (Flash‑Lite bulk / Flash final) | ~$30–70 |
| Vercel (Hobby/Pro) | $0–20 |
| Speech‑to‑Text | $0 if text transcripts; usage‑based if audio |
| **Total** | **~$40–100 / month** |

Cloud Run itself is effectively free at this volume — your only guaranteed costs are the tiny DB and the LLM usage. Scale `--max-instances` and DB tier up as users grow; nothing about the architecture changes.

## 12. Scale‑up path (later, no rewrite)

- More users → raise Cloud Run `--max-instances` and `--concurrency`; bump Cloud SQL tier (`db-custom-…`) and enable HA.
- Add the NER service back (`NER_DISABLED=0`, deploy `notera-ner` on Cloud Run).
- Add Cloud Armor (WAF) + a load balancer if you outgrow the Vercel proxy.
- Add read replicas / connection pooling (PgBouncer) when DB connections climb.

## 13. Go‑live checklist

- [ ] BAA signed; Vertex (not API‑key Gemini) for the LLM; DeepSeek disabled.
- [ ] **De‑id gate enforced** — assertion that nothing un‑redacted reaches Google; NER strengthened (Presidio/medical NER); re‑identify only local.
- [ ] `ENABLE_ADMIN` unset in prod → Testing‑Lab absent; admin paths 404.
- [ ] **Production auth bypass removed**; `requireAuth` on every `/api/consults*`; CORS locked to `app.notera.health`.
- [ ] Cloud SQL `--require-ssl`, automated backups on, private (unix socket) connection only.
- [ ] Secrets in Secret Manager; SA is least‑privilege; no JSON keys mounted.
- [ ] Cloud Run `--min-instances=0`, `--timeout=300`; custom domains mapped; `/healthz` green.
- [ ] Vercel rewrite → `api.notera.health`; login → generate → view note tested end‑to‑end.
- [ ] Audit logging on (app `auth.audit_log` + Cloud Audit Logs); a restore drill completed.
