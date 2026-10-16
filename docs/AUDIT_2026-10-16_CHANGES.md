# Notera — change audit (2026-10-14 → 2026-10-16)

Point-to-point record of everything changed, why, how it was verified, and what is still open.
Commits are in `git log` (11 commits, `6caccf1` … `9b8c0c0`). Production = GCP VM `notera-app` (backend, Postgres, Caddy) behind Cloudflare; frontend = Cloudflare Pages, built from `main`.

---

## 1. Starting problem

| Symptom | Evidence | Root cause found |
| --- | --- | --- |
| Notera Monitor full of `GEMINI_TIMEOUT` / `GEMINI_429` | Monitor screenshots | `gemini-3.7-flash` on Vertex `global` slow under concurrency (3 s single, 10–33 s at 8 parallel) |
| Notes took 143–649 s | Monitor "Runs" tab | 5–7 **sequential** LLM calls, 3 of them full-note rewrites; timeouts 180 s ×2; ≥4 attempts per call |
| "Only 2 minutes of recording works" | User report | Old silence watchdog (6×20 s) — already fixed in `af137bd`; ASR itself healthy (verified) |
| Notes degrading | User report + pasted note | Writer model leaked reasoning into note text, facts in wrong sections, no diagnosis / Rtc |

Not a cause (checked): thinking tokens (0), VM memory/CPU (idle), regional quota, request format, Vertex auth.

---

## 2. Backend — LLM layer (`packages/backend/src/services/LLMService.js`)

| # | Change | Why |
| --- | --- | --- |
| 2.1 | `retries` now honoured (was floored to ≥2 and padded per endpoint ⇒ ≥4 attempts) | Remove retry multiplication |
| 2.2 | A timeout is **never retried** (`retryOnTimeout` opt-in) | A 60 s hang used to become 181 s |
| 2.3 | **Hedged requests** (`hedgedPost`): slow small call → 2nd request after `hedgeMs`, first answer wins, loser aborted | Vertex calls stall randomly (7–13 s spikes on trivial calls) |
| 2.4 | **Fallback model** (`GEMINI_FALLBACK_MODEL`): hedge target + immediate hop on 429/5xx. One hop, never a chain | Resilience without cascades |
| 2.5 | `GoogleAuth` cached per process | Saved a token round-trip per call |
| 2.6 | Logs `thoughtsTokenCount` | Prove thinking is off |
| 2.7 | Sampling parameters per call or env: `topP, topK, seed, frequencyPenalty, presencePenalty` (+ safe retry without them if a model rejects) | Hyper-parameter tuning |
| 2.8 | `proxy.js`: Chirp failure now falls back to `latest_long` (was invalid V1 model `chirp_2`) | Removed ASR retry storm |

Tests: `test/hedgedPost.test.mjs` (6 cases: hedge, no-hedge, 429, abort, fallback-on-503, fallback-on-slow) — pass.

## 3. Backend — pipeline

### 3.1 Phase 1 (v1 pipeline hardening)
| Change | File |
| --- | --- |
| Extractor timeout 180→75 s, clinical-story 180→60 s | `ClinicalObservationExtractorAgent.js`, `ClinicalStoryLLMAgent.js` |
| QA validator off in prod (`QA_VALIDATOR=1` to re-enable; its output was unused) | `PipelineEngine.js` |
| Extractor/pipeline failure now **throws** (job → error, consult → `error`) instead of saving an error string as a "done" note | `PipelineEngine.js`, `generateNote.js` |
| Hallucination remover sees the **full** transcript (was first 14 000 chars ⇒ deleted real plan facts on long visits); 22 s call, hedge 7 s | `hallucinationRemover.js` |
| `ENCOUNTER_CLASSIFIER=0` on server (LLM classifier once took 58 s for 17 tokens; deterministic one is 3 ms) | server `.env.production` |

### 3.2 Phase 2 — **v2 pipeline** (`PIPELINE_MODE=v2`, `orchestrator/generateNoteV2.js`)
Flow: **writer ∥ checklist → deterministic merge → one verifier → deterministic guardrails/render**. 3 LLM calls (2 parallel) instead of 5–7 serial. One deadline per call, no cascade, no fallback chain.

