# Notera — how the system works, from the microphone to the signed note

Written 2026-10-27 from the code as it runs in production (backend commit `d773604`, Style Spec v2.3.3).
Plain language, short lines. Model names, times and costs are the measured ones from the 30-note gold test unless it says otherwise.

---

## 1. The whole thing in one picture

```
 DOCTOR'S BROWSER (web app, Cloudflare Pages)
 ───────────────────────────────────────────
  microphone ─► 20-second pieces ──► /backend/api/asr  ──┐          (one piece at a time, 3 at once)
      │                                                  ▼
      │                                      BACKEND (Express, GCP VM, Docker)
      │                                      ───────────────────────────────
      │                                       1. decode audio to 16 kHz PCM (ffmpeg)
      │                                       2. speech-to-text ENGINE CHAIN
      │                                          Chirp 2 ─► Gemini 2.5 Flash ─► Latest Long
      │                                       3. clean repeated phrases
      │                                                  │
      │        text of that piece  ◄─────────────────────┘
      ▼
  transcript is built in the browser, piece by piece, in order
      │
      │  doctor presses "Create SOAP"
      ▼
  /backend/api/consults/async  ──► NOTE PIPELINE (generateNoteV2)  ──► note saved in Postgres
      │                               writer, checks, story, fact ledger, guards …
      │  every 2.5 s: "is it ready?"            │
      └─────── /api/consults/job/<id> ◄─────────┘
      ▼
  note shown on screen  +  medicines box  +  "read before you sign" checks
      │
      ▼
  doctor edits / fixes  ──► saved to History (their version + what they corrected)
```

Three separate things live on the same GCP VM (`notera-app`):

| Container | What it is | Who uses it |
|---|---|---|
| `notera-backend` | the real product API: sign-in, speech-to-text, note pipeline, library | the doctors' web app |
| `notera-lab` | testing lab: gold-set tests, Super run, auditors | the owner, through the admin console |
| `notera-studio` | Notera Studio: style interviews, reviewing, proposals | the training doctor |
| `notera-postgres` | the database | the backend, lab, studio |
| `notera-caddy` | the front door (TLS) in front of `api.aitoolsfordoctor.com` | Cloudflare → Caddy → backend |

Where the screens live:

| Screen | Where it runs | Deploys by |
|---|---|---|
| Doctor web app (`/app`, `/login`, History) | Cloudflare Pages project `notera-app` | every push to `main` |
| Admin console (Quality, Super run, Speech, Prompts, Settings …) | Cloudflare Worker `notera-admin` | `wrangler deploy` in `apps/admin-site` |
| Studio site | `apps/studio-site` | its own deploy |

The browser never talks to Google directly. Every call goes to `/backend/...` on the same web address; the web app forwards it to the backend. Sign-in is a cookie that the backend checks on every call.

---

## 2. Step by step: from audio to transcript

This all happens in the doctor's browser plus the `/api/asr` route of the backend.

### 2.1 In the browser (`Scribe.tsx`)

1. Doctor presses **Record**. The browser asks for the microphone.
2. The browser gives the visit **one consult id** straight away (`CONS-<time>-<random>`). Everything about this visit — recording, transcript, note — is saved under that id.
3. Two recorders start on the same microphone:
   - a **whole-visit recorder** (one long file, a piece every second),
   - a **segment recorder** that cuts the audio into **20-second pieces**.
4. Every second of the whole-visit audio is also copied into the browser's own storage (IndexedDB, `audioVault.ts`). It stays there until the server confirms it has the recording.
5. Each finished 20-second piece is queued. **3 pieces are sent at the same time** to `/backend/api/asr`. A failed piece is retried 3 times (after 1 s, 4 s, 10 s).
6. The text of each piece comes back and is put in order by its number, so a slow piece can never scramble the transcript.
7. Safety rules while recording:
   - 9 pieces in a row with **no speech** (about 3 minutes) and no speech ever heard → recording is stopped and thrown away (mic left on by mistake).
   - If speech was heard earlier, a quiet stretch is allowed (long examination).
   - If the recorder dies, a watchdog restarts it.
   - The screen is kept awake while recording.
8. Doctor presses **Stop**. The browser waits for the last pieces to finish. Any piece that failed all retries is recovered by sending the **whole recording** once.
9. When the transcript is final, the browser **saves the visit to the server straight away** (transcript + recording upload, with retries). It does **not** wait for the note. If this fails, the recording stays in the browser and is saved again automatically on the next page load.

