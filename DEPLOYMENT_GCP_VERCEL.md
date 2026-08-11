# Notera‑Health‑AI — Production Deployment Architecture: Google Cloud + Vercel

**Document type:** Cloud deployment & migration reference (industry‑level)
**Scope:** Everything — frontend, backend, database, ML sidecars, LLM, secrets, networking, compliance, CI/CD, cost
**Audience:** The engineer(s) taking Notera from a local Turborepo dev setup to a production HIPAA‑aware deployment
**Target topology:** Frontend on **Vercel**, everything else on **Google Cloud Platform (GCP)**
**Last updated:** August 2026

> **How to read this doc.** Sections 1–3 tell you *what you have today* and *the one rule that governs everything* (PHI/HIPAA). Section 4 is the target picture. Section 5 is the component‑by‑component plan — this is the core. Section 6 is the blunt "as‑is vs must‑change" table. Sections 7–12 are compliance, CI/CD, cost, the runbook, risks, and copy‑paste appendices. If you only read two things, read **Section 6** (what changes) and **Section 10** (the runbook).

---

## Table of contents

1. Executive summary
2. Current‑state architecture (grounded in the actual repo)
3. The governing constraint: PHI and HIPAA
4. Target architecture (Vercel + GCP)
5. Component‑by‑component deployment plan
   - 5.1 Frontend — Next.js on Vercel
   - 5.2 Backend API — Express on Cloud Run
   - 5.3 Relational database — Cloud SQL for PostgreSQL
   - 5.4 Document store — Firestore
   - 5.5 LLM generation — Vertex AI Gemini (the big compliance change)
   - 5.6 Medical NER sidecar — Cloud Run (private)
   - 5.7 Speech‑to‑Text (ASR)
   - 5.8 RxNorm / RxNav — external API & egress
   - 5.9 Eval + System Upgrader — Cloud Run Jobs + GCS
   - 5.10 Secrets & configuration
   - 5.11 Networking & service‑to‑service auth
   - 5.12 The filesystem problem (must‑fix before Cloud Run)
6. What can deploy as‑is vs what must change
7. Security & compliance checklist
8. CI/CD and Infrastructure as Code
9. Cost model (order‑of‑magnitude)
10. Migration runbook (phased)
11. Risks & open decisions
12. Appendices (Dockerfiles, vercel.json, env mapping, Terraform, cloudbuild)

---

## 1. Executive summary

Notera is a **Turborepo monorepo** with a Next.js 15 frontend (`apps/web`), an API‑only Express backend (`packages/backend`), a shared design system (`packages/ui`), a shared note schema (`schema/`), a Python medical‑NER sidecar (`ner/`), and an offline eval/upgrader harness (`eval/`). Data lives in **two stores**: Firestore for the clinician "consult" product, and **PostgreSQL** for the Testing Lab + System Upgrader. Note generation calls **Gemini**, currently through **Google AI Studio** (not BAA‑covered).

The good news: the codebase was clearly built *anticipating* GCP. It already has a Firestore driver, a Vertex code path, a Cloud Run NER Dockerfile, `@google-cloud/*` clients, a Secret‑Manager‑shaped config, and an (older, pre‑monorepo) all‑Cloud‑Run deploy script. Roughly **70% of the design is deployment‑ready**; the remaining **30% is real work**, and most of it clusters into four themes:

1. **Compliance switch (highest priority):** for any real patient data, generation must move from **AI Studio → Vertex AI Gemini** under a Google **BAA**. AI Studio is explicitly *not* HIPAA‑covered. This is a config + IAM change, not a rewrite, but it is non‑negotiable.
2. **Stateful filesystem → managed storage:** the backend writes prompts, run history, and results to local disk. Cloud Run's disk is **ephemeral and per‑instance**, so these must move to **Cloud SQL / GCS** (or the service must be pinned to a single instance) before horizontal scaling is safe.
3. **Database:** local Docker Postgres → **Cloud SQL for PostgreSQL** (private IP, CMEK, automated backups), reached from Cloud Run over the Cloud SQL connector.
4. **Frontend split:** move `apps/web` to **Vercel**, repoint its `/backend/*` rewrite at the Cloud Run backend URL, and decide the **Vercel BAA** question based on whether the browser/BFF ever touches PHI.

Two latent issues surfaced during the codebase review and are called out where relevant: a **production auth‑bypass** in `server.js` (§5.11), and the **local‑filesystem writes** (§5.12). Both must be resolved before go‑live.

A pragmatic **hybrid** is the recommended end state: Vercel for the web tier (best‑in‑class Next.js DX, global edge, preview deployments) and GCP for the API + data + ML tier (so PHI, the database, and the LLM all sit inside one BAA‑covered boundary).

---

## 2. Current‑state architecture (grounded in the actual repo)

### 2.1 Monorepo layout

```
notera/  (Turborepo, npm workspaces, Node >= 20)
├── apps/web/                 Next.js 15.5 + React 19 (App Router)  — port 3000
├── packages/
│   ├── backend/              Express 4 API (ESM)                   — port 8080
│   ├── ui/                   shared shadcn/Tailwind design system (@notera/ui)
│   └── config/               shared config
├── schema/                   note JSON schema + ajv validation (@notera/schema)
├── eval/                     offline eval harness (run_eval.mjs) + results/
├── ner/                      Python FastAPI medical‑NER sidecar (Dockerfile present)
├── db/                       Postgres schema.sql + docker-compose + migrations
├── deploy/                   older all‑GCP Cloud Run scripts (partly stale — see §2.6)
└── scripts/                  data reduction utilities
```

### 2.2 Frontend — `apps/web`

- **Next.js 15.5, React 19**, App Router, TypeScript, Tailwind 3, shadcn UI via `@notera/ui` (compiled from source through `transpilePackages`).
- Serves **both** audiences: the clinician "consult" product and the internal Testing‑Lab admin dashboard (Run, Patients, Results, Metrics, Prompts, Upgrader, Gates & Judge, System Ideas).
- **Talks to the backend two ways:** (a) a Next server‑side BFF under `/api/*` for the clinician flow, and (b) a rewrite in `next.config.js`:
  ```js
  rewrites: [{ source: '/backend/:path*', destination: `${BACKEND_URL}/:path*` }]
  ```
  so the admin client calls `/backend/api/*` same‑origin and Next proxies to Express. **This rewrite is the single integration seam** between web and backend, and it is the thing you re‑point when the backend moves to Cloud Run.
- Local dev on port 3000.

### 2.3 Backend — `packages/backend`

