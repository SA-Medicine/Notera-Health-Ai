# Production moved to gemini-3.7-flash — configuration and validation

## What is live now (deployed 2026-10-18)

| Setting | Before | **Now** | Why |
|---|---|---|---|
| Writer model | gemini-2.5-flash | **gemini-3.7-flash** | Best measured quality (see below) |
| Writer fallback (on 429 / timeout / invalid JSON) | gemini-3.5-flash-lite | **gemini-2.5-flash** | A degraded answer should still be a good model, not the cheapest one |
| Reference notes shown to the writer | 0 | **2** (most similar clinician notes from a 300-pair bank that excludes every evaluation note) | +completeness; 3 was not better |
| Default writer prompt | — | **+ a "COMPLETENESS" block** (named results with values, medications with what they are for, history and negatives, timelines, plan specifics) | Completeness was the largest gap to the gold notes |
| Temperature / top-p / thinking | 0.3 / 0.9 / 0 | unchanged | 0.1 and thinking 1024 were not better (below) |
| Helper model (checklist + verifier) | gemini-3.5-flash-lite | unchanged | Using 3.7 for them was slower and not better |
| Writer invalid-JSON handling | fail the note | **retry once at temperature 0 on the fallback model** | 1 in 24 notes failed on 3.7 |
| Hedge / timeout | 25 s / 50 s | unchanged | p95 is 31 s, inside both |

Everything is a setting, not code: **Settings** screen, each row has Reset. The prompt block is part of the built-in default prompt (Prompts → Note writer → Compare with default).

## Experiments that chose it (same notes, old Testing Lab comparator, gemini-3.7-flash writer)

50 notes: baseline 85.4 (25 at 90+) · temperature 0.1: 83.4 (18) · thinking 1024: 83.0 (20) · two reference notes: 85.2 (19).
100 notes (paired): reference 83.5 (40 at 90+) · + completeness block 85.0 (42) · **+ completeness + 2 reference notes 85.2 (49)** · 3 reference notes 84.2 (47) · + helper on 3.7 83.5 (40, slower) · + editor pass 84.1 (47, slower).
The differences between 83.5 and 85.2 are small (±1.5 noise); I chose the best and cheapest combination and then **tested it on notes never used in any tuning**:

## Held-out validation — 100 fresh notes

| | Old config (2.5-flash, no references, old prompt) | **New defaults** |
|---|---|---|
| Parity score (the old "90+" comparator) | 79.5 | **82.9** |
| Notes at 90 or above | 33 of 99 | **42 of 99** |
| Completeness (notera vs gold, 0–5) | 3.49 vs 4.94 | **4.06** vs 4.73 |
| Strict gold-referenced audit | 59.6 (16 unsafe) | **63.6 (10 unsafe)** |
| Transcript-only audit | 67.1 (6 unsafe) | **72.9 (2 unsafe)** — clinicians' own notes: 73.4 |
| Critical wrong claims per note (target < 0.10) | 0.28 | **0.16** |
| Latency p50 / p95 | 5.4 s / 19 s | 9.8 s / 31 s |
| Failed notes | 0 | 0 |

Honest summary: **+3.4 on the old comparator, +9 more notes at 90+ (33 % → 42 %), unsafe notes down by two thirds on the transcript audit, critical wrong claims down 43 %, at roughly 2× latency.** The mean is 82.9, not 90: the 89–90 means of the old runs came from a smaller, easier fixture set plus run-to-run luck; on 100 fresh notes the old design scored 79.5.

## Watch and roll back

* **System → p95 latency / failure rate** for the first day. An earlier commit noted 3.7 was slow under concurrent load on Vertex; the fallback model and hedging cover it, but check.
* Roll back any part from **Settings** (Writer model, Writer fallback, Reference notes = 0) — effective in ~30 s, no deploy.
* Cost: more input tokens per note (two reference notes ≈ +3–5k) and a pricier model; check **System → cost per note** after a day.

## Still open

Critical claims 0.16/note is above the 0.10 target. The remaining failures are mostly garbled-speech drug names (guard added, flags for review), unsupported diagnoses and current-vs-past medication mix-ups; the next lever is a clinician-labelled sample (Blind judge verdict buttons) rather than more automatic tuning.
