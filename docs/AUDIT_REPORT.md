# Notera audit: note-generation latency, cascades, long-recording ASR

Scope: read-only review of `packages/backend`, `apps/web/app/(app)/app/Scribe.tsx`, `Caddyfile`, `docker-compose.prod.yml`.
Baseline: commit `6caccf1` (model default `gemini-3.5-flash`), repo `.env.production`.
Caveat: the repo `.env.production` may differ from the VM. Items marked **[verify on VM]** depend on that.

Env flags in the repo `.env.production` that shape the real pipeline:
- `NOTE_TIGHTENER`, `ENCOUNTER_CLASSIFIER`, `RXNORM_VERIFY`, `GEMINI_THINKING_LEVEL`, `LLM_TIMEOUT_MS` and `GEMINI_PROXY_URL` are all unset.
- So the tightener, the LLM classifier and RxNorm are OFF.
- Thinking is sent as `thinkingBudget: 0`.
- Calls go direct to Vertex `global` (no proxy hop).
- `HALLUCINATION_REMOVER=1` and `SEMANTIC_DEDUPE=1` are ON.
- `ASR_MODEL=medical_conversation` (`.env.production:32`), which is NOT chirp. See section 3.

---

## 1. Pipeline map

### 1.1 Entry points
- `POST /api/consults/async` (`server.js:131-154`) returns `{jobId}` immediately and runs `generateNote()` in the background.
  - Jobs live in an in-memory `Map` (`server.js:127`) with a 15 min TTL.
  - **There is no concurrency limit or queue**: N clinicians means N simultaneous pipelines.
  - A backend restart loses every in-flight job.
- The client polls `GET /api/consults/job/:id` every 3 s and gives up after 5 min (`Scribe.tsx:541, 560`).
- `POST /api/consults` (`server.js:104`) is the same pipeline, synchronous (it would hit the Cloudflare 100 s limit).

### 1.2 Orchestration order (`generateNote.js` → `PipelineEngine.runPipeline`)
Everything is **strictly sequential**. The only `Promise.all` or `Promise.race` use is for timeboxing. Nothing runs in parallel.