If the doctor pastes a transcript instead of recording, steps 1–8 are skipped.

### 2.2 In the backend (`/api/asr`, `src/proxy.js` + `src/asr/`)

For every 20-second piece:

1. **Receive** the audio bytes (needs a signed-in user; free accounts have a daily piece limit).
2. **Decode** to plain 16 kHz mono PCM with ffmpeg. This gives the exact length.
3. **Engine chain** (`engines.js`) — the first engine that gives a good answer wins:
   1. **Chirp 2** (Google Speech-to-Text V2, with the medical word list) — default first choice.
   2. **Gemini 2.5 Flash** (audio) — used if Chirp 2 fails, times out, or returns nothing for audio that clearly has speech.
   3. **Latest Long** (Google V1) — last resort.
   - A **circuit breaker** skips an engine that failed 3 times, for 5 minutes.
   - A **guard** treats impossible output as a failure (more than ~260 words a minute, or the same phrase over and over).
4. **Cross-check**: a second engine (Gemini 2.5 Flash when Chirp is primary) transcribes the same audio at the same time. Where the first transcript has a gap or an obvious swap, the second one's words fill it in (`consensus.js`).
5. **Clean-up**: repeated phrases are collapsed to two copies (`loops.js`).
6. The text goes back to the browser as JSON: `{ text, engine, durationSeconds, … }`.

The owner can change the primary engine, fallbacks, timeouts and the cross-check in the admin console → **Speech to text**. Audio itself is not logged.

---

## 3. Step by step: from transcript to note

The doctor presses **Create SOAP**.

### 3.1 Starting the job (browser → backend)

1. A second click is ignored (`creating` flag) and the backend also refuses a second job for the same consult id. (On 2026-10-26 one recording produced three notes in 0.2 s; that is why.)
2. The browser sends `{ consultId, transcript, specialty, patientMeds }` to `/api/consults/async`.
3. The backend checks the free-note quota, **registers the job first**, and answers at once with a `jobId` (HTTP 202). The pipeline then runs in the background.
4. The browser stores `{ jobId, consultId }` in `localStorage` and shows the waiting screen with a seconds counter.
5. Every 2.5 seconds the browser asks `/api/consults/job/<jobId>?consultId=…`. The answer is one of:
   - `pending` — keep waiting;
   - `done` — here is the note;
   - `error` — it failed (the quota is refunded);
   - `lost` — the server restarted and forgot the job. The backend then looks in the database: if the note was already saved it returns it; if not, the browser starts the job once more under the **same consult id**.
6. If the doctor refreshes or closes the page, the stored job is picked up again on the next load.

### 3.2 The pipeline (`src/orchestrator/generateNoteV2.js`)

Time is the average per note on the gold set; many steps overlap.

**Read this as a list of "who gets the transcript, and what they hand on".**

