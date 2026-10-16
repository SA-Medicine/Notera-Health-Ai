# Notera — Fast, reliable SOAP notes: plan (v2)

Evidence: [AUDIT_REPORT.md](AUDIT_REPORT.md) (code audit) + a live test on the production container
(`scripts/e2e-long-audio.mjs`, run 2026-10-16 with a 10.4-min consult).

## What the data says

| Finding (measured) | Impact |
| --- | --- |
| ASR is healthy: 32/32 chunks of a 10-min recording OK, ~22 s wall, p50 1.3 s | The "2 minutes" problem is not the speech model; it was the old silence watchdog (fixed in `af137bd`) |
| Note generation took **170 s** for that consult (monitor shows 143–649 s) | Far above the 30–45 s target |
| Prod runs `ENCOUNTER_CLASSIFIER=1`: a 17-token LLM call took **58 s** (a ~2 s call; Vertex `global` shared capacity spikes) | One slow call stalls the whole chain |
| Pipeline = 5–7 sequential LLM calls; 3 of them each rewrite the whole note; QA output is unused | Latency is sum-of-calls, not one slow call |
| Timeouts 180 s ×2, retries floored to ≥4 attempts, timeouts retried, `Promise.race` orphans | Worst case ≈ 19 min; this is the "one fails → another fails → another" chain |
| Hallucination remover only sees the first 14k chars of the transcript | Deletes correct plan facts on long consults |
| Extractor failure returns an error *string* that is then fed to another LLM call and saved as a "done" note | Silent garbage notes |

Not a cause (checked): thinking tokens (0 with `thinkingBudget:0`), model quota (no 429 in the test), VM memory/disk.

## Phase 1 — stop the bleeding (this change set, low risk, no model/quality change)

1. **LLMService**: honour `retries`; never retry a timeout (hedge instead); **hedged requests** for small calls
   (second identical request after 8 s, first answer wins, loser aborted); cache `GoogleAuth`; log thought tokens.
2. **Pipeline**: LLM encounter classifier off (deterministic classifier is 3 ms); QA validator off (result unused);
   extractor/story timeouts 180 s → 60 s; extractor failure **throws** (job → `error`, retriable) instead of a fake note.
3. **Accuracy**: hallucination remover gets the **full** transcript (was first 14k chars).
4. **ASR**: Chirp failure falls back to `latest_long` (not the invalid V1 model `chirp_2`); client gets a per-chunk
   timeout, retry sleeps no longer hold a concurrency slot, poll window 5 → 8 min.
5. **Verify** with the long-audio harness on the production container (3 consults, 9–13 min each) before/after.

Targets after Phase 1: p50 note ≤ 90 s, no 180 s timeouts, no silent empty notes.

## Phase 2 — the real speed-up (behind `PIPELINE_MODE=v2`, A/B on the eval corpus)

* ONE structured-output writer call (transcript → SOAP JSON, short strings, "specific facts only") replacing
  extractor → clinical-story → story-composer (3 full-note generations).
* In parallel: a tiny checklist extractor (meds / labs / orders / follow-up, ≤800 tokens); deterministic merge using the
  existing retention + number-grounding code.
* ONE verifier call (merge of hallucination-remover + semantic-dedupe) with line ids; skipped when over budget.
* One run deadline (~90 s) via `AbortController`; one deterministic fallback; no cascades.
* Job queue (2–3 concurrent) persisted in Postgres; per-user de-dupe.
* Promote only if gold-set quality ≥ current (use `eval/` + `data/gold`) and p50 ≤ 40 s.

## Phase 3 — hardening

Auth on `/api/asr` and removal/auth of `/api/llm/*`; rotate the committed pg password; compose `mem_limit` + log
rotation + backend healthcheck; ASR server-side semaphore; Wake Lock on the recording screen; optional pinned/regional
or provisioned Vertex capacity if `global` spikes persist.

## Google ADK / Agent Engine?

**No — not for speed.** ADK gives orchestration (Sequential/Parallel agents, sessions, tracing, evals), not faster
inference. The latency here is three serial full-note generations, large per-fact JSON, minute-long timeouts and no
queue. Re-hosting the same 6–10 calls in ADK keeps the latency and adds a runtime, cold starts and a new PHI/BAA
review surface. The scribe is a single-shot transform, not an agent loop. Revisit ADK only if the product grows into
multi-step agentic features (chart-aware assistant, tool use, patient chat).

## Success metrics (measured by the harness + Notera Monitor)

p50 / p95 note time (target ≤40 s / ≤90 s) · `GEMINI_TIMEOUT` count/day (target ≈0) · ASR chunk failures (0) ·
LLM calls per note (target 3) · note length (concise) and gold-set fact recall (no regression).