| # | Stage | Type | Model call params (file:line) | Typical output | Worst case (full timeouts) |
|---|---|---|---|---|---|
| 0 | Encounter classifier | deterministic (`PipelineEngine.js:168-173`; LLM only if `ENCOUNTER_CLASSIFIER=1`) | n/a | 0 | 0 |
| 1 | **observation-extractor** | LLM, 1 call | timeout **180 s**, `retries:1` (floor 2), temp 0, cap 15000 tok (`.env`), 40-field responseSchema (`ClinicalObservationExtractorAgent.js:331`) | 8-15k tok of JSON | 2x180 = **360 s + backoff**; on failure the pipeline aborts (see 2.1) |
| 1b | RelationshipEngine, ClinicalRecallAnalyzer | deterministic | n/a | n/a | n/a |
| 2 | **fact-recovery** (conditional; fires often, see 2.5) | LLM, 0-1 | 45 s, cap 8000 (`FactRecoveryAgent.js:93`); errors swallowed | 1-4k tok | 2x45 = 90 s |
| 3 | Historical / Temporal / ProblemGraph / ProblemGenerator / Lexicon / LabAggregation / Style / NarrativeValidator / AssessmentReasoner / Dedup / Coverage / Integrity / TemplateAssembly / LanguageFormatter / JSValidator / FHIR | deterministic JS (~1.6k-line assembler etc.) | n/a | n/a | CPU only; blocks the event loop |
| 4 | **clinical-story** (slot filler) | LLM, 1 call, free text (no schema) | timeout **180 s**, `retries:1`, cap 20000 tok (`ClinicalStoryLLMAgent.js:449`) | 4-12k tok | 2x180 = **360 s**; failure falls back to the deterministic composer (no LLM) |
| 5 | **qa-validator** (when JS-validator FAIL or recall `needsRecovery` or coverage FAIL; see 2.4) | LLM, 0-1 | default **60 s**, no override, cap 6000 (`ClinicalQAValidatorAgent.js:83-85`); prompt = transcript + note + JS errors | 100-500 tok | 2x60 = 120 s |
| 6 | **story-composer** (`composeStory`) | LLM, 1 call, schema | 45 s, `retries:1`, requested 24576 but **clamped to 8000** by `STORY_COMPOSER_MAX_OUTPUT_TOKENS` (`heidiStoryEngine.js:162-171`, `LLMService.js:117-130`) | 2-4k tok | 2x45 = 90 s |
| 6b | **narrative** (`narrateNote`), runs if 6 returned the scaffold (any failure or guard trip) | LLM, 0-1 | 45 s, cap 65536 (`heidiNarrative.js:72-79`; `generateNote.js:187`) | 1-3k tok | 90 s |
| 6c | structure-note, only if no story at all | LLM, 0-1 | 60 s, cap 65536 (`structureNote.js:94-99`) | 2-4k tok | 120 s |
| 7 | reconcile, objective-retention, upgrade guardrails, `runGuardrails`, `condenseNote` | deterministic | n/a | n/a | n/a |
| 8 | tightener | LLM, **OFF** in prod | n/a | n/a | n/a |
| 9 | **hallucination-remover** | LLM, 1-2 calls | inner call has default 60 s timeout (`hallucinationRemover.js:139`); outer `Promise.race` budget 15-25 s (`generateNote.js:293`); cap 4000 | 100-600 tok | outer wait <=25 s, but **the orphaned call keeps running up to 2x60 s (x2 on the internal parse-retry, 141)** |
| 10 | **semantic-dedupe** | LLM, 0-1 | 25 s, `retries:0` (but floored to 2, see 2.6), cap 2048 (`semanticDedupe.js:198-202`); outer race 27 s | 100-400 tok | outer 27 s (orphan up to 50 s) |
| 11 | `dedupeNote`, `noteToMarkdown`, persist | deterministic / DB | n/a | n/a | n/a |

**Calls per note (prod config):**
- Minimum: 5 (extractor, story, composer, hallucination, dedupe).
- Typical: 6-7 (plus fact-recovery and QA, which trigger very often).
- Fallback paths add up to 3 more (narrative, structure-note, hallucination internal retry).
- Each call can make up to 4 HTTP attempts (2.6).

**Observed vs computed latency.** Happy path (everything succeeds first try):
- Extractor ~60-150 s
- Fact recovery ~10-30 s
- Story ~40-100 s
- QA ~5-15 s
- Composer ~15-40 s
- Hallucination ~5-25 s
- Dedupe ~5-25 s
- Total ~**140-390 s**, matching the 143-649 s seen in the monitor.

**Latency model.** Latency ~ TTFT (1-3 s) + output_tokens / decode speed. Input size is a minor factor: a 30-min consult is ~27k chars, about 7k tokens. Output volume is the cost.
- The extractor emits a 40-field object per fact, with `source_span` + `source_quote` (up to 300 chars each) + `display_text`. At ~100-150 tok/s, 15k tokens is 100-150 s. That explains the 180 s timeouts.
- The story agent re-reads the transcript and emits another 4-12k tokens.
- Then the composer writes the whole note a third time.
- Three full-note-sized generations in series is the core design problem.

**Worst-case wall-clock if everything that can time out does:**

| Component | Seconds |
|---|---|
| Extractor | 365 |
| Fact recovery | 90 |
| Story | 360 |
| QA | 120 |
| Composer | 90 |
| Narrative fallback | 90 |
| Hallucination (outer race) | 25 |
| Dedupe (outer race) | 27 |
| **Total** | **~1,170 s (~19.5 min)** |

(All stages above the extractor are caught individually, so the pipeline keeps going.) If the extractor itself times out twice, the pipeline aborts after ~6 min (2.1).
- Client polls only 5 min (`Scribe.tsx:541, 560`), then shows an error although the job keeps running.
- Any run over 300 s is therefore a user-visible failure even though the note later appears in History.

