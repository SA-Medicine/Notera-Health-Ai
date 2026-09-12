# ASR — Google Speech-to-Text with long-recording support

Replaces the former local faster-whisper path, which has been removed.

## The bug this fixes

Recordings of about five minutes or more produced no transcript at all. Two separate
causes, one on each side.

### Server: the API's hard limits were being run into, not handled

Google Speech-to-Text V1:

| Limit | Value |
| --- | --- |
| `recognize` (synchronous) audio length | ~60 seconds |
| Inline audio sent as base64 `content` | ~10 MB per request |
| `longRunningRecognize` audio length | 480 minutes, **but only via a `gs://` URI** — the inline size limit still applies |

At 16-bit 16 kHz mono PCM, 10 MB of audio is about five minutes, and base64 inflates the
request by a third. A 6.5-minute consult is **15.9 MB of base64** — it could not be sent
at all, and it was already ten times over the synchronous length limit. The old handler
sent the whole clip in one call and only discovered the problem from the error string
(`/too long|sync input|exceeds|1 min|duration/`), then retried with
`longRunningRecognize`, which hits the same inline ceiling. So anything past roughly a
minute depended on a catch-block guess and anything past a few minutes always failed.

A single transient `14 UNAVAILABLE` also lost a chunk outright: only
`longRunningRecognize` retried, never the synchronous path.

### Client: a failed request was treated as silence

`Scribe.tsx` records 20-second segments. In the old code any segment whose ASR request
failed counted toward the silence watchdog, and six consecutive "empty" segments
(~2 minutes) triggered `abortForSilence()`, which **cleared the transcript, the segment
list and the recorded audio** and reported "no speech detected". A run of server errors a
few minutes into a consult therefore erased the whole session. Results were also appended
in completion order, so variable latency could scramble the transcript the note is
generated from.

## How it works now

### Server — `src/asr/googleSpeech.js`

1. `transcodePcm16k` decodes any browser container to headerless 16 kHz mono PCM. The
   byte count gives the **exact** duration (MediaRecorder's WebM/Opus carries none, which
   is also why short clips used to be rejected as "sync input too long").
2. `planWindows` splits the PCM into windows of at most `ASR_WINDOW_SECONDS` (hard-capped
   at 55s). Each boundary is moved to the quietest 100 ms within
   `ASR_SPLIT_SEARCH_SECONDS` of the nominal cut, so a split rarely lands mid-word.
   Windows are **contiguous and non-overlapping**: every sample appears exactly once, so
   the stitched transcript neither drops nor repeats speech.
3. Windows are recognised with `ASR_WINDOW_CONCURRENCY` parallel calls and stitched back
   **in audio order**, not completion order.
4. Each window retries `ASR_RETRIES` times on a transient upstream failure
   (`UNAVAILABLE`, `RESOURCE_EXHAUSTED`, a deadline, a reset socket).
5. One window failing no longer loses the consult — the rest are still returned, and the
   count comes back as `failedWindows`. Only if *every* window fails does the request error.
6. Transient failures answer **503 with `Retry-After`** instead of 502, so the client
   re-sends that segment rather than writing the audio off.

`transcribeFromGcs` uses `longRunningRecognize` with the `gs://` URI — the one path where
Google itself handles unlimited duration — so stored consults need no download or windowing.

Chirp 2 (Speech-to-Text V2) shares the same ~60s synchronous limit, so `transcribeChirpPcm`
windows it identically — a long recording keeps the model it was configured with instead of
silently dropping to `latest_long`. Any Chirp failure falls back to the V1 path.

### Client — `apps/web/app/(app)/app/Scribe.tsx`

- Segments are keyed by **index** and the transcript always renders in index order.
- A failed segment retries `CHUNK_RETRIES` times with backoff. A **failure is not
  silence**: only a segment that transcribed successfully and came back empty counts
  toward the silence watchdog.
