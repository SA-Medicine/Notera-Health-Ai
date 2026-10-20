# Speech-to-text: is the audio transcribed properly? (2026-10-20)

**Short answer:** the engine is not the weak point. Production (Chirp 2) is accurate on clean audio and is within 0.5–1 point of Google's newest model; the cheapest Google model is clearly worse; a 10× cheaper Gemini path is as accurate. What *is* risky is the lack of protection: one failure mode (an engine returning nothing, or looping) was invisible, and one real recording came out with only a third of its speech. The system now has an engine chain with fallbacks, a switch and an output guard.

## 1. Same audio, every engine (9 recordings with human transcripts)
Public simulated patient–physician interviews, 8–13 minutes each (CAR, DER, GAS, MSK, RES). Scored against the human transcript after removing fillers ("uh"), speaker labels and punctuation, and treating "eight" and "8" alike. (The earlier "WER 0.22" figure in `AUDIO_E2E.md` counted those fillers and number spellings as errors; with fair scoring production is about **0.11**.)

| Engine | Word errors | Worst file | Words missed | Key terms right* | Speed | Cost per 10 min |
|---|---|---|---|---|---|---|
| **Chirp 3** (Google's newest) | **10.5 %** | 19 % | 2.4 % | 94 % | 10 s | $0.16 |
| **Chirp 2** (production) | 11.0 % | 19 % | 2.3 % | 91 % | 10 s | $0.16 |
| Gemini 2.5 Flash (audio) | 10.9 % | 19 % | 2.1 % | 94 % | 11–70 s | **$0.02** |
| Gemini 3.7 Flash (audio) | 11.4 % | 19 % | 2.6 % | 92 % | 16–76 s | $0.02 |
| Latest Long (cheapest Google) | 16.4 % | 25 % | 5.7 % | 84 % | 35 s | $0.16 |
| Medical Conversation (Google premium) | 15.0 % | 22 % | 2.8 % | 90 % | 45 s | $0.78 |

\*numbers and drug-like words in the human transcript that appear in the output. Gemini 2.5 Flash failed 1 of 9 runs and Gemini 3.7 Flash 3 of 9 (HTTP 429 quota errors when several long requests ran at once); Gemini cost is an estimate from tokens. Reading: the top Google model and the second best are a statistical tie; the cheapest Google model gives up about 5 points of accuracy for no saving; the premium medical model is worse and 5× the price; Gemini Flash matches Chirp at one eighth of the price.

## 2. Real consults from the app (6 recordings, statistics only)
No human transcript exists for real consults, so the live (20-second chunk) transcript stored by the app was compared with each engine on the whole recording. Audio levels were healthy (RMS −23 to −27 dBFS) and boosting the gain changed nothing, so volume is not the problem.
* In 5 of 6 consults the stored transcript density (105–161 words a minute) matches what Chirp 2 hears on the whole recording (108–165).
* **One consult (19 Oct, 12.7 min) stored only 555 words (44 words a minute)** while the engines hear 1,100–1,800 on the same audio: about half of the speech never reached the stored transcript. Re-running the live path on that file (20-second segments, Chirp 2) gives no empty or failed segments, so the loss happened in that session (a failed or discarded segment, an interrupted recording, or an edit); the container logs from that day are gone, so the cause cannot be proven.
* **Chirp 3 produced 10,289 words for an 11-minute recording** (a repetition loop) and took 118 s. It must not run without an output guard.
* The cheapest model (Latest Long) heard only 183 words on the long file that Chirp 2 heard 1,801 in.
* The production database shows no ASR errors and no "empty segment" events in 30 days, so these failures were invisible to monitoring.

## 3. What was built
| Piece | What it does |
|---|---|
| **Engine chain** (`src/asr/engines.js`) | Primary engine, up to three fallbacks, per-engine timeout. Built-in default: **Chirp 2 → Gemini 2.5 Flash → Latest Long** |
| **Fallback triggers** | error, timeout, **empty result for audio that clearly contains speech**, and **impossible output** (over 260 words a minute or a repeated phrase) |
| **Circuit breaker** | an engine that fails 3 times in a row is skipped for 5 minutes (all open: the primary is still tried) |
| **Switch** | Admin console → **Speech to text**: choose primary and fallbacks, timeouts, clear counters, reset; saved in `ops.asr_settings`, live within 30 s, audited |
| **Comparison** | the same page shows this table and live health (calls, failures, empties, fallbacks used, average time) |
| Tools | `tools/asr-benchmark.mjs` (engines × recordings with human transcripts), `tools/asr-real-check.mjs` and `tools/asr-segments-check.mjs` (real consults, statistics only), `tools/asr-audio-levels.mjs` |

Cost guard unchanged: the premium Google models can never be billed in production.

## 4. Recommendations
1. Keep **Chirp 2 as primary** (Chirp 3 is only 0.5 point better and looped once). Revisit Chirp 3 after it has run behind the guard for a few weeks.
2. Keep the new default chain; use the **Speech to text** page to promote Gemini 2.5 Flash to primary if cost matters (8× cheaper, same accuracy, but it answers 429 under heavy parallel load, so keep Chirp 2 as its fallback).
3. **Add a completeness check after each recording**: compare the stored transcript's words-per-minute with the saved audio and offer "re-transcribe from the saved audio" when it is far below normal speech density. This is what would have caught the 12.7-minute consult. It needs a change in the web client, so it is not part of this change.
4. Run `tools/asr-benchmark.mjs` after any engine or setting change; keep human-transcribed recordings as the yardstick.