---

## 2. Cascades, redundant retries, over-long timeouts

### 2.1 Extractor failure produces a silent garbage note (P0)
- `PipelineEngine.js:530-538`: on any exception (e.g. the extractor timing out twice) `runPipeline` **returns** `finalNote = "Pipeline failed. Check Logs…"` instead of throwing.
- `generateNote.js:117-162`: there is no story, so `structureNote(finalNote)` runs, **another LLM call (60 s x2)**, on the error string.
- The note is persisted as `ready` and the job is marked `done` (`server.js:148`). The clinician gets an empty or odd note with no error.
- Fix: throw and surface a retriable error.

### 2.2 Writer redundancy: story slot-filler, composer and narrator are three full-note LLM passes
- `ClinicalStoryLLMAgent.js:449` (graph + transcript → slots).
- `heidiStoryEngine.js:164` (transcript + scaffold → whole note again, guarded to revert to the scaffold).
- `generateNote.js:187`: if the composer's guards trip (`heidiStoryEngine.js:207, 241`) it returns the scaffold, and the code then calls a **fourth** pass, `narrateNote`. So a quality-guard trip adds up to 90 s.

### 2.3 Hallucination-remover can delete correct facts on long consults (accuracy, P0)
- `hallucinationRemover.js:133` clips the transcript to the **first 14,000 chars** (`clip(transcript, 14000)`) and the note JSON to 12,000, then asks the model to list "fabricated" spans.
- A 15-30 min consult is 20-30k chars. Facts from the second half (plan, follow-ups, meds changes) look unsupported to the model and are deleted if flagged `confident`.
- It is also the only audit for long visits, so accuracy degrades exactly where the owner needs it.

### 2.4 QA validator is an expensive no-op in prod, and it fires almost every time
- Trigger (`PipelineEngine.js:463`): `jsValidation FAIL || recallAnalysisFinal.needsRecovery || coverageFailed`.
- `ClinicalRecallAnalyzer.js:150-161`: `life_safety` and `procedure` have no count, so **any coverage <100 fires recovery**. Keywords include "weeks", "months", "mg", "scan", "screening", "bleeding", with literal substring matching.
- `needsRecovery` is recomputed after recovery with the same noisy heuristic and stays true, so QA runs on most notes.
- Its output is only used for `qaMissingFacts`, which feeds the tightener (`generateNote.js:125-128, 210-216`). The tightener is OFF in prod, so the result is only logged.
- Cost: 6-15 s typical, 120 s worst case, zero effect on the note.

### 2.5 Fact recovery fires on noisy keyword heuristics
- Same analyzer (`ClinicalRecallAnalyzer.js:151-161`). One extra 10-30 s call (up to 90 s) on many notes, then dedupe against existing entities. Often adds little.

### 2.6 LLMService retry arithmetic (`services/LLMService.js`)
- `:111` `retries = (options.retries !== undefined ? Math.max(options.retries, 2) : 2) + targets.length`.
  - Callers passing `retries:0` (semantic-dedupe) or `1` get **2**.
  - The direct target adds 1 more, so it is always **>=4 attempts**.
  - The intent of `retries:0` is ignored.
- `:233` a timeout retries once. So a 180 s call costs 360 s, and a 25 s call can cost 50 s.
- `:188-196` 429/5xx retry 3 more times with 1/2/4 s backoff. Under quota exhaustion on shared `global` capacity, every stage independently burns ~7 s then fails; there is no run-level circuit breaker. In an overload, optional stages (QA, dedupe, hallucination) keep hammering.
- `:167-170` a 500 with a `responseSchema` deletes the schema and retries, consuming an attempt with no backoff and **losing constrained decoding**. For the extractor this yields unparseable text and a hard abort.
- `:74` `new GoogleAuth()` is created on **every call**. This is an extra token round-trip per call (~100-400 ms x 6-10). Cache one instance.
- `:43-51` `_recordTokens` ignores `usageMetadata.thoughtsTokenCount`.
  - `thinkingBudget:0` is sent (`:142`, and `thinkingBudget:0` from callers).
  - Gemini 3.x is documented to use `thinkingLevel`, and some 3.x models cannot fully disable thinking.
  - **[verify]** Check `thoughtsTokenCount` in a real response. If thinking is silently on, it explains "slow under concurrency".
  - Set `thinkingLevel` explicitly and log thought tokens.

