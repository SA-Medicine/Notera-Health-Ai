# Notera-Health-Ai

Production clinical documentation engine. A consult transcript (or audio) goes in;
a schema-structured, fact-grounded, guardrailed clinical note comes out — for a
clinician to review and sign. All-GCP, HIPAA-aligned, self-improving.

> Repo: [SA-Medicine/Notera-Health-Ai](https://github.com/SA-Medicine/Notera-Health-Ai)

This is the productionized form of the original `DAS` prototype (a browser extension
that called Gemini/Groq directly from the page). The proven multi-agent note pipeline
was **ported unchanged** into a private Node backend and wrapped in the target
architecture from the `docs/planning/*.md` planning docs (`00`–`10`).

---

## Architecture

```
Clinician ─▶ Next.js (Cloud Run, public)
                   │  ID token
                   ▼
            Node backend (Cloud Run, private) ── orchestrator
                   │
      ┌────────────┼───────────────┬───────────────┐
      ▼            ▼               ▼               ▼
  Medical ASR   NER sidecar    Gemini          Firestore + audit
  (Speech)      (Cloud Run)    (AI Studio      (data, deidMap,
                scispaCy/Med7/  → Vertex)       finals, feedback)
                medspaCy
```

Generation flow (the core IP — `backend/src/orchestrator/generateNote.js`):

1. **Ingest** — transcript, or GCS audio → medical ASR (diarized).
2. **NER** — in-house scispaCy + Med7 + medspaCy extract the hard facts (PHI never leaves).
3. **De-identify** — strip PHI before any AI Studio call; keep the `deidMap` locked down.
4. **Generate** — the ported multi-agent `PipelineEngine` (Gemini is the only LLM).
5. **Structure** — render → **schema v1.0.0** JSON (Gemini structured output; heading-parser fallback).
6. **Guardrails** — schema validation + NER medication cross-check + missing/low-confidence flags.
7. **Re-identify** — put identifiers back inside our own systems.
8. **Persist** — draft → Firestore + append-only audit; sign-off captures the draft→final diff (the flywheel).

---

## Layout

```
Notera-Health-Ai/
├── schema/       versioned note schema (v2.0.0 Heidi template) + AJV validator
├── backend/      Node orchestrator (Cloud Run) + key-safe proxy
│   └── src/pipeline/   ← ported multi-agent engine (server-side copy)
├── ner/          Python FastAPI NER sidecar (Cloud Run)
├── web/          Next.js app (landing, login, history) + the embedded scribe
│   └── public/das/     ← DAS clinical scribe: web app AND loadable Chrome extension
│         └── pipeline/ ← same engine (client-side copy, runs in the browser)
├── eval/         eval harness + metrics + dataset/tuning builder
├── data/         gold pairs + dataset builder
├── deploy/       Cloud Run scripts, Firebase config, Firestore rules
└── docs/         porting notes, roadmap-to-launch, structure
```

Two intentional copies of the pipeline exist: `backend/src/pipeline` (server, used
by the API orchestrator) and `web/public/das/pipeline` (client, used by the
embedded scribe running in the browser). They are identical ports of the same
engine. All API keys live in `.env`; the embedded app reaches Gemini/Groq only
through the backend proxy (`/backend/*`).

## Quickstart (local)

```bash
cp .env.example .env          # set GEMINI_API_KEY (or LLM_BACKEND=vertex)
npm install                    # installs workspace deps

# 1. NER sidecar (optional locally; degrades gracefully if models absent)
cd ner && pip install -r requirements.txt && uvicorn main:app --port 8000 &

# 2. Backend orchestrator
npm run start:backend          # http://localhost:8080  (FIRESTORE_DRIVER=memory)

# 3. Frontend
cd web && npm install && npm run dev   # http://localhost:3000
```

Then open http://localhost:3000, click **Load sample**, and **Generate draft note**.
(Generation needs a working `GEMINI_API_KEY`; the rest of the pipeline — deid, NER,
schema, guardrails, review, sign-off — runs without one.)

## Test

```bash
npm test                       # backend smoke tests + eval metric tests
node data/build_dataset.mjs    # build the schema dataset + tuning JSONL from data/gold
node eval/run_eval.mjs --limit 3   # end-to-end scorecard (needs GEMINI_API_KEY)
```

## Deploy (Cloud Run)

```bash
PROJECT_ID=your-project GEMINI_API_KEY=xxx deploy/deploy-all.sh
```

---

## Compliance in one paragraph

The AI Studio Gemini endpoint is **not** BAA-covered, so raw PHI never reaches it:
the orchestrator de-identifies before generation and re-identifies after, inside our
systems (`backend/src/deid`). Firestore, Cloud Run, GCS and Speech are BAA-eligible.
For full PHI production set `LLM_BACKEND=vertex` — same models and prompts, under a
BAA — and de-id for the LLM hop becomes optional. No LLM is self-hosted; the only ML
we run in-house is the free NER (which keeps PHI on our side). A clinician always
signs — no note auto-finalizes.

See `docs/PORTING_NOTES.md` for how the prototype maps onto this system, and the
`docs/planning/00`–`10` planning docs for the full rationale.