- The watchdog only discards a session when **no speech was ever captured** (a mic left on
  by mistake — the case it exists for). If real speech was captured, a quiet stretch is
  treated as part of the consult and recording continues.
- If any segment never transcribed, the **whole recording** is sent once after stop and
  used when it recovers more than the per-segment transcript did. This is the safety net
  that guarantees a long visit still yields a complete transcript after a bad patch.
- `Create SOAP` waits for in-flight segments so the note is never written from a
  truncated transcript.
- A rotation failure no longer ends capture silently: the recorder is retried with
  fallback options, a stall watchdog restarts a dead recorder, and an unrecoverable
  failure surfaces an error while keeping the transcript so far.

## Cost guard — production runs the cheapest model

`latest_long` is the cheapest standard model at **$0.016/min**. `medical_conversation`
and `medical_dictation` are premium, roughly **5× the rate**, and must never be billed.

`billableModel()` in `googleSpeech.js` enforces that **at the billing boundary** — inside
the module that actually issues the request, applied *after* any config override. The
callers check too, but the guard no longer depends on them remembering: no env value,
caller, or `configOverrides` can route a premium model to Google.

`ASR_MODEL=medical_conversation` is left as production has it; the startup log makes the
substitution explicit rather than silent:

```
[asr] Google Speech-to-Text — model=medical_conversation → billed as latest_long (cost guard) lang=en-US window=50s
```

Chirp / Chirp 2 (V2) are also standard-priced; a non-chirp value passed to the V2 path
falls back to `chirp_2` rather than sending an invalid or premium model name.

## Configuration

```
ASR_MODEL=medical_conversation   # forced to latest_long when billed
ASR_LANGUAGE=en-US
ASR_SAMPLE_RATE=16000

ASR_WINDOW_SECONDS=50            # per-window length (capped at 55s)
ASR_SPLIT_SEARCH_SECONDS=2       # quiet-point search band around each boundary
ASR_WINDOW_CONCURRENCY=3         # parallel recognize calls
ASR_RETRIES=2                    # transient-failure retries per window
ASR_MAX_UPLOAD=120mb             # must fit a whole consult (~0.5 MB/min WebM/Opus)

ASR_FFMPEG_TIMEOUT_MS=45000      # decode budget: base…
ASR_FFMPEG_PER_MB_MS=4000        # …plus per-MB…
ASR_FFMPEG_MAX_TIMEOUT_MS=600000 # …capped here
```

`ffmpeg` must be on `PATH` (the backend image installs it). Without it the handler falls
back to sending the container as-is, which cannot be windowed and so is limited to what
synchronous `recognize` accepts — long recordings fail again. Startup therefore checks for
it and says so loudly:

```
[asr] ✓ ffmpeg version 7.1 … — long recordings will be windowed
[asr] ✓ GCP credentials: /app/secrets/sa-key.json
```

`GOOGLE_APPLICATION_CREDENTIALS` may be written relative to the repo root (for example
`./secrets/sa-key.json`). Google's auth library resolves it against the process CWD, but
the backend starts from `packages/backend`, so `loadEnv.js` anchors a relative value to
the repo root — otherwise every Speech call would fail on credentials depending on where
node was launched.

## Verifying it

```bash
node scripts/verify_asr.mjs <recording>           # FREE: no API call
node scripts/verify_asr.mjs <recording> --live    # BILLED: real Google call
```

The dry run checks ffmpeg, credentials, which model will actually be billed, the exact
decoded duration, the window plan, that every window fits the synchronous limit, and that
the windows are contiguous. It also reports whether the clip would have exceeded the two
old ceilings. `--live` adds the real call and prints the estimated cost first.

## Tests

`packages/backend/test/asr.audio.test.mjs` covers duration from the byte count, window
sizing against the synchronous limit, contiguity (nothing lost or doubled), quiet-point
splitting, in-order stitching under concurrency, survival of a single failed window,
transient retry, and the all-windows-failed error. A fake `SpeechClient` keeps it runnable
without GCP credentials.

---