### 2.7 Timeouts that outlive their callers (orphaned calls mutate the note later)
- `Promise.race` timeboxes (`generateNote.js:300-306` for hallucination, `:331-334` for dedupe) do not abort the underlying fetch.
  - The late result calls `applyRemovals(note, …)` or `applyDrops(note, …)` on the same object after it was rendered and persisted, so the returned note can differ from the stored one.
  - The orphan also holds the shared `llm._agent` field, so per-agent token and cap accounting is wrong.
- The hallucination remover's inner timeout (60 s default) is 2.4-4x its outer budget (15-25 s).
  - The budget formula at `generateNote.js:293`, `min(25000, max(15000, 15000 + chars/1000*3000))`, is always 25 s for >=4k-char transcripts. The code comment claims 20-90 s; the code does not.

### 2.8 Timeout and retry values that are too long
- Extractor 180 s x2 (`ClinicalObservationExtractorAgent.js:331`). Story 180 s x2 (`ClinicalStoryLLMAgent.js:449`).
- These are what produce the 180 s GEMINI_TIMEOUT rows. Both should be <=45-60 s with no timeout retry.
- QA 60 s x2 for a call whose result is unused.
- Composer / narrative 45 s x2.

### 2.9 Client-side cascade
- Client gives up at 5 min (`Scribe.tsx:541, 560`) while the job continues. The user retries and now two pipelines run concurrently, which causes more 429s and slowdowns.
- No server-side job de-duplication or per-user concurrency cap.

### 2.10 Proxy path (not used by prod pipeline, but still a hazard)
- `proxy.js:68-89` `callGemini` has **no timeout**, 3 attempts, then a no-schema retry and a low-token retry (`:126-135`). That is up to 9 upstream calls per request.
- `/api/llm/generate` is unauthenticated (see 3.8).
- `proxy.js:18` still defaults to `gemini-3.7-flash` when `GEMINI_MODEL` is unset.

---

## 3. Recording and ASR: what breaks long (>2 min) sessions

### 3.1 The literal "2 minute" constant is already fixed in the repo, but check it is deployed
- Old code: `EMPTY_SEG_LIMIT = 6` (6 x 20 s = 2 min) → `abortForSilence()` wiped the session whenever 6 chunks came back empty, **including failed requests**.
- Fixed in `af137bd` (`Scribe.tsx:9-16, 283-294`: limit 9, failures not counted, only discards if no speech ever captured). `docs/ASR_LONG_AUDIO.md` documents it.
- **[verify]** The VM and the frontend may still be running the pre-`af137bd` build. Latest commits are `af137bd` and `6caccf1`.
- Session expiry is not the cause: the cookie TTL is 7 days (`admin/session.js:15`, `.env.production` `ADMIN_SESSION_TTL_DAYS=7`), and `/api/asr` does not require a session (`server.js:90`).

### 3.2 Chirp fallback path is broken: failure cascades into an invalid V1 model name
- `proxy.js:205-206` `model = billableModel(asrModel)`. `billableModel('chirp_2')` returns `'chirp_2'` (`googleSpeech.js:51-61`: the regex only blocks `medical|premium`).
- When `transcribeChirpPcm` fails (e.g. quota/503 for all windows, `googleSpeech.js:261-263`), `proxy.js:229-236` falls back to **V1 recognize with `model: 'chirp_2'`**, which V1 rejects.
- Net effect: each failing 20 s chunk costs 3 Chirp tries + 3 V1 tries, then a 502/503. The client retries 4x (`Scribe.tsx:233-261`), so up to **~24 Google calls per chunk**.
- The repo `.env.production` sets `ASR_MODEL=medical_conversation`, which skips Chirp entirely and runs V1 `latest_long`. **[verify on VM]** which model is actually live.

