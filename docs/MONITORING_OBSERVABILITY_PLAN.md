# Notera — Monitoring & Observability Plan
### `monitor.aitoolsfordoctor.com` · error logging · per-account token accounting · audio safety · "historical debugging"

> **Status: plan, not built.** This is the blueprint. It's designed to sit *on top of the hooks you
> already have* (`LLMService.getTokenUsage()`, `generateNote`'s `tokenUsage` + `clinicianId`, the
> `clinical.consults` table, and `audit()`), so most of it is wiring, not new machinery.

---

## 0. What you asked for → what this delivers

| Your ask | Delivered by |
|---|---|
| Safety rule: audio starts by mistake / left on → no transcript for ~2 min | **§2 Audio safety rule** (client auto-stop + server guard + logged event) |
| A monitoring panel on its own subdomain | **§5 `monitor.` subdomain** (admin-only dashboard) |
| Error logging *separately*, with time, for the LLM pipeline | **§3 `ops.errors` table** + **§5.1 Error panel** |
| Tokens used **per account** | **§3 `ops.pipeline_runs`** + **§5.3 Per-account usage & cost** |
| Account-wise logs | Everything keyed by `clinician_id` (your existing user id) |
| "IntelliTrace / historical debugging" (Sentry / rrweb / Highlight style) | **§6** — with an important **PHI caveat** and a safe design |
| Industry-standard, real-world, proper logic | OpenTelemetry-aligned model, SLOs, retention, RBAC (**§7–8**) |

---

## 1. Guiding principles (read first)

1. **PHI changes everything.** This is a clinical app. Transcripts, notes and audio are PHI. Any monitoring
   that stores or *replays* content must treat it as PHI: encrypted, access-controlled, retention-bounded,
   and never sent to a third-party SaaS without a BAA. This single rule kills several "obvious" choices
   (hosted Sentry, hosted Highlight, naive session replay) — see §6.
2. **Build the app-specific layer; adopt the generic layer.** Your highest-value signals (per-account
   tokens/cost, pipeline errors, agent timings) are *your data* — build them natively on Postgres
   (you already emit them). For generic uncaught JS/Node exceptions with stack traces, adopt a small
   self-hosted tool rather than reinventing it (§6).
3. **Instrument once, at the seams you already have.** `LLMService`, `generateNote`, the ASR proxy, and
   the auth layer are the four choke points. Don't scatter logging everywhere.
4. **Fail open.** Monitoring must never break note generation. Every write is wrapped in try/catch and
   fire-and-forget.

---

## 2. Audio safety rule — "mic left on / no speech"

**Problem:** a clinician taps Start, walks away (or it starts by accident), and the mic runs for minutes
recording silence — wasting ASR spend, VM CPU, and producing an empty/garbage note.

**Design — three layers of defence:**

### 2.1 Client (fastest, cheapest) — in `Scribe.tsx`
- **Voice-activity + empty-transcript watchdog.** You already send 20s segments. Track two counters while
  `phase === 'recording'`:
  - `msSinceLastText` — reset whenever a segment returns non-empty transcript text.
  - `emptySegments` — incremented when a segment returns empty/whitespace.
