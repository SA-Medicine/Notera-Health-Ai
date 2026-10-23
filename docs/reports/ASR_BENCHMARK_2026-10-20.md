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

## 5. Completeness check after each recording (built and live)
* **When:** when a recording finishes, the app compares the transcript's words per minute with the length of the recording. It only judges recordings of two minutes or more. Below **75 words a minute** (normal conversation is 100–160; the 12.7-minute consult that lost half its speech was at 44) a banner offers **Re-transcribe**. The check costs nothing: it is two numbers already in the browser.
* **What the click does:** the full recording kept by the browser is sent to `POST /api/asr?rerun=1`, which transcribes it with **Gemini 2.5 Flash** (Chirp 2 only if Gemini fails). The new text replaces the old one only if it holds at least 15 % more words; otherwise the transcript is kept and the doctor is told the recording holds no more speech.
* **Cost:** about $0.03 for a 12-minute recording; at most one offer per recording; a per-person cap of 30 re-runs a day (`ASR_RERUN_PER_DAY`).
* **Live check on the deployed backend:** a 10.4-minute recording took 8.1 s through the re-run path (Gemini 2.5 Flash, 1,169 words) and 10.0 s through the normal path (Chirp 2, 1,136 words).
* After a re-transcribe the doctor presses Create note again; the existing note, if any, is not changed automatically.

## 6. Accuracy round (2026-10-23): medical vocabulary and a second opinion
Triggered by a real comparison where the speech text had "class tenderness" for **calf tenderness**, "my uncle swells" for **my ankles swell**, "light headache" for lightheadedness and a dropped patient question. Chirp 2 had been sent no medical vocabulary at all.

**Built** (`src/asr/medicalVocab.js`, `consensus.js`, `googleSpeech.js`, `engines.js`; tests `test/asrAccuracy.test.mjs`, `asrEngines.test.mjs`; tool `tools/asr-variants.mjs`):
* **Medical vocabulary** (about 485 phrases, boosted): generic drug names, Canadian brands and clinical words mined from the 2,801 gold notes, plus anatomy, symptom and women's-health words. Switch: `ASR_HINTS=0` turns it off.
* **Second opinion** (`crossCheck`, on by default, switch in the admin console "Speech to text"): a different kind of engine hears the same audio at the same time (Gemini checks Chirp 2; Chirp 2 checks Gemini). A medical word it heard that sounds like an ordinary word in the first text replaces it; a run of 6 or more words the first engine dropped is added only between two stretches both agree on. A failed, slow or looping second engine changes nothing. About $0.002 a minute, no extra waiting (it runs alongside).
* **Overlap windows**: built and measured, then switched off (`ASR_OVERLAP_SECONDS` enables them).

**Measured** (9 recordings with human transcripts, mean per recording; the benchmark recordings are simulated visits):
| Variant | Word error rate | Missed words | Medical-term recall | Key-token recall |
|---|---|---|---|---|
| Chirp 2 as before | 11.03 % | 2.3 % | 97.0 % | 91.2 % |
| + vocabulary hints | 10.80 % | 2.2 % | 97.4 % | 91.5 % |
| + hints, second opinion from Gemini | 10.80 % | 2.2 % | 97.9 % | 92.1 % |
| Gemini 2.5 Flash alone | 10.41 % | 2.0 % | 97.8 % | 94.0 % |
| Gemini primary, second opinion from Chirp 2 + hints | **10.44 %** | **2.0 %** | **99.4 %** | **94.0 %** |
Overlap windows: worse on 5 of 6 recordings measured (for example 7.7 % to 8.4 %), so off. Word-time overlap was worse still.

**Reading it honestly:** the differences are small (0.2 to 0.6 points) and the recordings are not real doctor calls. Hints never made a recording worse in meaning (one file lost an exact match because Chirp wrote "acetaminophen" for "Tylenol"). Gemini 2.5 Flash was at least as accurate as Chirp 2 and misses fewer words; the best measured setup is **Gemini as the primary engine with Chirp 2 as the second opinion**. Production still has Chirp 2 as primary (proven in daily use); the owner can switch the primary in the admin console. Gemini answers 429 under heavy parallel load, which the fallback chain handles.

## 7. Cost review (2026-10-23): Gemini 2.5 Flash becomes the primary engine
Data: 12 held-out recordings the earlier tests never saw (public simulated interviews, git-ignored copy in `audio_data/`; not real clinic calls), plus the live recording path (20-second chunks, 6 recordings).
| Setup | Word errors | Medical-term recall | Key-token recall | Speech cost per audio minute (estimate) |
|---|---|---|---|---|
| Chirp 2 + hints + Gemini second opinion (was production) | 6.34 % | 97.9 % | 98.0 % | $0.018 |
| Chirp 2 + hints | 6.36 % | 97.9 % | 98.0 % | $0.016 |
| **Gemini 2.5 Flash alone (now production)** | **5.92 %** | **99.5 %** | **98.1 %** | **about $0.002** |
| Gemini primary + Chirp 2 second opinion | 5.95 % | 99.5 % | 98.1 % | $0.018 |
Live path, 20-second chunks: Chirp 2 + hints 6.95 % / 99.0 % / 97.1 %, **Gemini 2.5 Flash 6.84 % / 100 % / 98.5 %**; the second opinion changed nothing in either direction.
**Change made** with `tools/asr-set.mjs` (same store as the admin console, `updated_by` records why): primary `gemini-2.5-flash`, fallbacks `chirp_2` (with the medical vocabulary) then `latest_long`, second opinion **off** (it added cost, no accuracy). About 89 % less speech-to-text spend: a 12-minute visit costs about $0.02 instead of $0.18. A 20-second chunk answered in 1.4 s on the live check.
**Revert** in the admin console, Speech to text: pick Chirp 2 as the primary (the second-opinion switch is there too). If Gemini answers 429 under load, the chain already falls back to Chirp 2 and a breaker skips Gemini for 5 minutes after 3 failures in a row.
**Cost levers still open:** note generation makes several Gemini calls per note (writer, checklist, verifier, editor, story, attribution, sweep, grounding); its cost per note has not been measured yet. Trimming silence before transcription and skipping the second look at doubtful lines when none are flagged are the next candidates, each to be A/B tested.