### 3.3 No client-side request timeout, and retry sleeps hold the concurrency slot
- `Scribe.tsx:210` `fetch('/api/asr')` has no `AbortController` / timeout. A hung request (Google gRPC default deadlines are minutes, `googleSpeech.js:132, 246` set none) holds a slot forever.
- `Scribe.tsx:258` the 1/4/10 s retry sleeps happen **inside** `transcribeSegment`, which runs inside the `MAX_INFLIGHT=2` slot (`Scribe.tsx:16, 270-278`). Two failing chunks block all later chunks for ~15 s+ per cycle, and the queue grows.
- The comment "the backend queues too" (`Scribe.tsx:16, 263`) is false: no server-side ASR queue or semaphore exists. Each request spawns its own ffmpeg and up to 3 parallel Speech calls (`googleSpeech.js:37`).
- On stop, `maybeFinish` waits for `inFlight==0` (`Scribe.tsx:329`). A stuck request means the user sees "transcribing" indefinitely; `createSOAP` waits up to 4 min then proceeds with a truncated transcript (`Scribe.tsx:526-534`).

### 3.4 The "safety net" re-sends the entire recording in one synchronous request
- `Scribe.tsx:341-347`: if any segment failed, the whole recording is POSTed once to `/api/asr`.
- The server decodes it (ffmpeg budget 45 s + 4 s/MB, `audio.js:17-24`) and recognizes 36+ windows at concurrency 3 (`googleSpeech.js:240`). That is easily >100 s for a 20-30 min recording.
- Cloudflare in front of `api.aitoolsfordoctor.com` drops proxied HTTP requests after 100 s (524) on Free/Pro/Business. `Caddyfile` has no timeout override, but Cloudflare does not need one.
- If the web app is served by `next start` (not Workers), Next's rewrite proxy has its own timeout (documented default ~30 s via `proxyTimeout`). **[verify where the frontend is hosted]**
- So the recovery pass works for short consults and fails for exactly the long ones it was built for.

### 3.5 MediaRecorder rotation and timers
- Rotation: `Scribe.tsx:433-437` starts a new recorder, then stops the old one. Sound in the normal path.
- Narrow race: if stop is clicked just after a rotation, the old recorder's `onstop` (`:403-421`) can fire after `maybeFinish()` already saw `inFlight==0` with an empty queue (`:326-335`, sets `finishing=true`). The last <=20 s segment may then be enqueued after the transcript is considered final.
- Timers are `setTimeout`/`setInterval` (`:433, 485`). Chrome throttles background tabs to ~1/s and heavily (about 1/min) after ~5 min hidden, so 20 s rotation drifts when the tab is in the background. Segments get longer (still <60 s since the server windows at 50 s), but the capture-stall watchdog (`:485-492`) can also misfire.
- No Screen Wake Lock, so laptop sleep kills a long recording.
- Memory: the full-recording `MediaRecorder` timeslice 1 s (`:478`) keeps all chunks in RAM; fine for 30 min (~15 MB).

### 3.6 Server resource limits on the e2-small (2 GB, shared vCPU)
- `docker-compose.prod.yml`: no `mem_limit`, no CPU limits, no log rotation (the `json-file` driver is unbounded; the pipeline logs up to 20k chars per agent plus a per-entity trace to stdout), no healthcheck for the backend, and no swap config visible. Postgres 18, Node and Caddy share the 2 GB.
- `express.raw({limit:'120mb'})` (`proxy.js:179`) buffers the entire upload in memory, then ffmpeg stdout is also fully buffered (`audio.js:43`, `Buffer.concat`). A 30 min recovery upload is ~15 MB webm → ~57 MB PCM → base64 slices; fine for one user, but concurrent recoveries plus note pipelines risk OOM kills.
- e2-small is a shared-core, burstable VM (~0.5 vCPU sustained). The deterministic pipeline stages (1.6k-line assembler, regex-heavy validators) and ffmpeg decoding are CPU-bound and run on the Node event loop. Under concurrency, poll and ASR request latency inflates.
- Backend restart (OOM or deploy) drops in-memory jobs.

