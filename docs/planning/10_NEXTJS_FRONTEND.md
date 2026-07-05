# 10 — Frontend: Scalable Next.js App

The clinician-facing app: record/upload a consult, watch the draft note appear, edit, and sign off. Built in **Next.js** (App Router), deployed on GCP alongside everything else.

---

## 1. Why Next.js here

- **Scalable & popular** — huge ecosystem, easy hiring, battle-tested.
- **App Router + Server Components** — render fast, keep secrets/logic server-side.
- **Server Actions / Route Handlers** — a natural place to proxy calls to the Cloud Run backend without exposing keys to the browser.
- **Deploys cleanly on GCP** — containerize and run on **Cloud Run** (same as the backend), or use **Firebase Hosting + Cloud Run**. Keeps us single-cloud.

`[DECIDE]` Cloud Run (one deploy story with the backend) vs Firebase Hosting (tighter Firebase integration). Recommendation: **Cloud Run** for consistency.

---

## 2. Architecture — where Next.js sits

```
Browser (clinician)
      │  HTTPS
      ▼
Next.js app (SSR + API routes)  ──►  Cloud Run backend  ──►  ASR / NER / Gemini / Firestore
      │                                     ▲
      └── auth (Firebase Auth / Identity Platform)
```

**Key rule:** the browser never talks to Firestore-PHI, Gemini, or ASR directly. It talks to **Next.js server code**, which calls the **Cloud Run backend** (with an ID token). This keeps API keys and PHI logic server-side. (Mirrors the security posture in `09 §4`.)

---

## 3. Core screens (MVP)

1. **New consult** — record audio (Web Audio API / `MediaRecorder`) or upload a file → send to backend → ASR runs.
2. **Draft review** — show the generated note in the schema layout (Subjective / Objective / Assessment / Plan). Highlight NER-flagged items (unverified meds/doses) and low-confidence sections.
3. **Edit & sign-off** — inline editing; "Approve" writes to `finals` and captures the edit diff as feedback (`09 §2`).
4. **History** — clinician's past consults and notes.
5. **(Admin)** — model version in use, eval scorecard, usage/cost.

---

## 4. Auth

Use **Firebase Auth / Google Identity Platform**:
- Clinicians sign in (SSO / email).
- Next.js verifies the session server-side; every backend call carries the user identity.
- Enforce roles (clinician vs admin) both in UI and in backend authorization.

Never trust the client for authorization — the backend re-checks every request.

---

## 5. The async note flow (UX pattern)

Note generation takes several seconds (ASR + NER + Gemini). Don't block the UI:

```
POST /api/consults           → creates consult, kicks off pipeline, returns consultId
(client subscribes)          → Firestore real-time listener OR poll /api/consults/:id
status: transcribing → extracting → drafting → ready
when ready                   → render draft for review
```

Two good options for live status:
- **Firestore real-time listener** (read-only, non-PHI status fields) for instant updates, or
- **Poll** a Next.js route that proxies the backend.

`[DECIDE]` real-time listener vs polling. Listener feels better; polling is simpler and avoids exposing Firestore to the client.

---

## 6. Scalability practices

- **Stateless app** on Cloud Run → autoscales with traffic; scale to zero when idle.
- **Server Components** for data-heavy pages; **stream** the note in as it's ready.
- **Cache** non-PHI static assets on Cloud CDN.
- **Environment config** via Cloud Run env vars + Secret Manager (backend URL, project id) — no secrets in client bundles.
- **Rate limits & timeouts** on API routes; graceful "still working…" states.

---

## 7. Deploy on Cloud Run

**`Dockerfile` (standalone Next.js output)**
```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build            # next.config: output: "standalone"

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
ENV PORT=8080
CMD ["node", "server.js"]
```

```bash
gcloud builds submit web \
  --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/scribe/web

gcloud run deploy scribe-web \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/scribe/web \
  --allow-unauthenticated \
  --set-env-vars BACKEND_URL=https://scribe-backend-xxxx.run.app \
  --min-instances=0 --max-instances=10
```

> The web app can be public (`--allow-unauthenticated`) because auth happens in-app; the **backend stays private** and is only callable by the web app's service account.

---

## 8. Recommended stack inside Next.js

- **UI:** Tailwind CSS + a component lib (shadcn/ui or MUI).
- **Data fetching/state:** TanStack Query (async status, retries) or built-in Server Components + Server Actions.
- **Forms/editing:** react-hook-form for the note editor.
- **Audio:** `MediaRecorder` API for capture.
- **Auth:** Firebase Auth SDK (client) + token verification (server).

`[DECIDE]` component library and state approach — team preference.

---

## 9. Checklist

- [ ] Next.js App Router project, `output: "standalone"`.
- [ ] All PHI/model calls proxied through server code → private backend.
- [ ] Firebase Auth wired; roles enforced server-side.
- [ ] Async note flow with live status (listener or poll).
- [ ] Draft review UI shows NER flags + confidence.
- [ ] Approve writes `finals` + captures edit diff (feedback).
- [ ] Deployed on Cloud Run; backend URL via env; no secrets in client.

---

## 10. Full deployed picture

```
                 ┌─────────────────────────────┐
   Clinician ───►│  Next.js (Cloud Run, public) │
                 └──────────────┬──────────────┘
                                │ ID token
                                ▼
                 ┌─────────────────────────────┐
                 │  Node backend (Cloud Run,    │
                 │  private)  ── orchestrator   │
                 └───┬─────────┬────────┬───────┘
                     │         │        │
        ┌────────────┘   ┌─────┘        └───────────┐
        ▼                ▼                          ▼
  MedASR (Speech)   NER sidecar (Cloud Run)   Gemini (AI Studio → Vertex)
        │                │                          │
        └────────────────┴──────────┬───────────────┘
                                     ▼
                            Firestore + GCS (data, audit)
```

That's the whole system, all on GCP: Next.js UI → private Node backend → ASR + NER + Gemini → Firestore. Setup order: `07` (Cloud Run) → `08` (ASR) → `09` (Firestore) → `10` (this).