| Component | Detail |
| --- | --- |
| Writer | One structured-output call, `gemini-2.5-flash` (`V2_WRITER_MODEL`), temp 0.3, topP 0.9, thinking **off**, fallback `gemini-3.5-flash-lite` |
| Checklist | Tiny call (meds, results, orders, referrals, follow-up); merged only if grounded in transcript |
| Verifier | One call proposes unsupported/duplicate line ids; **code confirms** before deleting; refuses >25 % deletions |
| Cleaner (`cleanNote`) | Deterministic: removes model commentary ("Let's…", "none stated", "as per transcript", any mention of "the transcript"), dedupes, splits `a; b` history lines, strips trailing `;`, caps run-on lines |
| Prompt | Gold-note style + field-placement table + **condensed clinic rules** (from prompt-store `clinical-story` v11: patient identity, no invented dates, exact drug/test names, negations, one-place, refill handling, etiology grouping, no "None") |
| Empty/voicemail transcripts | Empty flagged note (same as v1) |
| Rollback | `PIPELINE_MODE=v1` in server `.env.production` + rebuild backend |

Rejected experiments (kept out of prod):
| Experiment | Result |
| --- | --- |
| Full v11 prompt verbatim in the writer | 9 k tokens, shorter notes, lost `Diagnosis:` lines (its rule 7 forbids them), slower |
| `gemini-3.1-flash-lite` / `gemini-2.5-flash-lite` writers | thin notes / 2 of 20 unparseable JSON |
| Thinking budget 512 | slower (p50 6.6 s), no quality gain |
| Frequency penalty 0.25 | tie vs baseline, one slow outlier |

## 4. Models, region, cost