| # | Stage | Kind | Model | Gets | Hands on | Time |
|---|---|---|---|---|---|---|
| 0 | **Input check** | code | — | transcript | "is this a consultation / is it blank?" A blank visit gives an empty note, never an invented one | <1 s |
| 1a | **Writer** | AI | Gemini 3.7 Flash (fallback 2.5 Flash) | transcript + 2 doctor-written example notes + the locked style prompt | the full SOAP note as structured data | ~11 s |
| 1b | **Checklist** | AI, **in parallel** | Gemini 3.5 Flash-Lite | transcript | list of medicines, results, orders the transcript contains | ~4 s |
| 1c | **Fact graph** | AI, **in parallel** | Gemini 3.5 Flash-Lite | transcript, cut in 650-word windows | every fact with an id (F001…), its type, importance and **exact quote**; quotes are checked against the transcript by code | runs beside the writer, so it adds little |
| 2 | **Writer retry** | AI, only if needed | same model, and fallback model **at the same time** | the same prompt + a warning | a draft with a plan and no loop. Needed when the first draft has no Assessment & Plan or repeats itself | rare, up to 18 s |
| 3 | **Editor** | AI | Gemini 2.5 Flash | writer's note + transcript | fixes: wrong section, plan item under the wrong problem, contradictions, padding. Capped at 12 s, otherwise the writer's note is kept | ~3 s |
| 4 | **Merge** | code | — | note + checklist | adds anything the checklist found that the writer dropped (only if the transcript really says it) | <1 s |
| 5 | **Placement fixes** | code | — | note | things in the wrong place are moved; drug-name sanity; template enforced | <1 s |
| 6 | **Verifier** | AI | Gemini 3.5 Flash-Lite | note + transcript | ids of lines that are **unsupported** or **duplicates**; **code confirms** each before deleting it | ~1 s |
| 7 | **Guardrails + condense + dedupe** | code | — | note | schema check, safety flags, identical lines removed | <1 s |
| 8 | **Plan attribution** | AI | Gemini 2.5 Flash | note + transcript | moves plan items to the problem they belong to (quote-checked, at most 6) | runs beside the story |
| 9 | **Story agent** | AI | Gemini 2.5 Flash | Subjective + Past Medical History + transcript | the same facts grouped by topic in short, flowing 1–2 line bullets. **Code rejects the rewrite** if it loses a fact or adds a word of its own, then the old text is kept | ~4 s |
| 10 | **Plan sweep** | AI | Gemini 2.5 Flash | note + transcript | an issue the doctor dealt with that has no problem in the plan (quote-checked, at most 4) | ~2 s |
| 11 | **Plan completeness** | AI | Gemini 2.5 Flash | note + transcript | a plan item that was said but is missing | 1–3 s |
| 12 | **Coverage check** | AI | Gemini 2.5 Flash | finished note + transcript | everything said that is missing, placed under its topic (exact quote required) | ~7 s |
| 13 | **Fact ledger** | code + AI | Gemini 2.5 Flash | note + the fact graph | every required fact is **matched to a note line by code**. A fact not found goes to one AI call that either points at the line or says where it belongs. Anything critical still missing is **written in by rule**. Report: found / placed / written in / missing | ~5 s |
| 14 | **Story merge** | AI | Gemini 2.5 Flash | the facts that arrived after step 9 | merged into the topic bullets they belong to (second story pass; rejected if it duplicates a topic) | ~2 s |
| 15 | **Grounding check** | AI, **runs beside steps 12–14** | Gemini 2.5 Flash | a copy of the note + transcript | every line checked against the transcript: unsupported lines removed (max 20 %), doubtful ones flagged for the doctor | ~10 s, hidden |
| 16 | **Reference names** | code + NIH web services | RxNorm, ICD-10-CM | drug and diagnosis words only | brand → generic names, diagnosis codes | ~1 s |
| 17 | **Fidelity guards** | code | — | note + transcript | a drug or test the recording never names is replaced or removed; invented smoking / alcohol / living details removed; empty headings tidied | <1 s |
| 18 | **Plan join** | code | — | note | each label (Treatment, Advice …) appears once per problem | <1 s |
| 19 | **Render** | code | — | note | the Markdown the doctor sees; Advice and Follow-up on their own lines; Treatment as Started / Changed / Stopped / Continued / Given today | <1 s |
| 20 | **Drug check** | code + RxNorm | — | rendered note + transcript + the pasted EHR medicine list | for every drug: known name? real strength? "did you mean …?" → fills the **medicines box** | ~1 s |
| 21 | **Save** | code | — | everything | consult marked `ready`, draft saved in Postgres with flags and quality data (fact ledger, timings, drug stats) | <1 s |

Typical total: **38 s** average, 9 in 10 notes within 47 s, the longest visit tested (3,533 words) 53 s.
Typical cost: **about $0.075 per note** (about 25 AI calls).

### 3.3 What the "fact graph + ledger" is for

The owner's rule: *missing a critical fact is the worst failure.*

- The **fact graph** reads the visit independently of the writer and lists every fact with its exact words.
- The **ledger** then asks, for each important fact: "is it in the finished note?" — by comparing words and numbers, not by trusting a model.
- A medicine instruction (continue / renew / start / stop …) only counts as present if it is in the **plan**, not just on the Medications list.
- Facts that are not in the note get placed. Critical facts are always written in.

### 3.4 What is *not* allowed to change (Style Spec lock)

The note format approved by the doctor (`docs/STYLE_SPEC_V2_LOCKED.md`) is frozen. The writer prompt, the guards and the renderer are fingerprinted (`packages/backend/spec/LOCK.json`). `node scripts/spec-lock.mjs` and `test/specLock.test.mjs` fail if they change without the owner's explicit unlock. New work is built around the pipeline, never inside the locked files.