### 3.7 Rate limiting and auth middleware
- No rate-limiting middleware exists anywhere in `packages/backend` (no `express-rate-limit`; Caddyfile has none; relies on Cloudflare defaults).
- Sessions: stateless HMAC cookie, 7-day TTL, sliding refresh only on `/api/auth/me` (`authRoutes.js:74-80`, `session.js`). No mid-recording expiry.

### 3.8 Security issues found in passing (P0)
- `server.js:90` exempts `/api/llm/*` and `/api/asr` from auth, and `mountProxy` is mounted before the auth gate (`server.js:81`).
  - Anyone who finds the API origin can spend Vertex/Speech credits and push 120 MB uploads.
  - That also makes load unpredictable, which feeds the 429s.
  - Require auth, or remove the unused `/api/llm/*` endpoints in prod.
- `db/secrets/pg_password.txt` is **tracked in git** (`git ls-files`). Rotate the password and remove it from history.
- `.env.production` (git-ignored) contains a plaintext SMTP password. Keep it out of anything shared.
- `medproject-506019-1693e1199a3e.json` is in the repo root. It is git-ignored (`.gitignore:66`), but confirm it is not a live service-account key on shared disks.

---

## 4. Prioritized fixes

### P0 (do first; largest impact)

| # | Fix | Expected effect |
|---|---|---|
| P0-1 | **Replace the extractor → slot-filler → composer chain with a compact 2-call design** (section 5). | 143-649 s → ~30-50 s |
| P0-2 | **Shrink the extractor output** if the graph is kept: 8 fields per fact (`type, text, value, status, quote<=100 chars`); drop `source_span`/`source_quote` duplicates and the ~30 optional fields; cap ~5k tokens. | extractor 100-150 s → 20-35 s |
| P0-3 | **Throw on extractor failure** instead of returning the error string (`PipelineEngine.js:530-538`); mark the job `error`. | No more silent empty notes; no extra 120 s structure call |
| P0-4 | **Delete QA from the prod path** (`PipelineEngine.js:463-499`), or gate it behind `NOTE_TIGHTENER=1` with the tightener. | -6 to -15 s typical, -120 s worst, no quality loss |
| P0-5 | **Fix the hallucination remover's transcript clip** (send the full transcript, or chunk/verify per section). | Stops silent deletion of grounded plan facts on >12 min visits |
| P0-6 | **Hard time budgets with `AbortSignal`**, not `Promise.race`. Per-call timeout is 30-45 s; no retry on timeout; 1 retry only on 429/5xx/connection; run deadline ~90 s. Cap `retries` actually honoring `0`/`1` (`LLMService.js:111`). | Bounds worst case to ~90-120 s instead of ~20 min; no orphan mutations |
| P0-7 | **Require auth on `/api/asr` and remove/auth `/api/llm/*`**; rotate the committed pg password. | Stops cost/load abuse |
| P0-8 | **Confirm which build and `ASR_MODEL` are live**; fix the `billableModel('chirp_2')` → V1 fallback (`proxy.js:205-236`): on Chirp failure fall back to `latest_long`, not `chirp_2`. | Removes the ASR retry storm |

### P1