- **Rule:** if `msSinceLastText ≥ 120_000` (2 min) **or** `emptySegments ≥ 6` consecutive (≈2 min of 20s
  chunks with nothing), then:
  1. auto-stop recording,
  2. show a non-alarming toast: *"Recording stopped — we didn't pick up any speech for 2 minutes. Nothing was saved."*,
  3. discard the empty audio (don't upload), and
  4. POST a lightweight event to `/backend/api/ops/audio-event` (§3.3) with `reason: "silence_timeout"`.
- **Also cap total runaway length**: hard stop at e.g. `AUDIO_MAX_MINUTES` (default 45) regardless, with a
  10s "still recording?" confirm prompt at 30 min.

### 2.2 Server (authoritative) — in `proxy.js` ASR path
- When a segment transcribes to **empty** (`transcript.trim() === ''`), return `{ text: '', empty: true }`
  and **log an `ops.audio_events` row** (`reason: "empty_segment"`).
- Track per-consult empty-streak server-side too (in case the client misbehaves); after N empty segments,
  return `{ text:'', stop:true }` so the client stops.
- **Never run the LLM pipeline on an empty transcript.** In `POST /api/consults[/async]`, if the assembled
  transcript is empty/whitespace, short-circuit with a 422 + an `ops.audio_events` row — this is the real
  cost saver (no Gemini calls, no wasted run).

### 2.3 Config (env)
```
AUDIO_SILENCE_TIMEOUT_MS=120000   # 2 min no-text → auto-stop
AUDIO_EMPTY_SEGMENTS_MAX=6        # consecutive empty 20s chunks
AUDIO_MAX_MINUTES=45              # hard cap
```

**Logged as an event, not an error** (it's expected user behaviour), but it shows up in the monitor's
"Audio events" panel so you can see how often it happens.

---

## 3. Data model — a new `ops` schema in Postgres

Three tables. All fire-and-forget writes; all keyed by `clinician_id` for account-wise views.

### 3.1 `ops.pipeline_runs` — one row per note generation
```sql
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.pipeline_runs (
  run_id         BIGSERIAL PRIMARY KEY,
  consult_id     TEXT,
  clinician_id   TEXT,                 -- the account (FK-ish to auth.users)
  model          TEXT,                 -- e.g. gemini-3.7-flash
  status         TEXT,                 -- 'ok' | 'error' | 'partial' | 'empty_transcript'
  duration_ms    INTEGER,
  transcript_chars INTEGER,
  note_chars     INTEGER,
  prompt_tokens  INTEGER,
  output_tokens  INTEGER,
  total_tokens   INTEGER,
  est_cost_usd   NUMERIC(10,5),        -- computed from a price table (§5.3)
  per_agent      JSONB,                -- getTokenUsage().perAgent  {agent:{prompt,output,total,calls}}
  timings        JSONB,                -- per-agent ms {extractor: 34111, ...}
  error_id       BIGINT,               -- → ops.errors.error_id if status=error
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON ops.pipeline_runs (clinician_id, created_at DESC);
CREATE INDEX ON ops.pipeline_runs (status, created_at DESC);
```

### 3.2 `ops.errors` — the separate error log
```sql
CREATE TABLE IF NOT EXISTS ops.errors (
  error_id     BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ DEFAULT now(),
  source       TEXT,        -- 'pipeline' | 'asr' | 'api' | 'frontend' | 'auth'
  agent        TEXT,        -- which pipeline agent, if any (observation-extractor, ...)
  level        TEXT,        -- 'error' | 'warn'
  code         TEXT,        -- e.g. 'GEMINI_400', 'GEMINI_429', 'ASR_TIMEOUT'
  message      TEXT,
  stack        TEXT,        -- redacted (§8)
  consult_id   TEXT,
  clinician_id TEXT,
  context      JSONB,       -- model, latency, request id — NO PHI
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON ops.errors (ts DESC);
CREATE INDEX ON ops.errors (source, code, ts DESC);
CREATE INDEX ON ops.errors (clinician_id, ts DESC);
```

### 3.3 `ops.audio_events` — the safety-rule log
```sql
CREATE TABLE IF NOT EXISTS ops.audio_events (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ DEFAULT now(),
  consult_id   TEXT,
  clinician_id TEXT,
  reason       TEXT,        -- 'silence_timeout' | 'empty_segment' | 'max_length' | 'empty_transcript'
  duration_ms  INTEGER,
  meta         JSONB
);
CREATE INDEX ON ops.audio_events (ts DESC);
```

> Retention: a nightly job deletes rows older than `OPS_RETENTION_DAYS` (default 90). Errors/usage are
> operational metadata, not the medical record — keep them short.

---

## 4. Instrumentation — the 4 hook points (minimal, centralized)

1. **`LLMService`** — already emits `getTokenUsage()`. Add a per-call error emitter: on a thrown Gemini
   error, call `ops.recordError({source:'pipeline', agent:this._agent, code, message, stack})` *before*
   rethrowing. (One line in the existing catch.)
2. **`generateNote`** — you already compute `tokenUsage` and have `clinicianId`, `consultId`, timings, and
   a top-level try/catch. At the end (success **or** catch), write **one** `ops.pipeline_runs` row. This is
   the single most valuable hook — it powers per-account tokens, cost, timings, and error rate.
3. **`proxy.js` (ASR)** — write `ops.audio_events` on empty/timeout; write `ops.errors(source:'asr')` on ASR
   failures (you already `console.error` these).
4. **Frontend** — a tiny error boundary + `window.onerror`/`unhandledrejection` handler POSTing to
   `/backend/api/ops/client-error` (message, stack, route, **no** DOM/PHI). Plus the audio-event POST (§2).

All writes go through one helper module `src/ops/opsLog.js` (`recordRun`, `recordError`, `recordAudioEvent`)
so instrumentation is one import, and it's a no-op if `OPS_LOGGING=0`.

---

## 5. The `monitor.` subdomain — dashboard

**Hosting:** same Next app, a new route group `(monitor)` served on `monitor.aitoolsfordoctor.com` via the
existing host-split `middleware.ts` (add a host branch, exactly like the apex→`/marketing` rule).
**Auth:** admin-only. Reuse the session cookie + a `role='admin'` gate (you already check `req.user.role`).
Non-admins get 404 (like the current admin surface). It reads from the `ops.*` tables via
`/backend/api/ops/*` endpoints (admin-gated).

### 5.1 Error log panel (the "separately logged errors")
- Live table from `ops.errors`: **time · source · code · agent · message · account · consult**.
- Filters: source (pipeline/asr/api/frontend), code (GEMINI_429, GEMINI_400, ASR_TIMEOUT…), account, time range.
- Click a row → detail drawer: full (redacted) stack, context JSON, and a link to the `pipeline_run` it
  belongs to (so an error is one click from its full run trace).
- "Report time" = the `ts` column, shown in your timezone + relative ("3m ago").

### 5.2 Pipeline runs & timings panel
- Table from `ops.pipeline_runs`: time · account · model · status · duration · total tokens · cost.
- Expand a run → the **per-agent breakdown** (`per_agent` + `timings`) as a bar — this is your existing
  admin token chart, now per-run and historical. This is the "what happened in this run" trace (the
  closest honest version of IntelliTrace for your pipeline — see §6).
- Aggregate strip on top: runs today, error rate %, P50/P95 duration, tokens today, spend today.

### 5.3 Per-account tokens & cost panel  ← the headline ask
- `GROUP BY clinician_id`: per account → runs, total tokens (prompt/output), **estimated $ cost**, avg
  duration, error rate, last active.
- **Cost** = tokens × a small **price table** kept in config/DB (`ops.model_prices`), e.g.
  `gemini-3.7-flash: {in: 0.75, out: 3.75}` per 1M — so the number updates when Google's pricing changes.
- Add **ASR cost** per account too (minutes of audio × STT rate) for true unit economics — pull minutes
  from `ops.audio_events`/consult duration.
- Time range selector (today / 7d / 30d) + CSV export for billing.

### 5.4 Audio events panel
- From `ops.audio_events`: how often mics are left on, empty segments, max-length hits — per account and
  over time. Lets you spot a user with a broken mic or a UX problem.

---

## 6. "Historical debugging" (Sentry / Datadog RUM / rrweb / Highlight) — the honest answer

You referenced IntelliTrace and session-replay tools. Here's the real-world call for a **clinical** app:

### 6.1 The PHI wall (must read)
Full **DOM session replay** (rrweb, Highlight, Datadog RUM replay) records the screen — which in your app
means **patient names, transcripts and notes = PHI**. Recording and storing that is a HIPAA exposure, and
sending it to any hosted service without a signed BAA is a violation. **So: no hosted Sentry/Highlight/
Datadog for replay, and no un-masked replay at all.** This is non-negotiable for a medical product.

### 6.2 What to actually adopt (tiered)

| Layer | Recommendation | Why |
|---|---|---|
| **Your pipeline "trace"** | **Build it** (§5.2) — `ops.pipeline_runs` *is* your historical debugger for note generation: every run's agents, tokens, timings, and the error that killed it, replayable from the DB. | It's your data, PHI-controlled, and you already emit it. |
| **Uncaught exceptions (JS + Node) with stack traces** | **GlitchTip, self-hosted** | Sentry-SDK-compatible, **runs in ~512MB RAM** (fits your VM), drop-in SDK for Next + Express, source maps, breadcrumbs. The lightweight, non-deprecated choice. |
| **Self-hosted Sentry** | ❌ Avoid | 40+ containers, 16GB+ RAM — wrong for your single VM. |
| **Highlight.io** | ❌ Avoid for now | Standalone deprecated Feb 2026 (folded into LaunchDarkly); OSS is in maintenance-only. Don't build on it. |
| **Session replay (rrweb)** | ⚠️ Only if you truly need it, **fully masked** | If you ever add it: rrweb self-hosted with `maskAllInputs: true`, `maskAllText: true`, block the note/transcript containers entirely — you get *interaction* replay (clicks/nav) with **no content**. Still a compliance review item. Default: **skip it**; the pipeline trace + GlitchTip cover 95% of real debugging needs without the PHI risk. |

### 6.3 Standard alignment
Model the pipeline trace on **OpenTelemetry GenAI semantic conventions** (span per agent: model, input/output
token counts, latency; prompts stored as *span events* you can drop, never as attributes). Even if you don't
run a full OTel collector day one, following the shape means you can export to one later without rework.

---

## 7. Alerting & SLOs

Define thresholds and alert (email/Slack webhook) when breached:
- **Error rate** > 2% of runs in 15 min → alert (catches a model outage / 400 storm like the flash-lite one).
- **Latency** P95 run duration > 150s → alert (catches Vertex throttling).
- **Cost spike** > 2× the trailing-7d daily token baseline → alert (catches a runaway loop or abuse).
- **ASR empty-rate** > 20% of segments → alert (mic/UX problem).
- **429 rate** climbing → alert (Vertex quota — the thing you hit before).

A single cron (`ops.checkAlerts`) every 5 min queries `ops.*` and fires a webhook. No extra infra.

---

## 8. Security, privacy & compliance

- **Admin-only**, session-gated, on its own subdomain; 404 for everyone else.
- **No PHI in `ops.*`.** Store IDs, counts, codes, timings — never transcript/note text. Stacks are
  regex-redacted (strip anything that looks like a name/quote) before insert.
- **Encryption at rest** (Postgres volume) + TLS in transit (already via Cloudflare).
- **Retention** `OPS_RETENTION_DAYS=90`, nightly purge.
- **RBAC**: even among admins, gate the per-account cost export behind a stronger check if you add non-eng admins.
- **Audit** access to the monitor itself (who viewed what) via your existing `audit()`.

---

## 9. Phased rollout (build order)

- **Phase 1 — Safety + capture (1–2 days).** `ops` schema + `opsLog.js`; wire `generateNote` run row and the
  empty-transcript short-circuit; audio safety rule in `Scribe.tsx` + `proxy.js`. *Immediate cost/UX win,
  no UI yet.*
- **Phase 2 — Monitor dashboard (2–3 days).** `(monitor)` route group + host split; `/api/ops/*` admin
  endpoints; Error, Runs, Per-account panels (§5.1–5.3). *Now you can see everything.*
- **Phase 3 — Alerts + audio panel (1 day).** `ops.checkAlerts` cron + webhook; audio-events panel.
- **Phase 4 — Exceptions (1 day).** Stand up **GlitchTip** (docker-compose service), add the SDK to Next +
  Express. *Generic crash reporting with stack traces.*
- **Phase 5 (optional/defer).** OTel collector export; masked rrweb only if a real debugging need survives
  Phases 1–4 (it usually won't).

---

## 10. Ops footprint & cost

- **Postgres tables**: negligible (you already run Postgres). Add indexes as above; 90-day retention keeps
  it tiny.
- **monitor subdomain**: no new server — same Next app + a DNS record + a Cloudflare custom domain.
- **GlitchTip**: one small container (~512MB) on the same VM or a tiny separate one; its own Postgres/redis
  (compose bundles them). Bump the VM to `e2-medium` if RAM gets tight.
- **No SaaS bill, no PHI leaving your infra.**

---

## Appendix A — API surface (admin-gated, under `/api/ops`)
```
GET  /api/ops/summary?range=7d           → cards: runs, error%, P50/P95, tokens, spend
GET  /api/ops/errors?source=&code=&clinician=&range=   → error log (paged)
GET  /api/ops/runs?clinician=&status=&range=           → pipeline runs (paged)
GET  /api/ops/accounts?range=30d         → per-account tokens/cost/error-rate
GET  /api/ops/audio?range=7d             → audio safety events
POST /api/ops/client-error               → frontend error intake (no PHI)
POST /api/ops/audio-event                → audio safety event intake
```

## Appendix B — the one helper (`src/ops/opsLog.js`) signatures
```js
recordRun({ consultId, clinicianId, model, status, durationMs, transcriptChars, noteChars,
            tokenUsage /* getTokenUsage() */, timings, errorId })
recordError({ source, agent, level, code, message, stack, consultId, clinicianId, context })
recordAudioEvent({ consultId, clinicianId, reason, durationMs, meta })
checkAlerts()   // cron, every 5 min
```
Each is `try/catch`-wrapped and returns fast; `OPS_LOGGING=0` disables all of it.

---

### TL;DR
Build a thin `ops` layer on Postgres off your **existing** token/timing/clinician hooks → surface it on an
**admin-only `monitor.` subdomain** (errors, per-account tokens & cost, pipeline traces, audio events);
add the **audio silence safety rule** to stop wasted runs; adopt **GlitchTip** (light, self-hosted) for
generic stack traces; and **skip PHI session-replay** — your pipeline-run trace is the compliant version of
"historical debugging."