| Item | Before | Now |
| --- | --- | --- |
| Default model | `gemini-3.7-flash` | `GEMINI_MODEL=gemini-3.5-flash-lite` (checklist, verifier) |
| Writer | — | `gemini-2.5-flash` (code default) |
| Fallback | none | `gemini-2.5-flash` (`GEMINI_FALLBACK_MODEL`), writer fallback `gemini-3.5-flash-lite` |
| Region | `global` | `global` (cheapest; only place the 3.x lite models exist) |
| Thinking | `thinkingBudget:0` | unchanged — **off everywhere**; `GEMINI_THINKING_LEVEL=off` set explicitly |
| Canada | — | `northamerica-northeast1` serves 2.5-flash/flash-lite only; `northeast2` serves none. Use `GEMINI_MODEL=gemini-2.5-flash` + `VERTEX_LOCATION=northamerica-northeast1` if residency is mandated (~7 s/note) |
| Cost table | no 2.5 entry | `gemini-2.5-flash` price added in `ops/opsLog.js` (verify against Google's price list) |
| Tokens/note | 40–60 k | ~6–10 k |

## 5. Measured results

| Run | Pipeline / model | p50 | p95 | Failed | Quality |
| --- | --- | --- | --- | --- | --- |
| Monitor (before) | v1, 3.7-flash | 143–649 s | — | many | — |
| Prod container, 10-min audio | v1, 3.5-flash | 135–170 s | — | 1 of 3 timed out | — |
| Prod container | v1, 2.5-flash us-central1 | 55–72 s | — | 0 of 3 | — |
| 20 gold fixtures | v1, 2.5-flash | 68 s | 127 s | 0 | judge 5.0 / 7.1 / 4.7 (completeness / accuracy / concision) |
| 20 gold fixtures | **v2**, 2.5-flash | 7.3 s | 33 s | 0 | judge 7.9 / 8.4 / 8.3 — beat v1 in 17 of 19 |
| 20 gold fixtures | v2, 3.5-flash-lite | 3.7 s | 7.6 s | 0 | 7.6 / 8.4 / 7.6 (10–9 vs v2/2.5-flash) |
| 12 fixtures, tuning | v2 writer 2.5-flash T0 / T0.3+topP0.9 | 5.3 / 5.4 s | 10 / 11 s | 0 | T0.3+topP0.9 won judge 8–4; accuracy −0.5 (within noise on n=12) |
| User's reference consult (`1995-07-13`) | v2, new prompt | 5.9 s | — | — | similarity-to-gold 0.26–0.34 → **0.40**; Diagnosis lines, current meds, preventive care, Rtc all present |
| Production, final | v2 | ~5.7–6.0 s per note | — | — | verified in container on CAR0001/RES0001 transcripts |

ASR (production, 10–13-min recordings): 101/101 20-s chunks first try, p50 ≈ 1.4 s. Also verified via `app.aitoolsfordoctor.com/backend/api/asr` (Cloudflare path): HTTP 200, 3.5 s.

## 6. Auth, quota, security

| # | Change | File |
| --- | --- | --- |
| 6.1 | `POST /api/auth/signup` (public): free account, honeypot field, 5 sign-ups/hour/IP, password ≥12, 409 on duplicate | `auth/authRoutes.js` |
| 6.2 | Additive migration (runs at start): `auth.users.plan DEFAULT 'full'`, `free_notes_used DEFAULT 0`. **Existing users keep full access** — verified on prod: `full|5` | `auth/quota.js` |
| 6.3 | Free tier = **5 note generations**; atomic reserve (8 parallel requests ⇒ exactly 5); failed note refunded; 402 `free_limit_reached` + `/pricing` | `auth/quota.js`, `server.js` |
| 6.4 | Free ASR: blocked when out of notes; daily cap 450 chunks (~2.5 h) | `auth/quota.js` |
| 6.5 | `/api/auth/me` and login return `plan, used, limit, remaining` | `authRoutes.js` |
| 6.6 | Admin: `POST /api/auth/users/plan {email, plan, reset?}` | `authRoutes.js` |
| 6.7 | **`/api/asr` and `/api/llm/*` now require a session/service token** (were public — anyone could spend Google credits). Live check: 401 without login | `server.js` (proxy mounted after the auth gate) |
| 6.8 | Test hook `_setPool` + `test/quota.pgmem.mjs` (in-memory Postgres): grandfather, limit, refund, 402, service callers, race, ASR cap — pass | `db/pool.js`, `test/` |

## 7. Frontend — app (`apps/web/app/(app)`)

| # | Change |
| --- | --- |
| 7.1 | Tried a full single-screen redesign (dock/sheets/drawer) — **reverted at user request**; original sidebar + tabs layout restored |
| 7.2 | Hybrid kept: glass buttons (hover light-sweep, blue glass Create SOAP, red glass recording glow), soft cards, staggered note reveal, calmer note typography, animated steps |
| 7.3 | Libraries from the UI skill: `border-beam` on Create SOAP while writing, `thinking-orbs` mapped to the real stage, `voice-glow` audio-reactive glow on the live transcript |
| 7.4 | Removed the "Default mic" block |
| 7.5 | Reload fix: full-screen branded loading skeleton (`Protected.tsx`) instead of site top bar + "Loading…" card |
| 7.6 | Signup form (`/login?mode=signup`), `AuthProvider.signUp/refresh`, free-notes chip, upgrade dialog on 402 (notes + ASR), counter refresh after each note |
| 7.7 | ASR hardening: 30 s per-chunk timeout, retry back-off outside the concurrency slot, `MAX_INFLIGHT` 3, poll window 5→8 min, screen wake-lock while recording |
| 7.8 | Inter via `next/font` (removed render-blocking Google Fonts `@import`) |
| 7.9 | New deps: `border-beam`, `thinking-orbs`, `voice-glow` (`apps/web/package.json`, lockfile) |

## 8. Frontend — marketing site

| # | Change |
| --- | --- |
| 8.1 | Hero tightened; animated product demo (record → live transcript → "writing" → note), looping, paused off-screen, static for reduced-motion (`marketing/Demo.tsx`, `demo.css`) |
| 8.2 | Demo video `public/notera-demo.mp4` (23.5 s, 152 KB) + poster, rendered frame-by-frame with Chrome DevTools |
| 8.3 | Removed invented testimonials (stock avatars), "40k+ notes", unsourced "2 hrs/day" stat; replaced with true figures; removed 3 Unsplash images (CSS visuals instead) |
| 8.4 | Copy "50 free notes" → "5 free notes" everywhere (landing, pricing, about, notera, metadata, JSON-LD); Start-free buttons → sign-up; dead footer links removed |
| 8.5 | Pricing numbers ($49 Practice) **unchanged** — pre-existing, confirm they are intended |

## 9. Deployment & operations

| Item | Detail |
| --- | --- |
| Access | AWS login done (account has only an unrelated stopped `infou-crm` EC2). Notera backend is on **GCP VM `notera-app`**, reached via `gcloud compute ssh --tunnel-through-iap` |
| Backend deploys | `git pull` + `docker compose -f docker-compose.prod.yml up -d --build backend` (×6 today) |
| Server `.env.production` now | `PIPELINE_MODE=v2`, `GEMINI_MODEL=gemini-3.5-flash-lite`, `GEMINI_FALLBACK_MODEL=gemini-2.5-flash`, `VERTEX_LOCATION=global`, `GEMINI_THINKING_LEVEL=off`, `V2_WRITER_HEDGE_MS=12000`, `ENCOUNTER_CLASSIFIER=0` (code defaults: writer `gemini-2.5-flash`, temp 0.3, topP 0.9) |
| Frontend | Cloudflare builds from `main` automatically; live bundle checked for new CSS (`app-splash`, `pw-chip`, `dm-wrap`) |
| Gotcha | Rebuilding the backend container wipes `/tmp` test files |

## 10. Tooling and docs added

`scripts/e2e-long-audio.mjs` (audio→chunks→ASR→note timing; needs `COOKIE`/`AUTH_BEARER` now), `scripts/cdp-shot.mjs` (real-time screenshots / video frames via DevTools), `eval/run_eval.mjs` (`--sample N`, per-fixture ms, p50/p95), `eval/compare_runs.mjs` (blind pairwise LLM judge), `docs/AUDIT_REPORT.md` (code audit), `docs/IMPROVEMENT_PLAN_V2.md` (plan + measured results), tests: `hedgedPost`, `cleanNote`, `quota.pgmem`.

## 11. Verification evidence

| Check | Result |
| --- | --- |
| Unit tests (`packages/backend/test`, 6 files) | all pass |
| Quota integration (pg-mem) | all pass |
| Prod `/healthz` | `{"ok":true}` |
| Prod unauth `/api/asr`, `/api/llm/diag`, `/api/auth/me` | 401 |
| Prod signup validation (bad email / short password) | 400; honeypot 200 (ignored) |
| Prod DB plans | `full|5` (all existing users unlimited) |
| Prod note generation (container) | v2, ~5.7–6.0 s, clean one-fact-per-line output |
| UI | headless-Chrome screenshots: idle, recording (fake mic), writing, finished note, paywall (402), loading skeleton, dark mode; no console errors |

## 12. Known gaps / open items

| Priority | Item |
| --- | --- |
| **Do once** | A real sign-up → 5 notes → paywall run on production (not done: creating accounts on prod is out of bounds for automation) |
| High | No email verification (SMTP host `smtp.agilepartners-ai.com` does not resolve) — free-account farming limited only by IP rate limit, honeypot and daily ASR cap |
| High | `db/secrets/pg_password.txt` is committed in git — rotate the DB password |
| Medium | Quality tuning evidence is n=12–20 fixtures with lexical + LLM-judge metrics; add clinician review before wide rollout |
| Medium | `Referrals: Doctor the patient` style artifacts come from de-identified gold transcripts; not expected with real names |
| Medium | Phone-width check of the hybrid app UI and signup form not done visually |
| Low | Backend jobs are in memory (restart loses in-flight notes); no queue/limit on concurrent notes |
| Low | `/api/asr` auth removal of the old unauthenticated access may break any legacy caller that sent no cookie |
