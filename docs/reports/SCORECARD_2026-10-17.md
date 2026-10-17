# System scorecard — 2026-10-17

What was run, what it showed, what changed. Raw detail: [50-note scan with every note audited](SCAN_2026-10-17_scan50-baseline.md) · [audio end-to-end](AUDIO_E2E.md).

## 1. Results

### 50 gold notes → generate → audit every note (deployed pipeline, `gemini-2.5-flash` writer, production prompt)

| Metric | Value |
|---|---|
| Notes generated / failed | 50 / 0 |
| Similarity to gold | **0.369** |
| Omission rate (lower is better) | **0.514** |
| Section coverage | **0.930** |
| Story / flow | 0.867 |
| Latency p50 / p95 | 5.1 s / 10.2 s |
| LLM audit (gemini-2.5-pro vs transcript + gold) | mean **61.8 / 100** · 13 good · 31 needs work · **6 unsafe** |

### Versus the old (v1, multi-agent) system, same metric code

| | v1 (2026-07-29, 50 notes) | v1 best (2026-08-14, 11 notes) | **v2 now (50 notes)** |
|---|---|---|---|
| Section coverage | 0.870 | 0.955 | **0.930** |
| Similarity to gold | 0.268 | 0.365 | **0.369** |
| Omission | 0.521 | 0.437 | 0.514 |
| Story / flow | 0.938 | 0.934 | 0.867 |
| Time per note | 143–649 s | — | **~5 s** |

Honest reading: coverage and similarity are at or above the old system, omission is level on the large sample, **story/flow is lower** (v2 writes concise bullet lines, and the flow metric rewards longer lines), and speed is ~30–100× better. The samples are not identical notes, so treat differences under ~0.03 as noise. The "90" you mentioned is not a number the codebase stores; the closest comparable is section coverage (87–95 % before, 93 % now). If you meant a different score, tell me which screen showed it.

### Audio end to end (9 real recordings, 9–13 min each, run inside the production backend container)

| | |
|---|---|
| Success | **9 / 9** (decode → Google Speech-to-Text → v2 note) |
| ASR word error rate vs human transcript | mean **0.22** (conversational speech, includes fillers) |
| ASR time / note time | ~31 s / ~5 s per recording |
| LLM audit vs the human transcript | mean **70.6 / 100** |

Not tested: the sign-up → free-quota → upgrade flow with a new account (creating accounts on production is something I do not do for you), and long recordings through the browser chunking path.

## 2. What the audits found (50-note diagnosis, all stages blamed on the writer)

1. **Information in the wrong SOAP section** (32 of 40 audited): history in Objective, exam findings in Subjective, social history in PMH.
2. **Plan items attached to the wrong problem** / administrative items listed as diagnoses (25 of 40).
3. **Critical factual errors** (9 of 40): invented or flipped statements (a denied symptom written as confirmed), wrong drug, wrong dose, wrong diagnosis.
4. **Model degeneration loops** ("…the patient or the patient or the patient…") in 2 of the 6 unsafe notes — **fixed today** (see §3).
5. A transcript containing a **second patient** at the end was merged into the first note (1 case).
6. Subjective written as a list rather than a narrative (16 of 40) — **deliberately not "fixed"**: the gold notes are concise bullet lines and the diagnosis model's suggestion to force a narrative HPI would move away from the gold style you asked for.

Pipeline log statistics across the 50 notes: verifier removed 19 unsupported lines, cleanup removed 13 lines, 105 duplicate lines removed, checklist merged items into 42 notes, 0 verifier refusals, 0 skipped stages; writer+checklist 4.6 s, verifier 0.8 s.

The audit model is strict (it calls a 0.37-similarity note "catastrophic"); use it for ranking and for finding failure classes, not as an absolute grade.

## 3. Changes made

| Change | Evidence |
|---|---|
| **Degeneration-loop guard** (`collapseLoops` in the note cleaner): collapses any 1–6 word phrase repeated 3+ times and "the patient, the patient" artefacts | Unit tests added (7 cases incl. "no no" and legitimate repeats untouched); re-ran the 6 unsafe notes on the VM — the two looped notes no longer contain loops |
| **Prompt improvement loop run end to end**: candidate generated from the 50-note failures, validated on 40 unseen notes, order-swapped blind judge, gate | Result: wins B 14 · A 13 · tie 12, accuracy 8.22→8.55, unsupported claims/note 1.45→1.23, but similarity/omission unchanged and p95 latency 14.5 s vs 7.1 s → **gate failed, NOT promoted** (production prompt unchanged) |
| Removed 11 unreachable backend files and the legacy Chrome-extension prototype (`apps/web/public/notera`, 74 files, 5 MB) | **That prototype was publicly downloadable at `aitoolsfordoctor.com/notera/…` — the whole v1 pipeline source and prompts.** Nothing referenced it |
| Fixed a stale guardrail test (behaviour had intentionally changed from "flag" to "substitute when unambiguous") | 97/97 assertions; 62 test files-level tests pass |
| Admin site: removed unused imports and `void` hacks; lab: ad-hoc audit endpoint for audio notes; `scripts/harness-scan.mjs`, `audio-e2e-vm.mjs`, `audio-score.mjs` | re-runnable end-to-end checks |

## 4. Code review findings (not all changed)

| Finding | Action |
|---|---|
| 17 backend files unreachable from the server entry points | 11 deleted; 6 kept (`labStore`, `labUtils`, `deepseek`, `metrics/*`) — they are used only by the dev-only Testing Lab (`ENABLE_ADMIN=1`, dynamic import) |
| The v1 multi-agent pipeline (~8k lines: `PipelineEngine`, agents, engines, `generateNote` v1 path) is still shipped but production runs `PIPELINE_MODE=v2` | **Decision for you**: keep as fallback or delete |
| `db/secrets/pg_password.txt` is tracked in git | **Not changed**: untracking it would delete the file from the VM on the next `git pull` and break the database container. Needs a planned rotation (new password in `.env`, Postgres `ALTER ROLE`, then untrack) |
| `scripts/all_sessions_anon.json` (130k lines) and `admin/data/*.json` committed | Left; bloats the repo, move out when convenient |
| `node --test test/` also picks up the pg-mem scripts that need an extra dependency | Documented: run `test/*.test.mjs` plus `src/**/*.test.mjs` |
| Many root-level planning `.md` files (≈10) | Left |
| Every JS/MJS file passes a syntax check; admin-site modules have no unused imports | — |

## 5. What is still weak (and what I would do next)

* **Writer section placement and plan attribution** are the dominant failures. Prompt tweaks alone did not move the metrics; the next experiment should be structural, e.g. a second constrained pass that assigns each plan line to a problem, or splitting the writer into subjective/objective and assessment/plan calls, validated with the same harness.
* **Negation flips and wrong doses** need a targeted verifier rule (flag lines whose polarity or number contradicts the transcript); today the verifier only removes lines the transcript does not support.
* **Multi-patient transcripts** need a segmentation step before the writer.
* Latency of the improved prompt (p95) must be re-measured before any promotion; one run had a slow tail.