# Duplication in the Assessment & Plan

Reported as: on a long transcript the Assessment "explains the same thing in separate
wordings". Verified against a real 7-minute consult through the live pipeline. Four
separate causes were found.

### 1. Nothing compared two A&P entries to each other

`condenseNote` de-duplicated only *within* a single problem's `assessment`, and the story
engine / tightener can emit the same condition twice ("Hypertension" and "Elevated blood
pressure") as two numbered problems. `dedupeNote` now merges those and removes repeats
across problems and across fields.

### 2. Paraphrases share no words

"Hb not improving despite oral iron" and "anaemia has not responded to iron
supplementation" are one point with almost no lexical overlap. `semanticDedupe` asks the
LLM to group lines that mean the same thing; it only ever returns line IDs, never text, and
every proposed group is vetted against conflicting numbers, drugs and meaning markers. On
the live run it correctly collapsed two paraphrased Subjective duplicates.

### 3. The plan-action guard never matched — so it never guarded anything

The pattern was `/(continu|increas|prescrib|refer|…)/i`. Closing the group with ``
makes every stem unmatchable: "continu" needs a word boundary after it, and "Continue" has
an "e" there. So "Continue metformin 1 g twice daily", "Increase amlodipine to 10 mg",
"Prescribed paracetamol" and "Referral to diabetes educator" were all classified as
narrative, leaving real orders unprotected from deletion. Now in `clinicalPhrasing.js`,
with the stems as prefixes and a test asserting each inflection.

### 4. Plan fields are one line of several sentences

This is what made the bleed visible in the rendered note. The tightener returns
`treatment_planned` as a single line holding several sentences; the renderer sentence-splits
it into separate bullets afterwards. `condenseNote` split only on newlines, so one action
verb anywhere in that blob protected every bled history sentence beside it:

```
1. **Hypertension**
   - Treatment: Increase amlodipine to 10 mg once daily.          ← real order
   - Treatment: Patient presents for 3-month review noting headaches have returned…   ← HPI
   - Treatment: Reports home BP has been sitting around 150/90 mmHg…                  ← HPI
   - Treatment: Adherent to amlodipine 5 mg daily.                                    ← history
```

The plan-field pass now sentence-splits like the renderer does.

## The safety rules that make removal safe

Removal is always two-sided — positive evidence is required, never just the absence of a
counter-signal:

- **`isBledHistory`** removes a plan line only when it positively reads as history AND
  carries no action verb. A bare order with no verb at all ("Paracetamol 1 g PRN", "Kidney
  function and electrolytes") is therefore never removed.
- **`subjectiveHasContent`** gates that removal: if the Subjective is empty, the plan field
  is the only record of the history and nothing is dropped.
- **`addsInformation`** keeps any line naming a drug, test or value the matched line lacks.
  Without it, "Liver function tests and repeat lipid panel in 3 months (alongside HbA1c)"
  was discarded as a duplicate of "Repeat HbA1c in 3 months" — silently deleting two
  orders. This was caught on a live run, not in review.
- **Conflict guards** block any merge across conflicting numbers, drugs/analytes, or
  meaning markers (left/right, negated/affirmed, improving/worsening, start/stop, severity,
  declined/accepted).
- **A problem is never emptied** to a bare numbered heading, and neither is a section.

## Verified result

Live run, 7-minute consult, full production agent chain: 5 distinct problems, 19 A&P lines,
no duplicate problem titles, no duplicate lines, Assessment holding interpretation and
Treatment holding orders, and every medication, referral, investigation and follow-up
interval from the transcript present.

## Tests

`test/dedupeNote.test.mjs`, `test/textSimilarity.test.mjs`, `test/clinicalPhrasing.test.mjs`
— 51 tests in total with `test/asr.audio.test.mjs`. The fixtures are lines taken verbatim
from live runs, and the safety assertions outnumber the recall ones deliberately: a missed
duplicate is cosmetic, a wrong merge deletes clinical information.