---

## 4. Step by step: from finished note to the doctor's screen

1. The browser receives `{ renderedNote, flags, consultId }`.
2. **Note** is shown, section by section (Subjective, Past Medical History, Objective, Assessment & Plan).
3. **"Before you sign" checks** (`NoteChecks.tsx`): every flag the pipeline raised — lines that look doubtful, numbers not in the recording, laterality, unknown drugs — with one-click fixes and an Undo.
4. **Medicines box** (`DrugBox.tsx`): each drug, "known drug / not known / did you mean …", the dose, and a one-click or typed fix. It has a **Drug suggestions** switch (remembered in the browser).
5. The doctor edits. About a second after the last change the browser saves **their version** and **what they corrected** to History (`PUT /api/library/consults/<id>/note`). Corrections are stored for learning; they are **never applied to the pipeline automatically**.
6. **Copy** / **Copy to EMR** puts the note on the clipboard.
7. **History** lists past visits; opening one shows the doctor's saved version.

Errors are shown in plain words with what to do next ("Your recording and transcript are saved — press Create SOAP again"). Raw server text is never shown. A strip under the top bar says whether the recording is **saved**, **saving**, or **kept in this browser and saving again**.

---

## 5. Where the data lives

| What | Where | Notes |
|---|---|---|
| Users, plans, free-note counters | Postgres `auth.users` | sign-in cookie signed by the backend |
| Consults (id, specialty, status, transcript, audio link) | Postgres `clinical.consults` | saving a consult again never wipes its recording or transcript |
| Drafts, the doctor's final version, corrections | `clinical.drafts`, `clinical.finals`, `clinical.feedback` | |
| Recordings | Google Cloud Storage bucket (`GCS_AUDIO_BUCKET`) | `audio/<user>/<consult>.webm`; opened by signed link only |
| Pipeline runs, errors, audio events | `ops.pipeline_runs`, `ops.errors`, `ops.audio_events` | no transcript or note text in them |
| Settings changed in the admin console | `ops.runtime_config` (+ history), `ops.asr_settings`, `ops.prompt_versions` | cached 30 s |
| Quality data per note | inside the draft: `metadata.quality` | read by the admin **Quality** page |
| Gold-set results, Super run results | lab volume `/lab-data` | not in the clinical tables |
| Recording copy in the doctor's browser | IndexedDB `notera-audio` | deleted when the server confirms the upload |
| Note-in-progress pointer | browser `localStorage` `notera.pendingNote` | cleared when the note arrives |

---

## 6. The admin side

| Page | What it shows |
|---|---|
| **Quality** | per day: how many facts the notes had, how many were found / placed / written in / missing, drug-check numbers, time per stage |
| **Super run** | one stored recording through everything: two speech models, a reviewer that listens, the note, the audit. Optionally **two notes side by side** (production Flash writer and Gemini 3.1 Pro), each with time, cost and audit |
| **Speech to text** | engine chain, fallbacks, breaker, cross-check |
| **Prompts / Settings** | model per stage, timeouts, stage switches (changes reach the pipeline within ~30 s, every change is recorded) |
| **Consults / Audio / Users** | what was recorded and by whom; opening a recording is written to the audit log |
| **Errors / monitor** | `ops.errors`, e-mail alerts when a threshold is crossed |

The **lab** also runs the gold test (`tools/gold-eval.mjs`): 30 doctor-written notes, each re-written by the pipeline and scored by two judges (Gemini 2.5 Pro and Flash). A change reaches production only if it does not increase critical misses.

---

## 7. Models in use (2026-10-27)

| Job | Model |
|---|---|
| Speech-to-text | Chirp 2 → Gemini 2.5 Flash → Latest Long (+ Gemini cross-check) |
| Writer | Gemini 3.7 Flash (fallback 2.5 Flash) |
| Checklist, verifier, fact graph | Gemini 3.5 Flash-Lite |
| Editor, story, attribution, sweep, completeness, coverage, ledger, grounding | Gemini 2.5 Flash |
| Judges and auditors (lab only) | Gemini 2.5 Pro and 2.5 Flash |
| Drug names / diagnosis codes | RxNorm and ICD-10-CM (NIH), no AI |