| # | Fix | Expected effect |
|---|---|---|
| P1-1 | **Run independent LLM work in parallel**: writer (transcript → SOAP JSON) and a lightweight checklist extractor (meds/labs/orders/follow-ups) concurrently, merged by the existing deterministic `retainObjectiveEntities` / `medChecklist` logic. | wall = max(), not sum |
| P1-2 | **Merge hallucination-remover + semantic-dedupe into one verifier call** that receives line ids and returns `{drop:[ids], dup_groups:[[ids]]}`. Keep the existing deterministic vetting (`groupRejection`, `applyDrops`). | -1 LLM call, ~-5-20 s |
| P1-3 | **Global concurrency limit and queue for note jobs** (e.g. 2-3 concurrent; return queue position); per-user de-dupe; persist job state in Postgres so restarts do not lose jobs. | Predictable latency under load; removes cascade-by-overload |
| P1-4 | **Run-level circuit breaker**: on the first 429/timeout, skip all optional stages (verifier, dedupe) and ship the deterministic note. | No fallback chains under degradation |
| P1-5 | **Explicit thinking control**: set `thinkingLevel` (minimal/low) per model; log `thoughtsTokenCount` in `_recordTokens`. | Possibly large; removes hidden latency |
| P1-6 | **Client ASR hardening** (`Scribe.tsx`): `AbortController` timeout (~25 s) per chunk request; move retry sleeps out of the in-flight slot; `MAX_INFLIGHT` 3; surface failed segments in the UI. | Prevents queue starvation mid-recording |
| P1-7 | **Server ASR semaphore** (limit concurrent decodes/recognitions to ~2-4) plus a per-request deadline. | Protects the 2 GB VM |
| P1-8 | **Replace the full-recording recovery POST** with per-segment retry at the server, or upload the audio to GCS and use `longRunningRecognize` (already in `googleSpeech.js:272`). | Long consults recover without hitting the 100 s edge limit |
| P1-9 | **Bump polling cutoff** to match the pipeline deadline and show real progress (the server already emits `onProgress`, but the job endpoint does not return it). | Fewer false "taking too long" errors |
| P1-10 | Cache `GoogleAuth` once per process (`LLMService.js:74`). | -0.1-0.4 s per call |

### P2
- Compose limits: `mem_limit`, log rotation (`logging: {driver: json-file, options: {max-size, max-file}}`), a backend healthcheck, and swap (or move to e2-medium).
- Wake Lock plus a Web Worker or `MediaRecorder.start(timeslice)` single-recorder design to avoid background-tab throttling.
- Incremental extraction during recording (every 2-3 min) so only the delta is processed at stop.
- Provisioned Throughput or a pinned regional endpoint if `global` shared capacity keeps producing 429/latency spikes.
- Remove the dead code path (`DeterministicFallbackComposer` + 4 composers, `NarrativeDeduplicator`, etc.) once the new path is validated.
- Make `proxy.js:18` default to the same model as `LLMService`.

---

## 5. Recommended target architecture (what to merge or remove)

**Remove outright:**
- QA validator (unused output).
- `narrateNote` fallback and `structureNote` LLM fallback.
- The tightener (already off) and LLM encounter classifier (already off).
- The fact-recovery LLM pass (replaced by the parallel checklist extractor).

**Merge into ONE structured-output writer call:** extractor + clinical-story + story-composer.
- Input: transcript (+ patient context).
- Schema: the existing SOAP schema (`NOTE_SCHEMA`) with short strings.
- Instructions: "specific facts only, no padding", explicit "omit rather than guess".
- Output: ~1.5-3k tokens.
- Use `responseSchema` (constrained decoding) plus `thinkingLevel: minimal/low`.
- Expected latency: 12-30 s.

**In parallel (same time as the writer):** a small checklist extractor.
- Returns `meds[]`, `labs[]` (value + unit), `orders[]`, `follow_up`.
- Output: <=800 tokens, ~6-10 s.
- A deterministic merge adds anything the writer dropped, using the existing `retainObjectiveEntities` and `medChecklist` logic (`generateNote.js:147-155, 397-431`) and `groundNumbers` (`heidiStoryEngine.js:187-192`).

**Then ONE verifier call** (merge of hallucination-remover and semantic-dedupe).
- Input: transcript plus numbered note lines.
- Output: `{unsupported:[ids], duplicates:[[ids]]}`, <=500 tokens, 5-10 s.
- Reuse the existing deterministic vetting.
- Skip if the run is already over budget.