- **Express 4, ESM, Node ≥ 20, API‑only** (it explicitly does *not* serve UI). Listens on `config.port = process.env.PORT || 8080` — already Cloud‑Run‑compatible (Cloud Run injects `PORT`).
- Two route families in one service:
  - **Product API:** `/api/consults`, pipeline, approve, `/api/llm`, `/api/asr` (clinician).
  - **Admin / Testing‑Lab API** (dispatched *before* `express.json` so it owns the raw stream for SSE + large imports): `/api/runs`, `/api/results`, `/api/metrics`, `/api/prompts`, `/api/patients`, `/api/lab/*`, `/api/sessions`, `/api/judge`, `/api/run-patients`, `/api/config`, `/api/login|logout|session`, `/api/scripts`.
- **Dependencies:** `express`, `pg` (Postgres), `@google-cloud/firestore`, `@google-cloud/speech`, `google-auth-library`, `ajv`, `@notera/schema`.
- Reads `.env` **once at startup** (`src/loadEnv.js`) — so any config change requires a redeploy/restart, which is exactly the Cloud Run model.

### 2.4 Data layer — dual store

- **Firestore store** (`src/firestore/store.js`): system of record for the clinician product — consults, drafts/finals/feedback, an append‑only `auditLog`, a `models` registry, and the **`deidMap`** (identifier ↔ token map — the most sensitive object in the system, stored in a tighter collection). Pluggable driver: `FIRESTORE_DRIVER=memory` (dev) or `firestore` (prod).
- **PostgreSQL** (`src/db/pgStore.js`, `labStore.js`, `pool.js`): the Testing Lab + System Upgrader — patients, runs, run_patients, per‑agent I/O, metrics, upgrade_runs, suggestions. Schema in `db/schema.lab.sql` + `db/schema.upgrader.sql`. Uses **pgcrypto** for the de‑id map (`DEID_ENC_KEY`). Local dev runs **PostgreSQL 18 in Docker** (`db/docker-compose.postgres.yml`) with a nightly `pg_dump -Fc` backup sidecar (7‑day retention).
- Selected by env: `STORE_BACKEND=postgres|firestore|memory`, `DATABASE_URL=postgres://…`.

### 2.5 AI / ML services

- **LLM generation (Gemini):** `LLM_BACKEND=ai_studio` (Google AI Studio, de‑identified input only, **not** BAA) **or** `vertex` (Vertex AI, HIPAA‑eligible under BAA). Model config: `GEMINI_MODEL=gemini-3.5-flash`, `GEMINI_MAX_OUTPUT_TOKENS=65536`, `GEMINI_THINKING_LEVEL=off`. Implemented in `src/services/LLMService.js` + `src/proxy.js`.
- **Medical NER sidecar** (`ner/`): Python 3.11 FastAPI (uvicorn), scispaCy `en_ner_bc5cdr_md` + `en_core_med7_lg`. **Dockerfile already present**, designed for Cloud Run at `--memory=2Gi`. Reached via `NER_URL`, `NER_USE_IAM`.
- **Speech‑to‑Text (ASR):** `@google-cloud/speech`, `ASR_MODEL=medical_conversation`. GCP‑native already.
- **RxNorm / RxNav:** `src/services/rxnorm.js` calls the **public NLM RxNav REST API** (keyless, ~20 req/s/IP), with a persistent on‑disk cache (`.cache/rxnorm.json`). `RXNORM_VERIFY=1`.

### 2.6 Existing deploy assets (and what's stale)

- `deploy/deploy-all.sh` — an **all‑GCP Cloud Run** deploy (web + backend + NER private, Firestore, Speech, Secret Manager, Vertex APIs). **Partly stale:** it references top‑level `web/` and `backend/Dockerfile` build contexts that no longer exist after the monorepo refactor (code now lives in `apps/web` and `packages/backend`, and **no backend/web Dockerfile exists yet**). Treat it as a design reference, not a working script.
- `deploy/cloudbuild.backend.yaml` — same staleness (`-f backend/Dockerfile`).
- `deploy/firestore.rules`, `deploy/firestore.indexes.json`, `firebase.json`, `.firebaserc` — Firestore security config, reusable.
- **Notably absent:** any Cloud SQL provisioning, any handling of the backend's local‑filesystem writes, and any Vercel config. Those are the gaps this document fills.

---

## 3. The governing constraint: PHI and HIPAA

Notera processes **clinical consultation transcripts and generates SOAP notes** — this is **Protected Health Information (PHI)** the moment real patients are involved. Every architecture decision below is downstream of one rule:

> **Every service that stores, processes, or transmits PHI must be a HIPAA‑eligible service covered by a signed Business Associate Agreement (BAA) — and PHI must never touch a surface the BAA doesn't cover.**

### 3.1 The BAA coverage matrix

| Surface | HIPAA‑eligible / BAA? | Verdict for Notera |
|---|---|---|
| **GCP Cloud Run** | Yes (in Google Cloud BAA) | ✅ Backend + NER here |
| **GCP Cloud SQL (PostgreSQL)** | Yes | ✅ Relational DB here |
| **GCP Firestore** | Yes | ✅ Consult store here |
| **GCP Vertex AI (Gemini)** | **Yes** (BAA‑covered surface for Gemini) | ✅ **Use this for generation** |
| **Google AI Studio (`ai_studio`)** | **No** — not BAA‑covered | ❌ **De‑identified / non‑PHI only** |
| **GCP Secret Manager, Cloud KMS, Speech‑to‑Text, Cloud Logging/Monitoring, GCS** | Yes | ✅ |
| **NLM RxNav public API** | 3rd‑party US‑gov API, no BAA | ⚠️ Send **drug strings only**, never identifiers (see §5.8) |
| **Vercel** | **Yes, via BAA** (self‑serve on Pro ~US$350/mo, or Enterprise) | ⚠️ Required **only if** the browser/BFF handles PHI (see §5.1) |

Sources for this section are listed at the end of the document.

### 3.2 The three practical implications

1. **Switch generation to Vertex.** `LLM_BACKEND=vertex`, `GCP_PROJECT`, `VERTEX_LOCATION` (pin to `us-central1` or an EU region for residency), backend service account granted `roles/aiplatform.user`. This alone is the difference between "compliant" and "not."
2. **Keep de‑identification in the loop.** The pipeline already has a `deidMode` and a `deidMap`. Even on Vertex, de‑identifying before the LLM call is defense‑in‑depth and is *mandatory* if you ever fall back to AI Studio or call RxNav.
3. **Draw the PHI boundary and keep Vercel outside it if you can.** The cleanest design keeps *all* PHI inside GCP (backend + DB + LLM) and lets Vercel serve only UI + de‑identified admin data. If the clinician product renders real patient data in the browser or processes it in a Next BFF route, then Vercel is in‑scope and needs its own BAA. **This is the key architectural decision — see §5.1 and §11.**

