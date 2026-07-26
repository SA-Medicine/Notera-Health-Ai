# Notera-Health-Ai — Complete System Reference

**A technical paper describing what this system is, how every part works, and how data
flows from a spoken consultation to a signed clinical note — and from a test run to a
quality metric on a dashboard.**

Version: monorepo v2.0 (Turborepo · Next.js 15 · Express · PostgreSQL 18 · Gemini)
Audience: a developer who has never seen this codebase and needs to hold the whole
thing in their head.

---

## Table of contents

1. [What this system actually is](#1-what-this-system-actually-is)
2. [The two audiences and the two surfaces](#2-the-two-audiences-and-the-two-surfaces)
3. [Physical architecture: processes, ports, and who talks to whom](#3-physical-architecture)
4. [Repository map: every directory, what lives there and why](#4-repository-map)
5. [The domain model: the seven nouns the whole system is built from](#5-the-domain-model)
6. [The database layer](#6-the-database-layer)
7. [Flow A — the clinician journey (login → note → sign-off)](#7-flow-a--the-clinician-journey)
8. [Flow B — the generation pipeline, agent by agent](#8-flow-b--the-generation-pipeline)
9. [The LLM layer: service, proxy, models, retries](#9-the-llm-layer)
10. [The prompt registry: how agents get their instructions](#10-the-prompt-registry)
11. [De-identification and the PHI boundary](#11-de-identification-and-the-phi-boundary)
12. [Schema validation and guardrails](#12-schema-validation-and-guardrails)
13. [Flow C — the evaluation harness and how quality is measured](#13-flow-c--the-evaluation-harness)
14. [Flow D — the Testing Lab (runs, agent capture, rerun, dashboard)](#14-flow-d--the-testing-lab)
15. [Frontend architecture](#15-frontend-architecture)
16. [Configuration and environment](#16-configuration-and-environment)
17. [Security model](#17-security-model)
18. [Operational runbook](#18-operational-runbook)
19. [Design decisions and their rationale](#19-design-decisions-and-their-rationale)
20. [Known limitations and future work](#20-known-limitations-and-future-work)
21. [Glossary](#21-glossary)
22. [Appendix A — file-by-file index](#appendix-a--file-by-file-index)
23. [Appendix B — complete API surface](#appendix-b--complete-api-surface)

---

## 1. What this system actually is

Notera is **two products sharing one engine**.

**Product 1 — the clinical scribe.** A clinician records or pastes a consultation
transcript. The system produces a *schema-structured SOAP note* — not free text, but a
validated JSON object with named fields (subjective, past medical history, objective,
assessment & plan). The clinician reviews, edits, and signs. No note is ever finalized
without a human.

**Product 2 — the testing lab.** Because the engine is a chain of LLM agents whose
behaviour changes every time a prompt changes, you cannot ship it without a way to answer
*"did my prompt edit make the notes better or worse?"* The lab runs the real pipeline over
a fixed set of reference cases, scores each output against a known-good "gold" note, stores
every agent's input and output, and charts quality over time.

The central intellectual claim of the system is this:

> **Accuracy in clinical documentation does not come from a bigger model. It comes from
> grounding and guardrails around the model.**

Concretely, that means the pipeline never asks an LLM to "write a clinical note."
It instead:

1. **Extracts discrete facts** from the transcript into a typed knowledge graph.
2. **Analyses recall** — did the extraction miss categories of fact? If so, recover them.
3. **Builds a problem graph** from those facts deterministically (pure JavaScript, no LLM).
4. **Fills a fixed template's slots** using the LLM, constrained by the facts.
5. **Validates** the resulting narrative against the fact graph (did we invent anything?
   did we drop anything critical?).
6. **Cross-checks medications** against an independent NER model — the highest-harm error
   class in clinical documentation is a drug the patient was never prescribed.
7. **Validates against a JSON schema** and applies guardrails before anything is persisted.

Every one of those steps is a separately inspectable, separately re-runnable unit. That is
what the testing lab exists to expose.

---

## 2. The two audiences and the two surfaces

| | Clinician product | Testing lab |
|---|---|---|
| **URL** | `/`, `/login`, `/app`, `/consults` | `/admin` |
| **Route group** | `app/(app)/` | `app/(admin)/` |
| **Visual theme** | Light/white, product branding | Dark shadcn dashboard |
| **Auth** | `AuthProvider` (demo, localStorage; Firebase-ready) | Password → server session cookie |
| **Data path** | Browser → **Next BFF** → Express (PHI never in browser) | Browser → `/backend/*` proxy → Express |
| **Handles PHI?** | Yes — the real thing | No — synthetic reference cases only |

They are **one Next.js application**. Route groups (`(app)` and `(admin)`) let a single app
host two completely different-looking surfaces with separate layouts, separate CSS, and
separate auth, without the URL containing the group name.

This matters: the clinician side deliberately keeps its original white theme and its
server-only data path, while the lab is a dark analytics console. Merging them into one app
means one dependency tree, one design system, one dev command — but the PHI boundary of the
clinician side is preserved because it uses Next's server components/route handlers, not
direct browser→backend calls.

---

## 3. Physical architecture

At runtime there are **three processes**:

```
┌──────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                              │
│   http://localhost:3000            http://localhost:3000/admin       │
│        │                                    │                        │
└────────┼────────────────────────────────────┼────────────────────────┘
         │ (1) same-origin                    │ (2) same-origin
         ▼                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ NEXT.JS APP  (apps/web)                                    :3000     │
│                                                                      │
│  (app) route group          (admin) route group                      │
│  ├ Landing / Login          └ AdminApp (client-only SPA, ssr:false)   │
│  ├ /app  workspace                                                   │
│  └ /consults                                                         │
│                                                                      │
│  app/api/*  ── the BFF ── server-only, holds the service token       │
│  next.config rewrites:  /backend/:path*  →  http://localhost:8080/*  │
└───────────┬──────────────────────────────────────┬───────────────────┘
            │ (3) server-side fetch                │ (4) proxied
            ▼                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│ EXPRESS BACKEND  (packages/backend)                        :8080     │
│                                                                      │
│  PRODUCT ROUTER            ADMIN/LAB ROUTER (mounted handler)        │
│  /healthz                  /api/login /api/session                   │
│  /api/consults  (CRUD)     /api/runs   (spawn + SSE stream)          │
│  /api/consults/:id/approve /api/results /api/prompts /api/patients   │
│  /api/llm/* (key-safe)     /api/lab/*  (dashboard, rerun)            │
│                                                                      │
│  ── the engine ──                                                    │
│  orchestrator/generateNote.js  →  pipeline/PipelineEngine.js         │
│  services/LLMService.js  deid/  ner/  validation/  db/               │
└───────────┬──────────────────────────────┬───────────────────────────┘
            │ (5)                          │ (6) spawns
            ▼                              ▼
┌────────────────────────┐   ┌──────────────────────────────────────────┐
│ POSTGRES 18 (docker)   │   │ eval/run_eval.mjs  (child process)       │
│ database: notera       │   │ runs the REAL pipeline over data/gold    │
│ schema:  lab           │   │ writes eval/results/ + mirrors to the DB  │
│ :5432                  │   └──────────────────────────────────────────┘
└────────────────────────┘
            ▲
            │ (7) optional
┌────────────────────────┐
│ NER SIDECAR (python)   │  scispaCy · Med7 · medspaCy   :8000
│ optional — degrades    │
└────────────────────────┘
```

**Why a proxy rewrite (`/backend/*`)?** The lab's browser code needs to call the Express
backend. If it called `http://localhost:8080` directly, the admin session cookie (set on
`localhost:3000`) would not be sent — different origin. Routing through Next keeps
everything same-origin so cookies work, and means only one port is exposed to the browser.

**Why is the admin handler mounted *before* `express.json()`?** The lab handler reads the
raw request stream itself (it needs to for SSE, and for its own body-size limits on very
large imports). If Express's JSON body parser consumed the stream first, the handler would
hang. So the server dispatches admin path prefixes to the raw handler, and only applies
`express.json()` to the product routes below it.

---

## 4. Repository map

```
notera/
├── apps/
│   └── web/                        THE Next.js app (both surfaces)
│       ├── app/
│       │   ├── layout.tsx          root layout — theme-neutral, just <html><body>
│       │   ├── providers.tsx       client providers (Theme, Tooltip, Toaster)
│       │   ├── (app)/              CLINICIAN PRODUCT
│       │   │   ├── layout.tsx      imports the white globals.css + AuthProvider + TopBar
│       │   │   ├── globals.css     the original product theme (CSS variables)
│       │   │   ├── page.tsx        → Landing
│       │   │   ├── login/page.tsx  auth screen + "Testing lab / Admin →" button
│       │   │   ├── app/page.tsx    the logged-in workspace (Protected iframe → /das)
│       │   │   ├── consults/       consult history table
│       │   │   └── components/     Landing, LoginForm, AuthProvider, Protected,
│       │   │                        TopBar, NewConsult, NoteReview, PipelineLogsPanel
│       │   ├── (admin)/            TESTING LAB
│       │   │   ├── layout.tsx      imports @notera/ui globals + Providers + .dark
│       │   │   └── admin/page.tsx  dynamic(ssr:false) → AdminApp
│       │   └── api/                THE BFF — server-only proxy to the backend
│       │       ├── consults/route.ts            POST create · GET list
│       │       ├── consults/[id]/route.ts       GET one
│       │       └── consults/[id]/approve/route.ts  POST sign-off
│       ├── app/lib/backend.ts      server-only backend client (holds the token)
│       └── src/                    the lab SPA (client-side)
│           ├── AdminApp.tsx        shell: auth gate, tab state, sidebar, palette
│           ├── lib/api.ts          typed API client + useRunStream (SSE + polling)
│           ├── lib/nav.ts          the 7 lab tabs
│           ├── components/blocks/  sidebar, topbar, command-palette
│           └── screens/            overview · run · patients · results ·
│                                    metrics · prompts · judge
│
├── packages/
│   ├── ui/                         @notera/ui — THE shared design system
│   │   ├── src/styles/globals.css  shadcn tokens (light + dark) + @tailwind
│   │   ├── tailwind-preset.ts      the design tokens as a Tailwind preset
│   │   ├── src/components/ui/      Button Card Badge Input Tabs Dialog Tooltip Skeleton
│   │   ├── src/components/blocks/  ThemeProvider, Login (presentational)
│   │   └── src/lib/                utils (cn, formatters), md (markdown + diff)
│   ├── backend/                    @notera/backend — THE Express service
│   │   ├── server.js               mounts admin router + product router
│   │   ├── prompts/                the prompt registry + versioned store
│   │   └── src/                    (see §8, §9 — the engine)
│   └── config/                     shared tsconfig base
│
├── schema/                         @notera/schema — the note contract
│   ├── note.schema.v2.0.0.json     the JSON Schema every note must satisfy
│   └── index.js                    Ajv validator + empty-note factories
│
├── eval/                           the evaluation harness
│   ├── run_eval.mjs                runs the pipeline over data/gold, scores, mirrors to DB
│   ├── metrics.mjs                 the scoring functions (§13)
│   └── results/run_<ts>/           per-run outputs (.md, .json, _summary, _pipeline.log)
│
├── db/                             the database
│   ├── schema.lab.sql              the lab schema DDL
│   ├── reset.mjs                   backup → drop → create → backfill
│   ├── backfill_lab.mjs            seeds gold + past runs into the DB
│   ├── test_lab_logic.mjs          pure-logic unit tests (no DB/LLM)
│   └── docker-compose.postgres.yml Postgres 18 + nightly pg_dump sidecar
│
├── data/gold/                      the reference corpus: <slug>.txt = transcript + gold note
├── ner/                            optional Python NER sidecar
├── admin/data/                     lab runtime state (runs.json, logs/, sessions/)
└── turbo.json, package.json        the monorepo root
```

---

## 5. The domain model

Seven nouns explain the entire system. If you understand these, you understand the data.

**1. Patient (a.k.a. reference case / fixture).** *Not* a real person — a frozen test case.
It holds a transcript and the "gold" SOAP note a human expert produced for that transcript.
It never changes; that's the point. Identified by a `slug` (`patient1`, `hair-fall-tests`)
which is also the filename in `data/gold/`.

**2. Run.** One execution of the pipeline over a set of patients. Has a sequential
`run_no`, a `label` (`run_2026-07-17_17-36-41`, which is also the results directory name),
and a status.

**3. Record (`run_patients`).** The intersection: *this run × this patient*. Holds the
note that was generated and the verdict. This is the row you're looking at when you view a
result.

**4. Agent run.** One agent's execution within a record — its resolved system prompt, its
exact input, its raw and parsed output, latency, tokens, and which attempt it was. This is
the atom of the testing lab and what makes single-agent rerun possible.

**5. Metric.** One number about one record — `section_coverage`, `similarity_to_gold`,
`qa_accuracy_score`. Stored normalized (one row per metric) rather than as wide columns, so
new metrics can appear without a migration.

**6. Consult.** The *production* counterpart of a record: a real clinician's real
consultation, with a draft and eventually a signed final. Lives in the product store, not
the lab schema.

**7. Prompt.** A versioned system instruction for one agent, stored as files with immutable
version history.

The relationship, stated once:

```
patient ──< run_patients >── run
              │
              ├──< agent_runs      (one per agent per record, plus reruns)
              └──< metrics         (one per metric key per record)
```

---

## 6. The database layer

### 6.1 Why PostgreSQL, and why one schema

The system previously used Firestore and a three-schema Postgres design (`clinical`,
`phi`, `ops`) with row-level security. That was correct for a production PHI product but
made the *testing* workflow — which is what this repo is optimised for day to day —
unreadable. The current design collapses to **one schema, `lab`, with six tables** that a
human can hold in their head.

The product store (`consults`, drafts, finals) is separately pluggable:
`STORE_BACKEND=postgres | firestore | memory`. In dev it runs `memory`, so the clinician
side works with zero infrastructure.

### 6.2 The `lab` schema in full

```sql
lab.patients       -- the reference case
  id, slug UNIQUE, name, heidi_session_id UNIQUE, source_url, subtitle, tags jsonb,
  transcript_raw, transcript_clean, gold_note,
  transcript_sha256, gold_hash,          -- change detection / dedupe
  artifacts jsonb, audits jsonb,         -- whatever the import carried
  created_at, updated_at                 -- updated_at maintained by a trigger

lab.runs           -- one pipeline execution
  id, run_no, label UNIQUE, status, pipeline_version, model,
  prompt_snapshot jsonb,                 -- which prompt versions were live
  notes, started_at, finished_at

lab.run_patients   -- run × patient = a record
  id, run_id →runs, patient_id →patients,
  generated_note, rendered_note, status, schema_valid,
  UNIQUE (run_id, patient_id)

lab.agent_runs     -- every agent's input + output
  id, run_id, patient_id, run_patient_id,
  agent_id, seq, system_prompt, prompt_version,
  input jsonb, output_raw, output_parsed jsonb,
  status, error_message, tokens_in, tokens_out, latency_ms, model,
  rerun_of →agent_runs, attempt

lab.metrics        -- normalized metric points
  id, run_id, patient_id, run_patient_id, metric_key, metric_value numeric,
  UNIQUE (run_patient_id, metric_key)

lab.run_logs       -- per-run stdout/stderr tagged by agent
  id, run_id, patient_id, agent_id, stream, line, ts
```

Two views exist so the dashboard doesn't hand-roll aggregation:

- `lab.v_run_summary` — average of every metric per run, plus patient count.
- `lab.v_agent_stats` — per agent per run: calls, errors, avg latency, avg tokens.

### 6.3 Referential integrity is the delete strategy

Every child table declares `ON DELETE CASCADE` on `patient_id` and `run_id`. This is
deliberate: deleting a patient in the UI issues **one** `DELETE FROM lab.patients` and the
database removes every record, agent run, metric, and log line for it. There is no
application-level cleanup code to forget to write.

The trade-off is that deletion is total and irreversible, and it retroactively changes
historical run averages (because the deleted patient's metrics vanish from the aggregate).

### 6.4 Design choices worth naming

- **Normalized metrics, not wide columns.** When the QA agent starts emitting a new score,
  it becomes a new `metric_key` row. No migration, and the trend chart discovers it
  automatically. The cost is that "show me all metrics for this record" is a pivot.
- **`prompt_snapshot` on runs.** A run's numbers are only interpretable if you know which
  prompt versions produced them.
- **`rerun_of` + `attempt` on agent runs.** Reruns are appended, never overwritten, so you
  can compare attempt 1 against attempt 3 of the same agent on the same input.
- **`transcript_sha256` / `gold_hash`.** Lets re-imports detect genuinely-changed reference
  data instead of blindly overwriting.

---

## 7. Flow A — the clinician journey

### 7.1 Authentication

`AuthProvider` (`app/(app)/components/AuthProvider.tsx`) is a **mock, deliberately**. It
persists `{uid, email, name}` to `localStorage` and exposes
`{ user, ready, signIn, signUp, signInWithGoogle, signOut }`.

The important architectural property: **every consumer depends only on that interface.**
`useAuth()`, `<Protected>`, `TopBar`, and `LoginForm` know nothing about how auth is
implemented. Swapping in Firebase Auth means replacing the internals of that one file with
`signInWithEmailAndPassword` / `onAuthStateChanged` — no other file changes.

`<Protected>` is the gate: it reads `useAuth()`, and if there's no user it redirects to
`/login`. `/app` and `/consults` are wrapped in it.

### 7.2 Creating a note

```
NewConsult (client)
   │  POST /api/consults  { transcript, specialty, noteType, clinicianId }
   ▼
app/api/consults/route.ts          ← Next route handler, runs on the SERVER
   │  backendFetch('/api/consults', …)
   ▼
app/lib/backend.ts                 ← 'server-only' — importing this in a client
   │                                  component is a build error, by design
   │  attaches Authorization: Bearer <BACKEND_SERVICE_TOKEN>
   │  (in prod: a Google-signed ID token for the private Cloud Run backend)
   ▼
Express  POST /api/consults
   ▼
generateNote()                     ← the engine (§8)
   ▼
   returns { consultId, draftId, note, renderedNote, status, flags, … }
```

The `'server-only'` import in `backend.ts` is the enforcement mechanism for the PHI
boundary. It makes it *impossible* to accidentally import the module that holds the service
token into browser code — the build fails.

### 7.3 Review and sign-off

`NoteReview` receives the draft and renders:
- the generated note (rendered markdown),
- the guardrail **flags** (each with severity: info / low / warning / critical),
- an editable final version.

Signing issues `POST /api/consults/:id/approve`, which calls `approveNote()`. That writes a
`finals` record, a `feedback` record capturing the **draft→final diff**, and marks the
consult `signed`.

That diff is the strategic payload of the whole product: every clinician edit is a labelled
training signal about what the model got wrong. The consults list calls this "the flywheel."

---

## 8. Flow B — the generation pipeline

This is the core IP. Entry point: `packages/backend/src/orchestrator/generateNote.js`.

### 8.1 The orchestrator's eight stages

```
generateNote(input, opts)
  1. INGEST        transcript, or transcribe audioUri via Google Speech (medical model)
  2. NER           extractEntities(transcript) → typed clinical entities  [optional]
  3. DE-IDENTIFY   deidentify(transcript) → safe text + reversible map    [§11]
  4. GENERATE      PipelineEngine.runPipeline(safeTranscript, …)          [§8.2]
  5. STRUCTURE     clinical_story → schema v2 object (deterministic map),
                   falling back to an LLM structurer only if no story exists
  5b. STORY ENGINE composeStory() — full-transcript Heidi-style narrative pass,
                   with narrateNote() as a lighter fallback
  5c. RECONCILE    deterministic placement fixes (labs→Objective, referrals→A&P, …)
  6. GUARDRAILS    runGuardrails(note, entities)                          [§12]
  7. RE-IDENTIFY   reidentify(note, deidMap) — inside our systems only
  8. PERSIST       consult + draft + audit entries
```

Note the ordering discipline: **de-identification happens before any model call
(stage 3, before stage 4), and re-identification happens after generation is complete
(stage 7).** The LLM provider never sees PHI.

### 8.2 The pipeline engine, stage by stage

`PipelineEngine.runPipeline()` is a single long, explicitly-sequenced function. That is a
deliberate choice: the order *is* the algorithm, and hiding it behind abstraction would make
the system harder to reason about, not easier. Every stage logs, and every timing is
recorded.

| # | Stage | Kind | What it does |
|---|-------|------|--------------|
| 1 | **EncounterClassifierAgent** | LLM | Classifies encounter type (e.g. `general_primary_care`, `msk`, `mental_health`). Downstream template selection depends on this. |
| 2 | **ClinicalObservationExtractorAgent** | LLM | The big one. Extracts a knowledge graph: `clinical_entities[]` (diagnoses, meds, symptoms, PMH…), `numeric_data[]`, `orders[]`, `follow_ups[]`, `relationships[]`. |
| 2.5 | **RelationshipEngine** | JS | Resolves entity relationships before recovery. |
| 3 | **ClinicalRecallAnalyzer** | JS | Asks: which *categories* of fact does the transcript obviously contain that the extraction missed? Returns `needsRecovery` + `missingCategories`. |
| 4 | **FactRecoveryAgent** | LLM *(conditional)* | Only fires when recall analysis says facts are missing. Targeted re-extraction of just those categories. **Cost control: skipped when recall is optimal.** |
| — | `assignFactIdsAndEdges` | JS | Assigns stable `F001`-style IDs, resolves edge indices to IDs, stamps encounter ID. |
| — | `initEntityModel` | JS | Ensures every entity has `represented_by[]`, `semantic_group`, `clinical_significance`, `temporality`. This is the bookkeeping that makes coverage auditing possible later. |
| 4.5 | **HistoricalContextEngine**, **TemporalIntelligenceEngine** | JS | Enrich entities with historical/temporal framing. |
| 5 | **ProblemGraphBuilder** | JS | Builds `active_problems` from the entity graph — deterministically. |
| 5.1 | **ProblemGeneratorEngine** | JS | V30 problem synthesis. |
| 5.5 | **ClinicalLexiconEngine**, **LabAggregationEngine** | JS | Normalise clinical vocabulary; aggregate lab values into reportable groups. |
| 5.6 | **ClinicalStoryLLMAgent** | LLM | **The narrative core.** Fills the fixed template's *slots* from the fact graph — subjective slots, PMH lines, objective lines, assessment/plan. It is a slot filler, not a free-form writer. |
| 5.6.5 | **HeidiStyleEngine** | JS | Formats phrasing to house style. |
| 5.7 | **NarrativeValidator** | JS | Negation tracking + coverage audit: did the narrative claim something the graph doesn't support, or drop something it must include? |
| 5.8 | **AssessmentReasoner** | JS | Augments assessment with template knowledge. |
| — | *fallback tier 1* | JS | **DeterministicFallbackComposer** — if the slot filler throws, compose the note deterministically at V30 quality. |
| — | *fallback tier 2* | JS | `renderLegacy()` — raw entity rendering. The system always produces *something*. |
| — | **NarrativeDeduplicator** | JS | Removes repeated statements. |
| 5.6b | **StoryCoverageValidator** | JS | Computes `coverage_percent` — what fraction of *critical* entities are represented in the narrative. Drives whether QA runs. |
| 5.7b | **GraphIntegrityValidator** | JS | Orphan nodes, broken edges. |
| 6 | **EncounterIntegrityAgent** | JS | Encounter-level consistency. |
| 7 | **TemplateAssemblyAgent** | JS | Renders the final note — `clinical_story` first, legacy renderer as fallback. |
| — | **ClinicalLanguageFormatter** | JS | Safe post-render normalisation. |
| 8 | **JSValidatorLayer** | JS | Three-way verification: transcript ↔ entities ↔ final note. |
| 9 | **ClinicalQAValidatorAgent** | LLM *(conditional)* | Fires **only if** JS validation failed, recall needs recovery, or coverage failed. Cross-verifies the note against transcript + gold reference. Emits a structured verdict with numeric scores. |
| 10 | **FHIRExporter** | JS | Emits a FHIR bundle from the graph. |

**Read the LLM/JS column again.** Of ~20 stages, only **five** are LLM calls, and two of
those are conditional. Everything else is deterministic JavaScript operating on a typed
graph. That ratio is the entire safety argument of the system.

**Conditional QA is a cost lever**: `"✅ V31 validators passed. Bypassing LLM QA. (Cost
Saved!)"`. On clean cases you pay for 3 LLM calls, not 5.

### 8.3 What comes back

```js
{
  consultId, draftId,
  note,               // schema v2 structured object — the thing that gets scored
  renderedNote,       // the human-readable render
  status,             // guardrail verdict: PASS | FLAGGED | INVALID
  flags[], schemaErrors[], entities[],
  detectedSpecialty,
  qa,                 // QA agent output including _metrics
  trace               // per-agent LLM I/O — only when opts.recordTrace (§14.2)
}
```

---

## 9. The LLM layer

### 9.1 `services/LLMService.js`

One class wraps all model access. Key behaviours:

- **Two backends.** `ai_studio` (default) authenticates with `?key=<GEMINI_API_KEY>` on
  `generativelanguage.googleapis.com`. `vertex` uses `google-auth-library` to mint an OAuth
  token for Vertex AI — the HIPAA-eligible path under a BAA. *Switching is one env var; no
  code changes.*
- **Proxy-first routing.** If `GEMINI_PROXY_URL` is set, calls route through the backend's
  own `/api/llm/generate` — same key, same network path — and only fall back to a direct
  Gemini call on a *connection* error. It even tries both loopback families (`127.0.0.1`
  and `[::1]`) because Node's resolution order differs across machines.
- **Thinking disabled by default** (`thinkingConfig.thinkingBudget = 0`) — these are
  extraction and formatting tasks, not reasoning tasks, and thinking tokens are pure cost.
- **Adaptive retries.** 429/500/502/503/504 retry. A 500 *while a `responseSchema` is
  attached* drops the schema and retries — large response schemas are a known cause of
  provider-side 500s.
- **Long timeouts.** The extraction call can take ~90s, so request/header timeouts are
  disabled on the server and the client timeout defaults to 120s.

### 9.2 `src/proxy.js` — the key-safe passthrough

Mounts `/api/llm/generate`, `/api/llm/stream` (SSE), `/api/asr`, and `/api/llm/diag`. Its
purpose is that the **embedded client app never holds an API key** — it calls our backend,
and the backend holds the credential.

### 9.3 Model configuration

`MODEL_TIERS` resolves `pro` and `flash` from `GEMINI_MODEL` → `GEMINI_MODEL_PRO/FLASH` →
a default. Setting `GEMINI_MODEL` overrides both tiers at once, which is the simplest lever
when a key only has access to certain models.

> **Field note.** A `401 UNAUTHENTICATED / ACCESS_TOKEN_TYPE_UNSUPPORTED` from this API
> almost never means "bad key" — it means the key reaching the URL was empty, malformed, or
> the *model* isn't available to that project. Check `$k.Length` and try a different model
> before regenerating credentials.

---

## 10. The prompt registry

`packages/backend/prompts/registry.js` + `prompts/store/`.

**Layout.** For each agent id:
- `store/<id>.json` — metadata + the live pointer: `agent`, `label`, `stage`,
  `description`, `vars[]`, `active`, `order`, `publishedVersion`, `draft`, and runtime
  config (`freeform`, `maxOutputTokens`, `schema`).
- `store/<id>/v<N>.json` — **immutable** version snapshots.

**Resolution.** `loadPrompt(id, fallback, vars)`:
1. Reads the published version from the store (mtime-cached, so edits are picked up hot
   without a restart).
2. Falls back to the hard-coded prompt string in the agent file if the store has nothing —
   the system runs even with an empty registry.
3. Substitutes `{{token}}` placeholders from `vars`.

**Why versions are immutable.** A run's metrics are only meaningful next to the exact
prompt text that produced them. Publishing writes a new version; nothing is ever edited in
place. Rollback = publish an old version's text as a new version.

**Runtime config per prompt.** `freeform` bypasses the fixed response schema (useful when
an agent should return prose); `maxOutputTokens` raises the ceiling per agent; `schema`
holds an editable output schema appended to the QA agent's instruction. These are edited
from the lab's Prompts tab and take effect on the next run.

Current agent ids: `encounter-classifier`, `observation-extractor`, `fact-recovery`,
`qa-validator`, `diagnosis-preservation`, `negation-normalizer`, `timeline-builder`,
`compression`, `judge-clinical`.

---

## 11. De-identification and the PHI boundary

`src/deid/deidentify.js` exposes three functions:

- `deidentify(text, { mode, nameHints })` → `{ text, map }`. Replaces PHI with tokens,
  returning a **reversible map**. `nameHints` comes from the NER pass — entities labelled
  `PERSON`/`NAME` — so the de-identifier knows what to look for beyond regex patterns.
- `reidentify(value, map)` → walks a structure and restores the original values.
- `mapFingerprint(map)` → a hash of the map, recorded in the audit log so you can prove
  *which* map was used without storing PHI in the audit trail.

The map is persisted encrypted (pgcrypto, keyed by `DEID_ENC_KEY`). **That key must live in
a secret manager, never in the database and never in git** — it is the single thing that
converts de-identified data back into PHI.

De-identification is **skipped automatically when `LLM_BACKEND=vertex`**, because under a
BAA the PHI is permitted to reach the model, and de-identifying would only degrade quality.

The boundary in one sentence: **PHI enters at ingest, is stripped before any external model
call, and is restored only after generation, inside our own systems.**

---

## 12. Schema validation and guardrails

### 12.1 The schema is the contract

`@notera/schema` compiles `note.schema.v2.0.0.json` with Ajv (`allErrors: true`). Every
note must validate. This converts "the model wrote something weird" from a subjective
judgement into a boolean.

### 12.2 Guardrails (`src/validation/guardrails.js`)

- **`crossCheckMeds(note, entities)`** — the highest-value check in the system. Every
  medication the note asserts is compared against medications the independent NER model
  found in the transcript. Anything unsupported is flagged. A model hallucinating a drug is
  the worst failure mode in clinical documentation, and this catches it with a second,
  non-LLM opinion.
- **`checkEmptySections(note)`** — structurally valid but empty is still a bad note.
- **`checkConfidence(note, threshold)`** — low-confidence fields get flagged for human
  attention.
- **`runGuardrails(...)`** aggregates into `{ note, status, flags[], schemaErrors[] }`
  where status is `PASS | FLAGGED | INVALID`.

Flags carry a severity so the review UI can rank them.

---

## 13. Flow C — the evaluation harness

`eval/run_eval.mjs`. This is what "quality" means operationally.

### 13.1 The loop

```
for each fixture in data/gold/*.txt (or the subset named on argv):
    split the file at the first /^Subjective:/ →  transcript | gold note
    result = generateNote({ transcript, referenceNote: gold }, { persist:false, recordTrace })
    score  = scoreNote({ note, noteText, goldText, entities })
    merge  result.qa._metrics  as  qa_<name>
    write  <id>.json  (score + note + flags)
    write  <id>.md    (side-by-side human report)
    mirror everything into the lab DB
aggregate() → scorecard → _summary.json + _history.jsonl + latest.txt
```

### 13.2 The metrics, precisely

| Metric | Definition | Interpretation |
|---|---|---|
| `schema_valid` | Ajv validation of the note | Boolean gate. A false here invalidates everything else. |
| `section_coverage` | present / total of the CORE required fields | Did we fill the note out at all? |
| `similarity_to_gold` | **Jaccard index** over lowercase alphanumeric token *sets*: `\|A∩B\| / \|A∪B\|` | Lexical overlap with the expert note. Blunt but unbiased. |
| `omission_rate` | of gold tokens longer than 3 chars, the fraction absent from our note | **The recall metric that matters clinically** — what did we *drop*? |
| `story_flow` | `0.7 × (good lines / total lines) + 0.3 × min(avgWords/6, 1)` | Does it read as prose? A "good" line has ≥3 words after the label, isn't boilerplate (`n/a`, `none`, `not mentioned`), isn't vague, and has no doubled label/word. |
| `med_grounding` | `1 − unsupported/checked` against NER | Hallucinated-medication detector. `null` when NER is offline. |
| `qa_*` | every numeric leaf of the QA agent's JSON output, dotted (`qa_scores.structure`) | Whatever you define in the QA prompt's schema. |

`aggregate()` averages these across fixtures and — importantly — **discovers `qa_*` keys
dynamically**, emitting `avg_qa_<name>`. Add a score to the QA prompt's schema and it
appears on the trend chart with no code change.

**Honest characterisation of these metrics.** `similarity_to_gold` and `omission_rate` are
bag-of-words measures. They cannot tell a correct paraphrase from a wrong one, and a note
can score well while being clinically wrong. They are *regression detectors*, not quality
certificates — their value is that they're cheap, deterministic, and move when you break
something. The LLM-based comparison (§14.5) exists precisely because these are insufficient
on their own.

---

## 14. Flow D — the Testing Lab

### 14.1 Starting a run

The Run tab posts `/api/runs { fixtures[] }`. The handler `startRun()`:
- spawns `node eval/run_eval.mjs <fixtures…>` with `cwd` = repo root,
- pipes stdout/stderr into (a) a log file in `admin/data/logs/<runId>.log`, (b) an
  in-memory ring buffer capped at 5000 lines, (c) every attached SSE listener,
- sniffs the output for `run_<timestamp>` to learn the result directory,
- persists run history to `admin/data/runs.json`.

### 14.2 Capturing agent I/O

This is the mechanism that makes the lab more than a log viewer.

When `generateNote` is called with `recordTrace: true`, it **monkey-patches
`generateContent` on the LLM service instance** before running the pipeline. Every call is
recorded: `{ agent, seq, systemInstruction, userPrompt, responseSchema, output, status,
error, latency_ms, model }`.

Attribution works because `PipelineEngine` sets `this.llmService._agent = '<agent-id>'`
immediately before each agent executes. The wrapper reads that tag. Total instrumentation
cost: five one-line assignments in the engine and one wrapper in the orchestrator — no agent
was modified.

The eval harness then writes each trace entry as an `agent_runs` row.

### 14.3 Live logs: SSE with a polling fallback

`GET /api/runs/:id/stream` is Server-Sent Events. Streaming through a dev proxy is
notoriously fragile, so the implementation is defensive on both ends:

- **Server:** `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no`, an immediate `flushHeaders()`, an initial `: open` comment to
  force the first flush, and a `: ping` heartbeat every 15s. Backlog is replayed on connect
  so a late subscriber sees the whole run.
- **Client (`useRunStream`):** opens the EventSource *and* starts a 1s poll of
  `/api/runs/:id` (whose response carries the full line buffer). The poll no-ops the moment
  SSE proves alive, and stops when the run ends.

The result: live output is guaranteed regardless of proxy buffering behaviour.

### 14.4 Rerunning a single agent

Two modes, because they answer different questions:

- **`single`** — replay *this agent's stored call*: take `system_prompt` (or an override)
  and the stored `input.userPrompt`, call the model, append a new `agent_runs` row with
  `rerun_of` set and `attempt` incremented. For the QA agent it also recomputes the `qa_*`
  metrics for that record. This answers *"does my prompt edit change this agent's output on
  identical input?"* in seconds, with zero pipeline cost.
- **`downstream`** — launch a fresh single-patient eval run. Because the pipeline is a
  monolithic sequence, partial resumption isn't possible; re-running the whole patient
  necessarily includes the chosen agent and everything after it, with current prompts. This
  answers *"what does my change do to the final note?"*

The Prompts tab additionally offers **"↻ Rerun on latest"**, which applies `single` mode
across every patient of the most recent run — the fast iteration loop for tuning the QA
validator.

### 14.5 The LLM comparison

Beyond the bag-of-words metrics, Results offers an on-demand **Comparison & scores** panel.
It sends the generated note and the gold note to the same Gemini engine with a comparator
prompt, and gets back structured JSON: `overall_score`, `verdict`, per-dimension scores
(ours vs gold), `notera_missing[]`, `notera_extra[]`, `key_differences[]`, `summary`.

Results are **cached per fixture** (`<fixture>.compare.json`), and an **Auto** toggle
generates one for every note you open.

### 14.6 The dashboard

The Metrics tab reads the DB (not files) through `/api/lab/*`:

- **KPI cards** — latest run's averages with Δ vs the previous run, sign-aware (for
  `omission_rate`, down is good).
- **Trend across runs** — multi-metric lines with per-metric toggles; `qa_*` keys appear
  automatically.
- **Fixture heatmap** — patient × metric, colour-scaled red→green (inverted for
  lower-is-better keys). Clicking a cell opens that exact note vs gold.
- **Per-agent stats** — calls, errors, avg latency, avg tokens, from `v_agent_stats`.
- **Run-vs-run compare** — pick A/B, see per-metric deltas with regressions in red.

### 14.7 Importing reference cases

`POST /api/patients/import` accepts a JSON array of sessions (transcript + SOAP note).
For each it upserts a patient and — for batches under `ADMIN_MAX_FIXTURES` — writes
`data/gold/<slug>.txt` so the case becomes immediately runnable.

Scale handling worth noting: the body limit is `ADMIN_MAX_BODY_MB` (default 512) and
exceeding it returns a **413**, not a dropped socket; upserts run with bounded concurrency
(`ADMIN_IMPORT_CONCURRENCY`, default 8, under the pg pool max of 10); and very large batches
skip fixture-writing so they don't flood the run selector with thousands of files.

---

## 15. Frontend architecture

### 15.1 The shared design system (`@notera/ui`)

One package owns the visual language: Tailwind preset, shadcn HSL CSS-variable tokens for
light and dark, primitives (Button, Card, Badge, Input/Textarea, Tabs, Dialog, Tooltip,
Skeleton/EmptyState), and generic blocks (ThemeProvider, a presentational Login).

Apps consume it via `@notera/ui/components/...` and extend the preset. There is exactly one
place to change a colour or radius. `transpilePackages: ['@notera/ui']` lets Next compile it
straight from TypeScript source — no build step for the package.

The `Login` block is **presentational only** (`onSubmit(password)`, plus title/subtitle/
footer props), which is why the same component serves both the clinician screen and the lab
gate.

### 15.2 Theme scoping

The root layout is deliberately **theme-neutral** — just `<html><body>`. Each route group
imports its own stylesheet:

- `(app)/layout.tsx` → the original white `globals.css` + `AuthProvider` + `TopBar`.
- `(admin)/layout.tsx` → `@notera/ui/globals.css` + `Providers` + a `.dark` wrapper.

Next code-splits CSS per route, so the two themes never fight.

### 15.3 The admin SPA

`AdminApp.tsx` is a client shell: auth gate → sidebar + topbar + command palette, with tab
state persisted to `localStorage` and screens rendered by tab. It's loaded via
`dynamic(..., { ssr: false })` because it reads `localStorage` in `useState` initialisers —
which would throw during server rendering. Disabling SSR for a pure client console is the
correct trade, not a workaround.

`lib/api.ts` is the single typed client. Every path is prefixed `/backend`, which the Next
rewrite forwards to Express.

### 15.4 The seven lab screens

`overview` (health + recent runs) · `run` (fixture selection + live logs) · `patients`
(import, list, delete) · `results` (note vs gold, diff, comparison, source transcript) ·
`metrics` (the dashboard) · `prompts` (edit/publish/version/rerun) · `judge` (gates and the
editable judge prompt).

---

## 16. Configuration and environment

Everything reads the repo-root `.env`. Three independent loaders exist (backend, eval, db
scripts) and all follow the same hardened rules: split on `\r?\n`, strip quotes, strip stray
`\r`, `.trim()`, and override values that are undefined **or empty**.

> That last rule exists because of a real failure: a CRLF `.env` produced
> `GEMINI_API_KEY=AIza…\r`, and a stale empty shell variable silently won over the file
> value. Both surfaced as an opaque 401.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | AI Studio key |
| `GEMINI_MODEL` | Overrides both model tiers at once |
| `LLM_BACKEND` | `ai_studio` \| `vertex` |
| `GEMINI_PROXY_URL` | Route LLM calls through the backend proxy |
| `DATABASE_URL` | Postgres connection |
| `STORE_BACKEND` | `postgres` \| `firestore` \| `memory` |
| `DEID_ENC_KEY` | pgcrypto key for the de-id map — **secret manager only** |
| `ADMIN_PASSWORD` | Lab gate (default `notera`) |
| `BACKEND_URL`, `BACKEND_SERVICE_TOKEN` | BFF → backend |
| `NER_URL` | NER sidecar |
| `ADMIN_MAX_BODY_MB`, `ADMIN_MAX_FIXTURES`, `ADMIN_IMPORT_CONCURRENCY` | Import scale limits |

---

## 17. Security model

**Layer 1 — the browser never holds secrets.** The service token and API keys live only in
the backend. `'server-only'` on `backend.ts` makes leaking them a build error.

**Layer 2 — the backend is private.** In production it sits behind Cloud Run IAM; the BFF
mints a Google-signed ID token to call it. In dev, a bearer token.

**Layer 3 — PHI never reaches an external model** under `ai_studio`. De-identify before,
re-identify after. Under `vertex` + BAA, that hop is permitted and the step is skipped.

**Layer 4 — the de-id map is encrypted at rest** with a key held outside the database.

**Layer 5 — audit trail.** Consult creation, de-identification (by map fingerprint, not
content), draft creation, viewing, and approval are all recorded.

**Layer 6 — separate auth for the lab.** Password → server-side session cookie, checked on
every `/api/*` admin route.

**Honest gaps.** Clinician auth is currently a localStorage mock — real Firebase Auth is
the drop-in. The lab uses a single shared password with no per-user identity. Neither is
suitable for production PHI without being replaced.

---

## 18. Operational runbook

**First run**
```bat
npm install
npm run db:up            :: Postgres in docker
npm run db:reset         :: backup → drop old schemas → create lab → backfill
npm run dev              :: backend :8080 + Next :3000 together
```
Then `http://localhost:3000` (product) and `/admin` (lab, password `notera`).

**Daily**: `npm run db:up` then `npm run dev`.
**Verify without infra**: `npm run db:test` — 16 pure-logic assertions, no DB or LLM.
**Run the eval from the CLI**: `npm run eval` (or `node eval/run_eval.mjs patient1 --limit 3`).

**Diagnostics**
- Model refuses with 401 → check key length (39 for AI Studio) and try another model.
- `db:reset` connection refused → container not healthy yet; wait for `healthy`.
- Import dies mid-upload → you're over `ADMIN_MAX_BODY_MB`; you'll now get a 413.
- Lab dashboard empty → runs mirror to the DB only when `STORE_BACKEND=postgres` and
  `DATABASE_URL` are set; otherwise file results still exist under `eval/results/`.

---

## 19. Design decisions and their rationale

**Why one long pipeline function instead of a plugin architecture?**
The order of operations *is* the clinical algorithm. Making it configurable would let
someone reorder de-identification after generation. Explicit sequence, explicit fallbacks.

**Why so much deterministic JS between LLM calls?**
Every JS stage is a place where an LLM error can be *caught* rather than propagated. The
LLM proposes; JavaScript disposes.

**Why three fallback tiers for the narrative?**
A clinician mid-consultation cannot be told "generation failed." Slot filler → deterministic
composer → raw entity render. Quality degrades; availability doesn't.

**Why is the reference corpus files-on-disk *and* database rows?**
Files make a fixture runnable and diffable in git. Rows make it queryable and joinable to
metrics. The import writes both, and drops the file half at scale where it stops being
useful.

**Why normalized metrics?**
So that adding a score to a prompt requires no migration and no code change.

**Why capture agent I/O at the LLM-service boundary rather than inside each agent?**
One wrapper instruments twenty agents. Adding an agent requires no instrumentation work.

**Why did the admin UI move from a Vite SPA into Next?**
One app, one dependency tree, one design system, one dev command — and the clinician side
keeps its server-only PHI boundary, which a pure SPA cannot provide.

---

## 20. Known limitations and future work

1. **Auth is a mock.** `AuthProvider` is localStorage-based; the lab uses one shared
   password. Both are interface-compatible with real implementations.
2. **Lexical metrics are blunt.** Jaccard similarity cannot judge clinical correctness. The
   LLM comparison partially compensates; a clinician-rated rubric would be better.
3. **`downstream` rerun re-runs the whole patient.** True mid-pipeline resumption would
   require the engine to be checkpointable.
4. **Deleting a patient rewrites history.** Cascades remove its metrics from past run
   averages. An archive flag would preserve history.
5. **The product store in dev is in-memory.** Consults vanish on restart unless
   `STORE_BACKEND=postgres`.
6. **NER is optional and silently degrades.** Without it, `med_grounding` is `null` — the
   single most valuable guardrail is off. This should be loud, not silent.
7. **No per-user attribution in the lab.** Every action is "the admin."
8. **Single-tenant assumptions throughout** — no org/tenant isolation.

---

## 21. Glossary

| Term | Meaning |
|---|---|
| **Gold note** | The expert-written reference SOAP note for a fixture. The scoring target. |
| **Fixture / patient / reference case** | A frozen (transcript, gold note) pair. |
| **Record** | One `run × patient` row — a generated note plus its verdict. |
| **Agent** | One stage of the pipeline. May be an LLM call or pure JS. |
| **Slot filler** | The narrative agent — fills a fixed template's slots from the fact graph rather than writing free-form. |
| **Coverage** | Fraction of *critical* extracted entities represented in the narrative. |
| **Guardrail** | A post-generation check producing severity-tagged flags. |
| **Grounding** | Verifying a claim against an independent source (NER, the fact graph). |
| **Trace** | The recorded sequence of LLM calls for one generation. |
| **BFF** | Backend-for-frontend — Next route handlers that proxy to Express and hold the token. |
| **Flywheel** | Clinician draft→final edits captured as future training signal. |

---

## Appendix A — file-by-file index

**Engine (`packages/backend/src/`)**

| File | Responsibility |
|---|---|
| `orchestrator/generateNote.js` | The 8-stage orchestrator; installs the trace recorder. |
| `orchestrator/structureNote.js` | `clinical_story` → schema v2; LLM structurer fallback. |
| `orchestrator/heidiStoryEngine.js` | Full-transcript narrative composition pass. |
| `orchestrator/heidiNarrative.js` | Lighter narrative polish fallback. |
| `orchestrator/reconcileNote.js` | Deterministic placement/consistency fixes. |
| `pipeline/PipelineEngine.js` | The explicit stage sequence; tags `_agent` for tracing. |
| `pipeline/agents/*.js` | The agents (see §8.2 table). |
| `pipeline/agents/engines/*.js` | Deterministic transformation engines. |
| `pipeline/agents/engines/templates/*.js` | Per-specialty note templates. |
| `pipeline/utils/safeParseJson.js` | Tolerant JSON parsing of model output. |
| `services/LLMService.js` | All model access: auth, retries, fallbacks. |
| `proxy.js` | Key-safe `/api/llm/*`, `/api/asr` passthrough. |
| `deid/deidentify.js` | De-identify / re-identify / fingerprint. |
| `ner/nerClient.js` | NER sidecar client; degrades gracefully. |
| `validation/guardrails.js` | Med cross-check, empty sections, confidence. |
| `asr/transcribe.js` | Google Speech medical transcription. |
| `firestore/store.js` | Pluggable product store (postgres/firestore/memory). |
| `db/pool.js` | pg pool, `query`/`one`/`tx`/`withSession`. |
| `db/labStore.js` | All lab-schema data access. |
| `db/labUtils.js` | Pure helpers (`slugify`, `sha256`) — importable without pg. |
| `admin/handler.js` | The entire lab API as a mountable handler. |
| `config.js`, `loadEnv.js` | Config resolution and the hardened `.env` loader. |

**Frontend, data, and tooling** — see §4; each entry there states its responsibility.

---

## Appendix B — complete API surface

**Product (Express, via the Next BFF)**
```
GET    /healthz
POST   /api/consults                    create + generate a note
GET    /api/consults                    list
GET    /api/consults/:id                fetch one
POST   /api/consults/:id/approve        sign off (writes final + feedback diff)
POST   /api/llm/generate | /api/llm/stream | /api/asr | GET /api/llm/diag
```

**Lab (Express admin handler, via `/backend/*`)**
```
POST   /api/login          GET /api/session          POST /api/logout
GET    /api/scripts                       available fixtures
POST   /api/runs                          start a run
GET    /api/runs                          run history
GET    /api/runs/:id                      one run (carries the line buffer)
GET    /api/runs/:id/stream               SSE live logs
POST   /api/runs/:id/kill

GET    /api/results/runs                  result directories
GET    /api/results/:dir/files            fixtures in a run
GET    /api/results/file?dir=&name=       one result document
GET    /api/results/diff?a=&b=&name=      cross-run diff
GET    /api/results/transcript?name=      original source transcript
GET  / POST /api/results/compare          cached LLM note-vs-gold comparison
DELETE /api/results/:dir                  delete a run

GET    /api/patients                      list reference cases
POST   /api/patients/import               bulk import sessions
DELETE /api/patients/:id                  delete one (cascades)

GET    /api/prompts | /api/prompts/:id | /:id/version/:v | /:id/logs
PUT    /api/prompts/:id                   save draft
POST   /api/prompts/:id/publish | /revert | /config

GET    /api/lab/runs | /trend | /compare?a=&b=
GET    /api/lab/run/:id/metrics | /agents | /heatmap
GET    /api/lab/run/:id/patient/:pid/agents
GET    /api/lab/agent-run/:id
POST   /api/lab/rerun-agent               { patientId, agentId, mode, promptOverride }
POST   /api/lab/rerun-latest              { agentId, promptOverride }

POST   /api/judge/run                     run the editable judge prompt
GET    /api/sessions | /api/sessions/file
```

---

*End of document. If something here disagrees with the code, the code is right — and this
file should be corrected.*