All through **Vertex AI** with the project's service account, `global` endpoint (the new Flash models exist only there; 2.5 Flash is in every region).

Checking stages think a little (double the old budget — measured better); the writer is Flash with no extra setting. When Google answers **429 (busy)**, the call is retried after a short wait, then on another endpoint or a sibling model.

**Limits:** the project has 50 million input tokens a minute per new Flash model and no per-project request cap. One note uses ~150 000 tokens. The 429 errors come from Google's *shared* capacity being full, not from our quota. Only Provisioned Throughput (paid) guarantees capacity.

---

## 8. What can go wrong, and what the system does

| Problem | What happens |
|---|---|
| Speech engine fails or returns nothing | next engine in the chain; after 3 failures an engine is skipped for 5 minutes |
| One 20-second piece fails 4 times | the whole recording is sent once to recover it |
| Internet drops while recording | pieces keep queuing; audio is also in the browser's storage |
| Page refreshed / tab closed during recording | on next load the recording is found, transcribed from the audio if needed, saved, and shown in History as "Recovered recording" |
| Page refreshed while the note is written | the pending job is picked up; the note appears when ready |
| Server restarts while the note is written | status `lost` → the note is looked up in the database, or started again once under the same id |
| Double click on Create SOAP | ignored in the browser, refused by the backend |
| Writer draft has no plan or loops | retried on two models at once; the better draft is kept |
| Google answers 429 | backoff, then another endpoint or sibling model |
| A step times out (editor, story …) | that step is skipped and the earlier note is kept — a step never makes the note worse |
| Model invents something | the verifier/grounding check removes or flags it; the story agent is rejected if it adds words |
| Sign-in expires | clear message; nothing is lost, the note will be in History |
| Free notes used up | pricing screen; failed notes are refunded |

---

## 9. Known limits (honest list)

- Critical misses are **not zero**: about 0.6 per note on average on the gold set, and about 6 in 10 notes have at least one. The doctor must read the plan's medicine lines before signing.
- About 1 note in 60 goes over 60 seconds (the writer's first draft failed and had to be redone).
- Some plan lines still start with "Other:" (real tasks such as "obtain pre-authorization forms").
- The Medications line can leave out a drug that is only in the plan.
- Scores from the lab vary by ±5 points between identical runs; only differences measured in paired runs count.
- The doctor's EHR is not connected. The medicine list is pasted by hand into the box in the app; it is used only to check drug names.

---

## 10. Where to look in the code

| Topic | File |
|---|---|
| Recording, transcript, note flow in the browser | `apps/web/app/(app)/app/Scribe.tsx` |
| Recording kept in the browser | `apps/web/app/(app)/app/audioVault.ts` |
| Checks and medicines box | `NoteChecks.tsx`, `DrugBox.tsx` (same folder) |
| Speech-to-text route | `packages/backend/src/proxy.js` |
| Engine chain | `packages/backend/src/asr/engines.js` (+ `googleSpeech.js`, `consensus.js`, `loops.js`) |
| Note job routes | `packages/backend/server.js` (`/api/consults/async`, `/api/consults/job/:id`) |
| Note pipeline | `packages/backend/src/orchestrator/generateNoteV2.js` |
| Writer prompt (locked) | `packages/backend/prompts/writer-v5.txt` |
| Fact graph / ledger | `factGraph.js`, `factLedger.js` |
| Coverage, sweep, completeness, attribution, grounding | `noteCoverage.js`, `planSweep.js`, `planComplete.js`, `planAttribution.js`, `groundingAgent.js` |
| Rendering | `renderMarkdown.js`, `adviceLines.js`, `treatmentStructure.js` |
| Drug check | `drugCheck.js` |
| Model calls, retries, 429 handling | `packages/backend/src/services/LLMService.js` |
| Settings editable in the console | `runtimeConfig.js` |
| Library (save / history / audio upload) | `packages/backend/src/library/libraryRoutes.js` |
| Admin console | `apps/admin-site/public/*.js` |
| Lab, Super run, gold test | `packages/backend/lab/`, `packages/backend/tools/gold-eval.mjs` |
| Quality history of the notes | `docs/NOTE_QUALITY_PLAN_2026-10-24.md` |
| The locked note format | `docs/STYLE_SPEC_V2_LOCKED.md` |