---

## 4. Target architecture (Vercel + GCP)

```
                         ┌────────────────────────────────────────────────────────┐
   Clinician / Admin     │                      VERCEL                             │
   browser  ───────────► │  Next.js 15 (apps/web)  · global edge · previews        │
                         │   • static + RSC + client                                │
                         │   • /api/*  BFF (clinician)                               │
                         │   • rewrite /backend/* ─────────────┐                    │
                         └─────────────────────────────────────┼────────────────────┘
                                                               │ HTTPS + ID token / bearer
                                                               ▼
   ┌───────────────────────────────── GOOGLE CLOUD (one project, one region) ─────────────────────────────────┐
   │                                                                                                            │
   │   ┌────────────────────────┐        ┌──────────────────────┐        ┌───────────────────────────────┐     │
   │   │  Cloud Run: backend    │──IAM──►│  Cloud Run: NER       │        │  Vertex AI  (Gemini, BAA)     │     │
   │   │  Express API (:8080)   │        │  FastAPI scispaCy 2Gi │        │  note generation              │     │
   │   │  (private ingress)     │◄──────►└──────────────────────┘        └───────────────────────────────┘     │
   │   │                        │──────────────► Speech‑to‑Text (ASR, medical_conversation)                    │
   │   │        │      │        │──────────────► NLM RxNav (egress via Cloud NAT, drug strings only)            │
   │   │        │      │        │                                                                               │
   │   │   Cloud SQL   Firestore│        ┌──────────────────────┐   ┌──────────────────┐  ┌────────────────┐   │
   │   │   connector   (Native) │        │  Cloud SQL: Postgres │   │  Secret Manager  │  │  Cloud Storage │   │
   │   │        ▼               ▼        │  private IP + CMEK    │   │  keys, DB creds  │  │  results/logs/ │   │
   │   │  ┌──────────────┐  ┌─────────┐  │  auto backups + PITR  │   │                  │  │  prompt store  │   │
   │   │  │ Testing Lab, │  │ consults│  └──────────────────────┘   └──────────────────┘  └────────────────┘   │
   │   │  │ upgrader,    │  │ audit,  │                                                                          │
   │   │  │ metrics      │  │ deidMap │        ┌──────────────────────┐                                         │
   │   │  └──────────────┘  └─────────┘        │ Cloud Run Jobs:      │  eval harness + System Upgrader        │
   │   │                                       │ batch eval / upgrade │  (long‑running, not request‑bound)     │
   │   │                                       └──────────────────────┘                                         │
   │                                                                                                            │
   │   Cross‑cutting: Cloud Logging + Monitoring · Cloud KMS · Cloud Armor · VPC + Serverless VPC/Direct egress │
   └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why hybrid rather than all‑GCP web too?** Vercel gives you zero‑config Next.js builds, global edge caching, instant preview deployments per PR, and the best React 19/Next 15 support. GCP gives you a single BAA‑covered boundary for PHI, the database, and the model. You get the best of both **provided** the PHI boundary is drawn correctly (§3.3, §5.1). If your compliance posture requires *one throat to choke* and a single BAA, the fallback is **all‑GCP** (web on Cloud Run too) using the existing `deploy/` script as a starting point — documented as Option B in §5.1.

---

## 5. Component‑by‑component deployment plan

Each subsection follows the same shape: **what it is → deploy as‑is or change → how → gotchas.**

### 5.1 Frontend — Next.js on Vercel

**Deploys mostly as‑is.** Next.js 15 + React 19 + Turborepo is Vercel's home turf.

**How:**
1. Connect the GitHub repo to Vercel; set **Root Directory = `apps/web`**. Vercel auto‑detects Turborepo, wires the workspace build, and enables remote caching.
2. Because `@notera/ui` and `@notera/schema` are workspace packages compiled via `transpilePackages`, no prebuild step is needed — but ensure the Vercel install command runs at the **repo root** so workspaces resolve (`npm install` at root; Vercel's monorepo detection handles this).
3. Repoint the backend seam. Two equivalent options:
   - Keep the `next.config.js` rewrite and set the Vercel env var `BACKEND_URL=https://scribe-backend-xxxx.a.run.app`, **or**
   - Add a `vercel.json` with a `rewrites` entry (see Appendix 12.2). Prefer the env‑var‑driven `next.config.js` rewrite you already have so dev and prod share one code path.
4. Set env vars in Vercel (Production + Preview): `BACKEND_URL`, `BACKEND_SERVICE_TOKEN` (server‑side only), and any `NEXT_PUBLIC_*` you introduce. **Never** put GCP service‑account JSON or `GEMINI_API_KEY` in Vercel — those stay in GCP.

**The PHI decision (read this):**
- **Option A — Vercel outside the PHI boundary (recommended if feasible).** Treat the web tier as a "dumb" transport: the browser calls the Cloud Run backend for anything involving PHI, and the Next `/api/*` BFF either doesn't exist for PHI paths or only forwards opaque tokens. If no PHI is stored/processed on Vercel infrastructure, a Vercel BAA is not strictly required — but confirm with counsel, because *transmission* through Vercel's edge can still count depending on interpretation.
- **Option B — Vercel inside the boundary.** If the clinician UI renders real patient data or the BFF processes it, sign the **Vercel BAA** (self‑serve on Pro, ~US$350/mo as of 2026; Enterprise adds Secure Compute / dedicated IPs / VPC peering). Then Vercel is a compliant surface.
- **Option C — All‑GCP.** Put `apps/web` on **Cloud Run** too (needs a web Dockerfile, Appendix 12.1). One BAA, one boundary, at the cost of Vercel's DX. Use the existing `deploy/deploy-all.sh` as the skeleton (after de‑staling it for the monorepo).

**Gotchas:**
- Vercel serverless functions are **stateless** — fine here, the web tier holds no state.
- If admin dashboards stream logs via SSE from `/backend/*`, verify Vercel's rewrite passes through streaming responses (it does for external rewrites, since it's a transparent proxy, but test it).
- Long backend operations (a 7k‑patient run) must **not** go through a Vercel function with a short timeout — those calls should hit Cloud Run directly or be async/polled (they already are in the admin client).

### 5.2 Backend API — Express on Cloud Run

**Deploys with one new file (Dockerfile) + config changes.** The code is already API‑only and honors `$PORT`.