**Then the existing deterministic stages:** reconcile, guardrails, condense, dedupe, render.

**Expected total:** ~25-50 s after the transcript is final (writer 12-30 s in parallel with the extractor, verifier ~8 s, deterministic <1 s). That meets the 30-45 s target for 10-30 min consults, with 2-3 LLM calls instead of 6-10, a single hard deadline, and a single deterministic fallback.

**Accuracy safeguards:**
- Keep temperature 0.
- Keep number grounding and named-entity grounding (`upgrades.js:231+`).
- Keep the objective-retention and medication checklists.
- Test with the existing eval corpus (`eval/`, `data/gold`) before cutting over, behind a flag (e.g. `PIPELINE_MODE=v2`).

**Model choice.**
- Keep `gemini-3.5-flash` for the writer.
- Try `gemini-3.5-flash-lite` (priced in `ops/opsLog.js`) for the checklist extractor and verifier, then compare quality on the corpus.
- Measure output tokens/s from the existing `[tokens]` log lines against wall-clock before deciding.

---

## 6. Google ADK / Vertex AI Agent Engine: would it help?

**Short answer: not for speed, and only marginally for reliability.**

- ADK (and Agent Engine) provides orchestration abstractions: agents, tools, sessions, `SequentialAgent` / `ParallelAgent` / `LoopAgent`, tracing, and managed hosting.
  - It does not make a model call faster.
  - The latency here comes from (a) 3-4 sequential full-note generations, (b) very large per-fact JSON outputs, (c) timeouts and retries measured in minutes, and (d) a missing concurrency limit.
  - None of that is an orchestration-framework problem.
- Rewriting the pipeline in ADK would move the same 6-10 sequential calls into a framework and would not shorten them. A `SequentialAgent` of the current stages would be the same latency, plus framework overhead and a Python or TS runtime migration.
- It would help with: standardised tracing, evals (ADK eval tooling), session state and multi-turn tools. The scribe is a single-shot transform, not an open-ended agent loop, so it has little need for those.
- Agent Engine adds a managed runtime. For a single-shot note job, a queue plus a worker on the existing VM (or Cloud Run) gives the same benefit with less machinery.
- Risk: Agent Engine and ADK add cold starts, extra network hops, quotas and a new BAA/PHI review surface.

**What I would do instead:**
1. Collapse to 2-3 LLM calls with structured output, as in section 5.
2. Use parallelism with `Promise.all` where calls are independent (writer || checklist).
3. Enforce a single run deadline using `AbortController`, with exactly one deterministic fallback.
4. Add a global job queue / semaphore and persist jobs in Postgres.
5. Pick the model and thinking level by measurement (tokens/s, quality on the eval corpus).
6. Use Gemini context caching only if the same large system prompt is reused heavily (not the main lever here).
7. Revisit ADK only if the product grows into real multi-step agentic workflows (coding assistants, tool use, patient chat), at which point its tracing and evals become worth the migration cost.

---

## 7. Evidence checklist for the owner (quick verification on the VM)

1. `docker exec notera-backend env | grep -E "ASR_MODEL|NOTE_TIGHTENER|GEMINI_THINKING|HALLUCINATION|SEMANTIC"`. Confirms the section 3.2 and 2.4 assumptions.
2. In backend logs, grep `[tokens] observation-extractor`. If `output` is near 15000, the extractor is truncating (silent loss of the plan) as well as being slow.
3. Grep `thoughtsTokenCount` (or add it to `_recordTokens`). Confirms whether thinking is really off.
4. Grep `[PromptAgent] qa-validator` frequency versus notes produced. Expect it on most notes.
5. Grep `skipped — exceeded` for the hallucination remover and dedupe. These are the orphan calls.
6. Check the deployed `Scribe.tsx` build date against `af137bd` (2026-09-12).
7. `docker stats` / `free -m` / `dmesg | grep -i oom` during a 20-min recording plus a concurrent note job.