**How:**
1. **Write a backend Dockerfile** (none exists today). Multi‑stage, monorepo‑aware: it must copy `schema/`, `packages/config`, and `packages/backend`, install workspaces, and `CMD ["node","server.js"]`. See Appendix 12.1.
2. Build via **Cloud Build → Artifact Registry** from the **repo root** context (so `schema/` is in scope). Update `deploy/cloudbuild.backend.yaml` to point at the new `packages/backend/Dockerfile` (the current path is stale).
3. Deploy to Cloud Run:
   - `--no-allow-unauthenticated` (private; callers use ID tokens — see §5.11) **or** public ingress + app‑level auth + Cloud Armor (simpler for a Vercel caller — see §5.11 trade‑off).
   - `--memory=1Gi --cpu=1 --concurrency=40 --min-instances=0 --max-instances=10` as a starting point (tune per load; concurrency up to 1000 is supported).
   - Attach the **Cloud SQL connector** (`--add-cloudsql-instances PROJECT:REGION:INSTANCE`) and a **Serverless VPC connector / Direct VPC egress** if Cloud SQL uses private IP.
   - `--set-secrets` for `GEMINI_API_KEY`, `DATABASE_URL` (or DB password), `DEID_ENC_KEY`, `SERVICE_TOKENS`.
   - `--set-env-vars` for `NODE_ENV=production, LLM_BACKEND=vertex, GCP_PROJECT=…, VERTEX_LOCATION=us-central1, FIRESTORE_DRIVER=firestore, STORE_BACKEND=postgres, NER_URL=…, NER_USE_IAM=true, REQUIRE_AUTH=true, RXNORM_VERIFY=1`.
4. Grant the backend service account: `roles/cloudsql.client`, `roles/datastore.user` (Firestore), `roles/aiplatform.user` (Vertex), `roles/speech.client`, `roles/run.invoker` on the NER service, `roles/secretmanager.secretAccessor`.

**Gotchas (must‑fix):**
- **Local filesystem writes** (prompt store, run history, results) break on Cloud Run — this is the single biggest backend change. See **§5.12**; do not deploy at `max-instances > 1` until it's resolved.
- **Production auth bypass:** in `server.js`, the auth middleware currently returns `next()` unconditionally when `NODE_ENV==='production'` (it trusts that the service is private). That means **app‑level token auth is effectively off in prod**. If you deploy the backend with public ingress, this is an open door. Either (a) keep the backend **private** and authenticate every caller with Google ID tokens, or (b) fix the middleware to actually enforce tokens/IAP in prod. Flagged again in §5.11 and §7.
- **Cold starts:** `min-instances=0` saves money but adds latency to the first request (Node + model‑client init). For a clinician‑facing path, set `min-instances=1`.
- **Request timeout:** Cloud Run caps a request at 60 minutes. The interactive note‑generation call is fine; **batch** operations are not — route them to Cloud Run Jobs (§5.9).

### 5.3 Relational database — Cloud SQL for PostgreSQL

**Changes from local Docker to managed.** The schema and app code stay; the connection and ops change.

**How:**
1. Create a **Cloud SQL for PostgreSQL 15+** instance (15+ so `pgvector` is available if you later add embeddings; the app itself needs `pgcrypto`, which is standard).
2. Enable **Private IP** (VPC), **CMEK** via Cloud KMS, **automated backups + point‑in‑time recovery**, and a maintenance window. This replaces the docker‑compose `pg-backup` cron sidecar with managed, encrypted backups.
3. Create the `notera` database and `notera_admin` user; store the password in **Secret Manager**; build `DATABASE_URL` from it.
4. **Run migrations** against the instance: `db/schema.lab.sql` + `db/schema.upgrader.sql` (and `db/reset.mjs` / `db/migrate_upgrader.mjs`). Do this as a **one‑off Cloud Run Job** or from a bastion / Cloud SQL Auth Proxy session — not from application startup.
5. Connect from Cloud Run via the **native Cloud SQL integration** (Unix socket at `/cloudsql/PROJECT:REGION:INSTANCE`) or private IP + Serverless VPC connector. `pg` supports both; prefer the socket for simplicity, private IP for strict network isolation.

**Gotchas:**
- The `deploy/deploy-all.sh` script provisions **Firestore only** and sets `FIRESTORE_DRIVER=firestore` — it silently ignores the Testing‑Lab Postgres. You must add Cloud SQL provisioning yourself (Appendix 12.4 Terraform).
- Right‑size: start `db-custom-2-7680` (2 vCPU / 7.5 GB) or a shared‑core tier for low volume; scale up before importing 7k+ patients.
- Connections: Cloud Run can fan out to many instances; set a small `PG_POOL_MAX` (the repo default is 10) and consider **PgBouncer**/Cloud SQL connection limits so you don't exhaust Postgres connections under autoscale.

### 5.4 Document store — Firestore

**Deploys as‑is (driver already exists).**

**How:**
1. Create a **Firestore in Native mode** database in the same region.
2. Set `FIRESTORE_DRIVER=firestore`. The app's async API is identical to the memory driver.
3. Apply `deploy/firestore.rules` + `deploy/firestore.indexes.json` (`firebase deploy --only firestore:rules,firestore:indexes`, or via console).
4. Grant the backend SA `roles/datastore.user`.

**Gotchas:**
- The **`deidMap`** collection is the crown jewels (identifier ↔ token). Lock it down with security rules, and consider a separate stricter IAM condition or even a separate database. Never expose it to the web tier.
- **Decision — do you even need two stores in prod?** You currently run Firestore (product) *and* Postgres (lab). That's fine, but it's two systems to secure, back up, and audit. If the clinician product is not yet live, you can defer Firestore and run everything the lab needs on Postgres. Documented as an open decision in §11.

### 5.5 LLM generation — Vertex AI Gemini (the big compliance change)

**Config change, not a rewrite — but the most important change in this document.**

**How:**
1. Enable `aiplatform.googleapis.com`.
2. Set `LLM_BACKEND=vertex`, `GCP_PROJECT`, `VERTEX_LOCATION` (choose for **data residency** — `us-central1` for US, an EU region for EU; Google lets you confine Gemini processing to US or EU).
3. Confirm the model string is a Vertex‑served Gemini model available in your region; keep `GEMINI_MAX_OUTPUT_TOKENS` and thinking config as tuned. The repo's `LLMService.js`/`proxy.js` already branch on `LLM_BACKEND`.
4. Auth via the Cloud Run **service account** (`roles/aiplatform.user`) — no API key needed on Vertex, which also removes a secret from circulation.
5. **Sign the Google Cloud BAA** and record Notera's entity under Google's HIPAA Implementation Guide. Vertex is only compliant *when covered by your BAA*.

**Gotchas:**
- **AI Studio (`ai_studio`) is not BAA‑covered.** Keep it strictly for local dev on **synthetic/de‑identified** data. Make it impossible to select in prod (assert `LLM_BACKEND==='vertex'` at boot when `NODE_ENV==='production'`).
- Data residency and retention: Vertex under BAA does not train on your data and lets you pin the region — verify the current terms at deploy time.
- Cost & quota differ from AI Studio; request Vertex quota for your model + region before launch.

### 5.6 Medical NER sidecar — Cloud Run (private)

**Deploys as‑is (Dockerfile already exists).**

**How:**
1. `gcloud builds submit ner --tag …/ner`.
2. Deploy **private** (`--no-allow-unauthenticated`), `--memory=2Gi --cpu=2 --concurrency=10 --min-instances=0 --max-instances=5` (models are memory‑hungry; the Dockerfile comments say 2Gi).
3. Grant the **backend** SA `roles/run.invoker` on the NER service; set `NER_URL` + `NER_USE_IAM=true` on the backend so it mints an ID token per call.

**Gotchas:**
- The Dockerfile fetches scispaCy/med7 model wheels at **build** time and "degrades gracefully" if the download fails — verify the models actually loaded in the built image (check startup logs), or bake them in deterministically to avoid a silent quality regression.
- Cold starts are heavier here (loading spaCy models). If NER is on the interactive path, `min-instances=1`.

### 5.7 Speech‑to‑Text (ASR)

**Deploys as‑is — already GCP‑native.**

**How:** enable `speech.googleapis.com`, grant the backend SA `roles/speech.client`, keep `ASR_MODEL=medical_conversation`, `ASR_LANGUAGE`, `ASR_SAMPLE_RATE`. Audio containing PHI should be uploaded to a **CMEK‑encrypted GCS bucket** and referenced by URI, not passed around as base64.

**Gotchas:** the medical ASR models and audio are PHI — Speech‑to‑Text is BAA‑eligible, so this stays inside the boundary; just make sure the **audio at rest** (GCS) is also CMEK‑encrypted and access‑logged.

### 5.8 RxNorm / RxNav — external API & egress

**Deploys as‑is, with a privacy guardrail.**

**How:** no infra needed — it's an outbound HTTPS call to `https://rxnav.nlm.nih.gov/REST`. From Cloud Run, egress goes out via Google's managed networking (add **Cloud NAT** if you route egress through your VPC for a stable IP and to respect RxNav's per‑IP rate limit). The on‑disk `.cache/rxnorm.json` is ephemeral on Cloud Run — fine, it regenerates; for a warm cache across instances, back it with a small GCS object or a Postgres table.

**Gotchas (privacy):**
- RxNav is a **third party with no BAA**. Send **drug name strings only** — never a patient identifier, MRN, or free‑text transcript snippet. The current `rxnorm.js` sends drug strings, which is correct; keep it that way and add a test asserting no PHI fields are included.
- For a fully offline/PHI‑isolated option, **RxNav‑in‑a‑Box** (self‑hosted, needs a UMLS license + ~100 GB) removes the external dependency entirely. You explicitly opted for the public API (no storage), so document that the drug‑string‑only rule is the compensating control.

### 5.9 Eval + System Upgrader — Cloud Run Jobs + GCS

**Changes from "runs on a dev box / long HTTP request" to a proper batch surface.**

The eval harness (`eval/run_eval.mjs`) and the whole‑system Upgrader iterate over **thousands** of patients and make many LLM calls. That is not a web request — it is a batch job.

**How:**
1. Package the eval harness into a **Cloud Run Job** (same backend image, different entrypoint, or a dedicated image). Jobs have no 60‑minute request cap and can run to completion.
2. Write results to **GCS** (and mirror metrics into Cloud SQL as the code already does via `labStore`) instead of the local `eval/results/` directory.
3. Trigger on demand (`gcloud run jobs execute`) or on a schedule (**Cloud Scheduler**). The admin UI's "start upgrade" can enqueue a Job execution instead of holding a request open.

**Gotchas:** the incremental per‑agent upgrade endpoints you built are a good interim fit for Cloud Run's request model, but the *full* corpus run belongs in a Job. Keep the interactive/incremental path in the service; move the bulk path to Jobs.

### 5.10 Secrets & configuration

**Changes from `.env` file to Secret Manager.**

**How:**
- Move everything currently in `.env` that is sensitive into **Secret Manager**: `GEMINI_API_KEY` (dev/AI‑Studio only), `DATABASE_URL`/DB password, `DEID_ENC_KEY`, `SERVICE_TOKENS`, `BACKEND_SERVICE_TOKEN`. Non‑secret config (`LLM_BACKEND`, `VERTEX_LOCATION`, `NER_URL`, model names, flags) stays as Cloud Run **env vars**.
- Reference secrets in Cloud Run with `--set-secrets`. Grant `roles/secretmanager.secretAccessor` to the service accounts.
- `.gitignore` already excludes `.env`, `*-key.json`, `service-account*.json`, `db/backups/`, `data/…` (PHI). Good — keep it that way; never bake secrets into images.

**Gotchas:** rotate `DEID_ENC_KEY` carefully — it decrypts the de‑id map; a naive rotation orphans existing tokens. Plan a re‑encrypt migration if you rotate.

### 5.11 Networking & service‑to‑service auth

This is where the **prod auth‑bypass** matters. Pick one coherent model:

**Model 1 — Private backend + Google ID tokens (most secure).**
- Backend Cloud Run = `--no-allow-unauthenticated`. NER = private. Only authenticated principals invoke them.
- The **web tier calls the backend with a Google‑signed ID token.** From **Cloud Run web** this is trivial (metadata server mints the token). From **Vercel**, you must mint an ID token using a GCP service‑account key stored in Vercel env — workable but it puts a GCP credential on Vercel, which slightly enlarges the trust boundary.
- Backend‑to‑NER already uses this pattern (`NER_USE_IAM=true`).

**Model 2 — Public backend + enforced app auth + Cloud Armor (simplest for Vercel).**
- Backend has public ingress but **enforces** a bearer token (`SERVICE_TOKENS` / `BACKEND_SERVICE_TOKEN`) on every request, fronted by **Cloud Armor** (WAF, rate limiting, IP allowlist for Vercel egress if you use Secure Compute).
- **This requires fixing the `server.js` prod bypass** so the token is actually checked in production. As written, prod trusts the network and skips the check — safe only under Model 1.

**Recommendation:** Model 1 if you can tolerate a GCP SA key on Vercel (or go all‑GCP web, Option C); otherwise Model 2 **with the auth middleware fixed** and Cloud Armor in front. Either way: TLS everywhere (automatic on Cloud Run + Vercel), private IP for Cloud SQL, VPC egress controls, and audit logging on.

### 5.12 The filesystem problem (must‑fix before Cloud Run)

The admin/testing‑lab backend persists real state to the **local filesystem**:
- **Prompt registry** — published prompt versions are written to `packages/backend/prompts/store/*.json` (`fs.writeFileSync`). On Cloud Run this means a publish lands on **one instance's ephemeral disk** and vanishes on the next cold start or lands on a different instance. **Prompt publishes would be lost or inconsistent.**
- **Run history & results** — `eval/results/**`, `_summary.json`, `.compare.json`, `runs.json`, per‑run stdout logs, sessions. Same problem.
- **RxNorm cache** — `.cache/rxnorm.json` (benign; regenerates).

**Fix options (in order of preference):**
1. **Move stateful stores to managed backends.** Prompt registry → a Cloud SQL table (or Firestore collection). Results/metrics → already partly mirrored into Cloud SQL via `labStore`; make Cloud SQL/GCS the source of truth and treat local files as a cache only. Logs → Cloud Logging. This is the correct long‑term fix.
2. **Mount a GCS bucket as a Cloud Run volume** (GCS FUSE) or **Filestore**, so `prompts/store` and `eval/results` are shared and durable across instances. Faster to implement; slower I/O; watch for concurrent‑write races.
3. **Pin the admin backend to a single instance** (`--min-instances=1 --max-instances=1`) with a mounted volume — acceptable for an internal, low‑concurrency admin tool, and a reasonable **interim** step. Not acceptable for the clinician product path.

**Do not** deploy the admin backend at `max-instances > 1` with filesystem state until option 1 or 2 is in place — you will silently lose prompt publishes and see run history flicker.

---

## 6. What can deploy as‑is vs what must change

| Component | Today | Target | Effort | Blocking for launch? |
|---|---|---|---|---|
| Frontend (`apps/web`) | Next 15 local :3000 | **Vercel** (root `apps/web`) | **Low** — connect repo, set `BACKEND_URL` | No |
| Web↔backend seam | `next.config` rewrite to localhost | Rewrite → Cloud Run URL | **Low** | No |
| Backend (`packages/backend`) | Express local :8080 | **Cloud Run** | **Medium** — new Dockerfile, secrets, IAM | Yes |
| Backend Dockerfile | **Does not exist** | Multi‑stage monorepo image | **Medium** — write it (Appendix 12.1) | Yes |
| Postgres | Docker PG18 local | **Cloud SQL** (private IP, CMEK, backups) | **Medium** | Yes |
| Firestore | memory driver | **Firestore Native** + rules | **Low** — driver exists | Only if product is live |
| LLM generation | **AI Studio** (no BAA) | **Vertex AI Gemini** (BAA) | **Low config, High priority** | **Yes (compliance)** |
| NER sidecar | local / dockerfile | **Cloud Run private 2Gi** | **Low** — Dockerfile exists | If used on live path |
| ASR | `@google-cloud/speech` | Speech‑to‑Text (enable API + IAM) | **Low** | If audio used |
| RxNorm | public RxNav + local cache | Same + egress/NAT + drug‑string‑only rule | **Low** | No |
| Eval / Upgrader batch | local long process | **Cloud Run Jobs + GCS** | **Medium** | No (internal) |
| Secrets | `.env` file | **Secret Manager** | **Low** | Yes |
| Prompt store / run state | **local filesystem** | Cloud SQL/GCS (or pin 1 instance) | **Medium** | **Yes (correctness)** |
| Prod auth | **bypassed in prod** (`server.js`) | Private + ID token, or enforce token | **Low code, High priority** | **Yes (security)** |
| Deploy scripts | stale (`backend/Dockerfile`, `web/`) | Rewrite for monorepo + Cloud SQL | **Medium** | Yes |
| CI/CD | none | Vercel Git + Cloud Build/Actions | **Medium** | Recommended |
| IaC | none | Terraform | **Medium** | Recommended |

**One‑line summary:** the app *runs* on GCP+Vercel with about a week of focused work (Dockerfile, Cloud SQL, Vertex switch, secrets, Vercel wiring); it is *production‑safe* only after the filesystem‑state and prod‑auth fixes and the BAA paperwork.

---

## 7. Security & compliance checklist

- [ ] **Signed Google Cloud BAA**; Notera entity recorded per Google's HIPAA Implementation Guide.
- [ ] **Signed Vercel BAA** *if* the web tier is in the PHI boundary (§5.1). Otherwise document why it's out of scope.
- [ ] `LLM_BACKEND=vertex` in prod; **AI Studio disabled** in prod by a boot‑time assertion.
- [ ] All PHI services confined to the **HIPAA‑eligible allowlist** (Cloud Run, Cloud SQL, Firestore, Vertex, Speech, GCS, Secret Manager, KMS, Logging).
- [ ] **CMEK** on Cloud SQL, GCS (audio + results), and where supported — keys in Cloud KMS with a rotation schedule.
- [ ] Cloud SQL **private IP**, no public IP; reached via Cloud SQL connector / Serverless VPC.
- [ ] Backend + NER **private ingress**; every caller authenticated (ID token) — **or** public + enforced token + Cloud Armor with the `server.js` bypass fixed.
- [ ] **Prod auth bypass in `server.js` fixed** (do not ship the unconditional `NODE_ENV==='production' → next()`).
- [ ] `deidMap` collection locked down; de‑identification runs before any external call (RxNav) and as defense‑in‑depth before Vertex.
- [ ] **RxNav gets drug strings only** — automated test asserts no identifiers leave the boundary.
- [ ] **Audit logging** (Cloud Audit Logs + the app's `auditLog`) enabled and retained; access to PHI logged.
- [ ] Secrets only in **Secret Manager**; no secrets in images, Vercel, or git (`.gitignore` verified).
- [ ] Backups: Cloud SQL automated backups + **PITR**; test a restore. GCS versioning for results.
- [ ] Least‑privilege **IAM** per service account; no default/over‑broad roles.
- [ ] Data residency pinned (US or EU) consistently across Cloud SQL, Firestore, Vertex, GCS.
- [ ] Incident response + breach‑notification runbook; disaster‑recovery RTO/RPO defined.

---

## 8. CI/CD and Infrastructure as Code

**Frontend (Vercel):** native Git integration — every PR gets a **preview deployment**, `main` promotes to production. Set env vars per environment in the Vercel dashboard. Turborepo remote caching speeds builds.

**Backend + NER (GCP):** GitHub Actions (or Cloud Build triggers) on push to `main`:
1. Build images (backend from repo‑root context, NER from `ner/`) → push to **Artifact Registry**.
2. Run migrations as a **Cloud Run Job** (`db/migrate_upgrader.mjs` etc.) with a manual‑approval gate for schema changes.
3. `gcloud run deploy` backend + NER with `--set-secrets`/`--set-env-vars`.
4. Smoke test `/healthz`; roll back on failure (Cloud Run keeps revisions — traffic‑split or instant rollback).

**IaC (Terraform recommended):** codify the project, APIs, Artifact Registry, Cloud SQL (private IP + CMEK + backups), Firestore, VPC + Serverless VPC connector + Cloud NAT, Secret Manager secrets, service accounts + IAM bindings, Cloud Run services, and Cloud Run Jobs. Appendix 12.4 sketches the Cloud SQL + Cloud Run pieces. Keep state in a **GCS backend** with locking.

**Environments:** at least `staging` (synthetic data, AI Studio OK) and `prod` (PHI, Vertex only). Never point staging at the prod database.

---

## 9. Cost model (order‑of‑magnitude)

Actual cost depends on traffic and how aggressively you use `min-instances`. Rough monthly starting point for **low production volume** (validate against the current GCP/Vercel pricing pages before committing):

| Item | Driver | Rough monthly |
|---|---|---|
| Vercel Pro | seats + usage | ~US$20/seat; **+~US$350 if BAA on Pro** |
| Cloud Run — backend | vCPU/mem‑seconds; `min=1` avoids cold starts but bills 24×7 | ~US$15–60 at `min=1`, less at `min=0` |
| Cloud Run — NER | 2Gi, `min=0/1` | ~US$10–50 |
| Cloud SQL Postgres | instance size + storage + backups (billed 24×7) | ~US$50–150 (2 vCPU/7.5 GB) |
| Firestore | reads/writes/storage | low at this scale (~US$5–25) |
| Vertex AI Gemini | tokens in/out per generation | **the swing factor** — scales with volume |
| Speech‑to‑Text | audio minutes | per‑minute; only if audio used |
| GCS + Artifact Registry + logging | storage/egress | ~US$5–20 |
| Cloud NAT / VPC connector | hourly + data | ~US$5–45 |

**Cost levers:** `min-instances=0` on non‑interactive services; right‑size Cloud SQL and stop/scale it in staging; request‑based Cloud Run billing (default) for spiky traffic; cache RxNav; keep Gemini output tokens sane. The **two 24×7 line items** (Cloud SQL and any `min=1` Cloud Run) dominate the floor; **Vertex tokens** dominate the variable cost.

---

## 10. Migration runbook (phased)

**Phase 0 — Foundations (no PHI yet).**
1. Create the GCP project; enable APIs (`run, cloudbuild, artifactregistry, sqladmin, firestore, aiplatform, speech, secretmanager, servicenetworking`).
2. **Sign the Google Cloud BAA** (and Vercel BAA if applicable). Nothing with real PHI proceeds until this is done.
3. Set up Artifact Registry, VPC + Serverless VPC connector + Cloud NAT, Secret Manager, service accounts. Ideally via Terraform.

**Phase 1 — Data tier.**
4. Provision **Cloud SQL** (private IP, CMEK, backups). Create DB/user; store creds in Secret Manager.
5. Run schema migrations as a one‑off Job. Load synthetic data; verify the lab tables.
6. Provision **Firestore Native** + rules/indexes (if the product is in scope).

**Phase 2 — Backend + ML.**
7. Write the **backend Dockerfile** (Appendix 12.1); de‑stale `cloudbuild.backend.yaml`.
8. **Fix the two blockers**: prod auth enforcement (§5.11) and filesystem state (§5.12 — at minimum pin to one instance + GCS volume; ideally move prompt store to Cloud SQL).
9. Build + deploy **NER** (private), then **backend** (with Cloud SQL connector, secrets, `LLM_BACKEND=vertex`). Wire IAM (backend→NER, backend→Vertex/Speech/SQL/Firestore/Secrets).
10. Smoke test `/healthz`, a de‑identified generation end‑to‑end, and NER + RxNorm calls.

**Phase 3 — Frontend.**
11. Deploy `apps/web` to **Vercel** (root `apps/web`), set `BACKEND_URL` → Cloud Run, wire auth model (§5.11).
12. Verify the admin dashboards (Run/Results/Prompts/Upgrader) against the Cloud Run backend, including SSE log streaming and a full run.

**Phase 4 — Batch + hardening.**
13. Package eval/upgrader as **Cloud Run Jobs** writing to GCS; wire Cloud Scheduler if you want recurring runs.
14. Turn on Cloud Armor / rate limiting; finalize audit logging, monitoring dashboards, alerts.
15. **Restore drill** (Cloud SQL PITR), incident‑response doc, load test, then cut over to Vertex + real (BAA‑covered) data.

**Rollback:** Cloud Run keeps revisions (instant traffic shift back); Vercel keeps immutable deployments (instant promote of the previous build); Cloud SQL PITR recovers data. Keep the local Docker setup as the break‑glass dev environment.

---

## 11. Risks & open decisions

- **Vercel in or out of the PHI boundary?** (§5.1) The single biggest architectural decision. Out = cheaper/simpler compliance but requires discipline that no PHI transits/render on Vercel. In = Vercel BAA + cost. All‑GCP = simplest compliance story, lose Vercel DX. **Decide before building the auth model.**
- **One data store or two?** (§5.4) Keep Firestore + Postgres, or consolidate onto Postgres until the clinician product ships? Two stores = two things to secure/back up/audit.
- **Filesystem state** (§5.12) — interim single‑instance vs proper Cloud SQL/GCS migration. Interim is fine for internal admin, not for scale.
- **Prod auth bypass** (§5.11) — must be resolved; don't ship public ingress without enforcing auth.
- **NER model bake‑in** (§5.6) — confirm models load in the image; the Dockerfile currently degrades silently.
- **ID token from Vercel** — willingness to place a GCP SA credential on Vercel vs going all‑GCP for the web tier.
- **Data residency** — US vs EU must be chosen once and applied consistently across every service.
- **Cost ceiling** — Vertex token spend is the variable to watch; set budgets + alerts.

---

## 12. Appendices

### 12.1 Backend Dockerfile (new — place at `packages/backend/Dockerfile`, build from repo root)

```dockerfile
# syntax=docker/dockerfile:1
# Build from the REPO ROOT so workspace packages (schema/, packages/config) are in context:
#   gcloud builds submit --config deploy/cloudbuild.backend.yaml .
FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# --- deps: install only what the backend workspace needs ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/config/package.json  packages/config/
COPY schema/package.json           schema/
# workspace-aware, production-only install
RUN npm ci --omit=dev --workspace @notera/backend --include-workspace-root

# --- runtime image ---
FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY schema/            ./schema/
COPY packages/config/   ./packages/config/
COPY packages/backend/  ./packages/backend/
WORKDIR /app/packages/backend
EXPOSE 8080
# Cloud Run injects PORT; server.js already reads process.env.PORT
CMD ["node", "server.js"]
```

> Adjust the exact `COPY` set to match how `packages/backend` imports `schema/` and `packages/config` (the backend imports the shared `schema`, so it must be present at the path the code expects). Verify locally with `docker build -f packages/backend/Dockerfile .` before wiring CI.

### 12.2 `vercel.json` (optional — only if not using the `next.config.js` rewrite)

```json
{
  "rewrites": [
    { "source": "/backend/:path*", "destination": "https://scribe-backend-xxxx.a.run.app/:path*" }
  ]
}
```

### 12.3 Env var mapping: local `.env` → GCP

| Var | Local (`.env`) | Prod home | Notes |
|---|---|---|---|
| `LLM_BACKEND` | `ai_studio` | Cloud Run env = `vertex` | **Compliance‑critical** |
| `GEMINI_API_KEY` | key | Secret Manager (dev only) | Not needed on Vertex |
| `GCP_PROJECT`, `VERTEX_LOCATION` | — | Cloud Run env | Region = residency |
| `GEMINI_MODEL`, `*_MAX_OUTPUT_TOKENS`, `*_THINKING_LEVEL` | as tuned | Cloud Run env | Keep values |
| `STORE_BACKEND` | `postgres` | Cloud Run env = `postgres` | |
| `DATABASE_URL` | localhost | Secret Manager | Cloud SQL socket/private IP |
| `DEID_ENC_KEY` | dev key | Secret Manager | pgcrypto key — rotate carefully |
| `FIRESTORE_DRIVER` | `memory` | Cloud Run env = `firestore` | |
| `NER_URL`, `NER_USE_IAM` | localhost / false | Cloud Run env = NER URL / `true` | |
| `RXNORM_VERIFY`, `RXNORM_BASE_URL` | `1` / public | Cloud Run env | drug‑strings‑only |
| `SERVICE_TOKENS`, `BACKEND_SERVICE_TOKEN` | `dev-token` | Secret Manager | see auth model |
| `REQUIRE_AUTH` | `false` | Cloud Run env = `true` | + fix `server.js` |
| `ASR_MODEL/LANGUAGE/SAMPLE_RATE` | defaults | Cloud Run env | |

### 12.4 Terraform sketch (Cloud SQL + Cloud Run backend — illustrative, not complete)

```hcl
resource "google_sql_database_instance" "notera" {
  name             = "notera-pg"
  database_version = "POSTGRES_15"
  region           = var.region
  settings {
    tier              = "db-custom-2-7680"
    availability_type = "REGIONAL"            # HA
    disk_autoresize   = true
    ip_configuration {
      ipv4_enabled    = false                 # private only
      private_network = google_compute_network.vpc.id
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }
  encryption_key_name = google_kms_crypto_key.sql.id   # CMEK
}

resource "google_cloud_run_v2_service" "backend" {
  name     = "scribe-backend"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"   # private
  template {
    service_account = google_service_account.backend.email
    vpc_access { connector = google_vpc_access_connector.serverless.id  egress = "PRIVATE_RANGES_ONLY" }
    volumes { name = "cloudsql"  cloud_sql_instance { instances = [google_sql_database_instance.notera.connection_name] } }
    containers {
      image = "${var.region}-docker.pkg.dev/${var.project}/scribe/backend:latest"
      ports { container_port = 8080 }
      env { name = "LLM_BACKEND"   value = "vertex" }
      env { name = "STORE_BACKEND" value = "postgres" }
      env { name = "FIRESTORE_DRIVER" value = "firestore" }
      env { name = "REQUIRE_AUTH"  value = "true" }
      # DATABASE_URL, DEID_ENC_KEY, SERVICE_TOKENS via google_secret_manager + env{value_source}
      volume_mounts { name = "cloudsql"  mount_path = "/cloudsql" }
    }
  }
}
```

### 12.5 De‑staling the existing deploy scripts

- `deploy/cloudbuild.backend.yaml`: change `-f backend/Dockerfile` → `-f packages/backend/Dockerfile`; keep the repo‑root context.
- `deploy/deploy-all.sh`: change the `web` build context `web` → `apps/web` (and add a web Dockerfile only if going all‑GCP), the backend to the new Dockerfile path, and **add Cloud SQL provisioning + connection** (the script currently wires Firestore only and ignores the Testing‑Lab Postgres). Also set `LLM_BACKEND=vertex` (it currently hard‑codes `ai_studio`).

---

## Sources

- Cloud Run pricing, concurrency, min‑instances — https://cloud.google.com/run/pricing ; https://docs.cloud.google.com/run/docs/release-notes ; https://docs.cloud.google.com/run/docs/configuring/billing-settings
- Cloud SQL for PostgreSQL — HIPAA, private IP, CMEK, pgvector — https://cloud.google.com/sql/postgresql ; https://docs.cloud.google.com/sql/docs/postgres/configure-private-ip ; https://docs.cloud.google.com/sql/docs/postgres/cmek
- Connecting Cloud Run to Cloud SQL (VPC connector / Cloud SQL socket) — https://docs.cloud.google.com/sql/docs/postgres/connect-run ; https://medium.com/google-cloud/connecting-cloud-run-to-cloud-sql-without-going-through-the-public-internet-5268c8e4cbb9
- Vertex AI Gemini HIPAA / BAA / data residency — https://cloud.google.com/security/compliance/hipaa ; https://www.strac.io/blog/is-gemini-hipaa-compliant ; https://aiprovidertrust.com/offerings/gemini-vertex/
- Google Cloud HIPAA‑eligible services + BAA — https://cloud.google.com/security/compliance/hipaa-compliance ; https://www.accountablehq.com/post/google-cloud-run-hipaa-compliance-guide-eligibility-baa-and-step-by-step-setup-checklist
- Vercel HIPAA / BAA + pricing — https://vercel.com/blog/vercel-supports-hipaa-compliance ; https://vercel.com/docs/monorepos/turborepo ; https://vercel.com/docs/monorepos
- Turborepo → Vercel monorepo deployment & rewrites — https://vercel.com/docs/monorepos/turborepo ; https://vercel.com/docs/monorepos/monorepo-faq

*This document was written against the actual repository state (Turborepo: `apps/web`, `packages/backend`, `schema/`, `ner/`, `db/`, `eval/`, `deploy/`) as of August 2026. Verify GCP and Vercel pricing/terms at deploy time — they change.*
