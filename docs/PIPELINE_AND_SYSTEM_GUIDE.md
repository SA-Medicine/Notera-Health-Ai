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

---

## Appendix — every prompt the system sends, word for word

Captured on 2026-10-27 by running one real note through the **production** backend (`notera-backend`, commit `d773604`+) and recording the system prompt of every model call. This is exactly what the models receive, after any override. No prompt overrides are stored in the database (`ops.prompt_versions` is empty), so the code defaults below are the live ones.

How to read it:
- The **system prompt** is the standing instruction. The transcript (or the note) is sent separately as the **user message** — that part is never included here, because it is the patient's visit.
- The numbers match the stage table in section 3.2.
- The **writer** prompt is locked (Style Spec v2.3.3). Everything else can be edited in the admin console or in code, but changes to locked files need the owner's unlock phrase.
- **Not in this list:** the plan-completeness prompt (`planComplete.js`) exists but is skipped while the coverage check is on, and the older v1 pipeline prompts (Heidi story engine, hallucination remover, structuring, tightening, semantic de-duplication) are not used by the production path.

**The five prompts on the admin → Prompts page** (the ones you can open and edit there) are numbers **4 Writer, 5 Checklist, 6 Editor ("Reviewer"), 7 Verifier and 9 Story agent**. Their sizes on that page (16,276 / 728 / 2,703 / 739 / 4,011 characters) match the text below.
One difference to know: the Story agent page shows **4,011** characters, but the model receives **4,655**. The code adds the length rule ("LENGTH: write like the physician who reads it — fewer, fuller bullets …", 644 characters) to the stored story prompt every time it runs, so that rule does not show on the Prompts page. Below is the full text the model really gets.
The other prompts (2, 3, 8, 10, 11, 12, 13) live in the code and are not editable from the Prompts page; changing them means a code change. 14–16 are lab-only.

### Index

| # | Prompt | Used in step |
|---|---|---|
| 1 | Gemini speech-to-text instruction | transcript, fallback and cross-check engine |
| 2 | Fact extractor (observation extractor) | step 1c, fact graph |
| 3 | Fact recovery | step 1c, fact graph (second sweep) |
| 4 | **Writer** (locked) + example header + retry note | step 1a, 2 |
| 5 | Checklist | step 1b |
| 6 | Editor | step 3 |
| 7 | Verifier | step 6 |
| 8 | Plan attribution | step 8 |
| 9 | Story agent (+ compaction + merge instruction) | steps 9 and 14 |
| 10 | Plan sweep | step 10 |
| 11 | Coverage check | step 12 |
| 12 | Fact ledger | step 13 |
| 13 | Grounding check (+ second look) | step 15 |
| 14 | Audit prompt (lab) | Super run, gold test audits |
| 15 | Gold-set judge (lab) | gold test scoring |
| 16 | Transcript reviewer (lab) | Super run, step 2 |

### 1. Gemini speech-to-text instruction

**Where:** `src/asr/engines.js` — sent with the audio when Gemini 2.5 Flash is the engine (fallback, cross-check, re-transcribe).

Model: `gemini-2.5-flash` (audio in). The audio is the user message.

~~~~text
Transcribe this recorded medical consultation word for word, in English, as plain text without speaker labels. Write numbers, doses and drug names exactly as spoken. Do not summarise, correct, explain or add anything. If there is no speech, output nothing.
~~~~

### 2. Fact extractor (observation extractor)

**Where:** `src/pipeline/agents/ClinicalObservationExtractorAgent.js` — step 1c. Runs once per 650-word window of the transcript, plus a detail sweep. Answer is forced into a JSON schema.

Model: `gemini-3.5-flash-lite` · answer limit default tokens · thinking budget default · temperature 0

~~~~text
You are a Universal Clinical Knowledge Graph Engine.
Extract every clinically relevant entity from the transcript into a structured Graph.

Rules:
1. Never summarize. Never combine entities. One clinical fact = one record.
2. source_quote: Provide the exact verbatim transcript snippet that proves this entity. This is CRITICAL for provenance.
3. locked: Set to true for ANY diagnosis, medication, lab, or order to prevent downstream modification.

Context Preservation Rules:
Extract ALL narrative context including:
- injury mechanisms ("landed on left knee with twisting mechanism" -> injury_mechanism)
- environmental context ("fixing garage door opener" -> contextual_activity)
- patient quotes and precise desires/fears (e.g. why patient refused/postponed a referral or test)
- counseling & patient education (e.g. details of barrier contraception, post-OCP bleeding patterns, cervical screening age rules, clinic priority line info)
- treatment history ("study treatment for 7 years" -> treatment_duration)
- resolved symptoms ("knee swelling now resolved" -> resolved_symptom)
- previous episodes ("three ankle sprains while building deck" -> previous_episode)
- lifestyle behaviors ("watching diet and avoiding sugar" -> lifestyle_modification)
- medication tolerance ("no nausea with ozempic" -> medication_tolerance)
- clinician reasoning and precise action steps ("clinician_reasoning", e.g. plans to fax/reissue lost requisitions)
- secondary complaints & sleep management (e.g. insomnia, over-the-counter sleep aids like dimenhydrinate, or plans to provide medication samples)
- home & environmental controls ("humidity controlled in home, never low" -> social_history / clinical_context)
- anatomical multi-site symptom inventory (e.g., if patient reports aching or swelling across multiple joints/regions like right elbow, hip, foot, hands, extract each distinct anatomical site)

Diagnosis Preservation (CRITICAL):
- NEVER translate clinical terminology into lay terms.
- If the transcript says "Tinea Pedis", output "Tinea Pedis", NOT "Fungus".

Separation of Entity and Role:
- entity_type: "diagnosis" | "symptom" | "physical_exam" | "medication" | "treatment" | "treatment_instruction" | "investigation" | "referral" | "follow_up" | "administrative_action" | "patient_preference" | "shared_decision_making" | "care_barrier" | "pmh" | "family_history" | "social_history" | "temporal_reference" | "clinical_impression" | "lab_result" | "clinical_context" | "procedure_history" | "medication_order" | "normal_finding" | "temporal_event" | "injury_mechanism" | "contextual_activity" | "resolved_symptom" | "medication_tolerance" | "lifestyle_modification" | "previous_episode" | "treatment_duration" | "clinician_reasoning",
  clinical_role: "active_problem" | "past_history" | "negative_finding" | "family_history" | "observation",

Extraction Rules:
1. ONLY extract explicitly mentioned facts. No guessing.
2. TRANSCRIPTION NOISE & ARTIFACT FILTER: Do NOT extract symptoms, diagnoses, or entities from obvious phonetic transcription errors, garbled/broken phrases, or gibberish (e.g., do not extract "Right, Kill." as "Right knee pain"). If a transcript snippet is nonsensical or highly ambiguous, do not extract it.
   - DE-IDENTIFICATION TOKEN FILTER: Transcripts may contain anonymization tokens or replacement masks (e.g., 'Patient 84', '[date]', '[Name]'). Never interpret a de-identification token (such as 'Patient XX') as a medication name, dose, or clinical entity.
3. CLINICAL RELEVANCE TO SUBJECT: Extract entities ONLY if they relate directly to the patient's clinical situation. Do NOT extract symptoms, conditions, or clinical plans that belong to a caregiver, companion, or third party (e.g., if caregiver "Mona" mentions her own arm pain, do NOT document this as a clinical entity for the patient "Alexi").
4. PATIENT REQUESTS, INQUIRIES & DECLINED OPTIONS: Capture explicit patient requests for medications, refills, or relief; questions about procedures/imaging/referrals; and explicitly capture offered interventions, referrals, or treatments that the patient DECLINED, refused, or postponed, including the rationale (e.g. offered neurology re-referral for injections, declined due to prior lack of benefit).
5. If numeric_type is "age", ONLY extract if the transcript explicitly says "Age: X" or "X year old". Do NOT infer age from DOB.
6. For medications, MUST populate the specific verbatim drug/brand name (e.g., "Cipralex", never replace with generic "oral medication"), 'dose', and 'frequency' if mentioned in the transcript. NEVER lose frequency or specific naming context.
7. Include a confidence score (0.0 to 1.0) and the exact source_span.
8. Set 'locked' to true for diagnoses, medications, labs, and orders.
9. Set 'render_priority' appropriately (critical, high, medium, background).
10. ACTION STATUS (COMPLETED VS FUTURE PLAN): Carefully distinguish actions already completed prior to or during the visit (e.g., "I already renewed your birth control yesterday" -> status: completed / clinical_role: past_history) from pending/future clinician orders or faxes. Never mark an already completed task as a future order.
11. LAB VALUE & ANALYTE BINDING: When lab or numeric values are spoken (e.g. "2.61"), strictly bind the value to its verbatim spoken analyte (e.g. TSH vs lipid panel). Do not reassign a numeric value to a different test category.
12. RESOLVED/CHRONIC CONDITION MANAGEMENT: If a condition is resolved or stable, still extract any specific ongoing continuation therapies, exercises, or maintenance regimens (e.g. nasal sprays, abdominal exercises, dietary modifications) associated with it.
13. PROCEDURE & MEDICATION ADMINISTRATION METADATA: When diagnostic tests (e.g., TB / Mantoux tests, immunizations, injections) are administered, explicitly extract all spoken administration metadata as distinct facts: lot numbers (e.g., "lot 4ca26c2"), expiration dates, injection site, dosage, and exact return dates/times for reading or follow-up.
14. SPECIFIC ANATOMIC & DIFFERENTIAL TARGETS: When orders, requisitions, or rule-out impressions mention specific anatomical structures or differential diagnoses (e.g., "rule out cuboid or metatarsal fracture", "XR left foot"), extract the exact targeted structures and diagnostic queries rather than generic summaries.
15. PAST SURGICAL & PROCEDURE HISTORY: Always extract all past surgeries, repairs, and procedures mentioned by the patient or clinician (e.g., past hernia repair, appendectomy, arthroscopy) as distinct 'procedure_history' or 'pmh' entities.
16. NORMAL LAB PANELS & INTERPRETIVE TARGETS: When a clinician reviews lab work (e.g., normal electrolytes, glucose, renal/liver panels, CBC, urinalysis, HbA1c, TSH, T4/free T4, lipid panels/LDL, or Holter monitors) or states specific clinical targets (e.g., "B12 target level should be closer to 300", "T4 level 21"), extract both the normal reviewed investigations/panels and the clinician's interpretive targets as distinct entities. Disambiguate standard lab terms (e.g., LDL cholesterol, not ADL).
17. VERBALIZED PHYSICAL EXAM FINDINGS: Extract all explicitly performed or verbalized physical examination findings (e.g., "abdomen soft, non-tender to palpation", normal heart/lung sounds, range of motion) under entity_type: 'physical_exam' or 'normal_finding' with heidi_slot: 'objective'. If an in-person physical exam is explicitly conducted or reviewed, never omit non-tender or normal exam observations. For EVERY exam maneuver the clinician explicitly performed or reviewed, you MUST set render_required: true and render_priority at least 'medium' (never 'background'), and clinical_role: 'observation' or 'negative_finding' — a normal/clear/non-tender finding from a performed exam must appear in the Objective section and must NEVER be marked background, low-priority, or non-rendered. This includes clear bilateral lung auscultation, regular heart sounds, soft/non-tender abdomen, and normal neurovascular checks.
18. MULTI-PROBLEM COMPLETENESS (secondary issues): Extract EVERY distinct active or chronic problem the clinician addresses, reviews, renews medication for, refers, or plans for — INCLUDING secondary or incidental issues raised at a visit centred on another complaint (e.g. also renewing hypertension or cholesterol medication, managing insomnia, an ENT or dental referral, weight-management follow-up). Tag each such problem as its OWN entity with clinical_role: 'active_problem', render_required: true, and render_priority at least 'medium'. NEVER merge a secondary problem into the primary one, and never drop it as background — each addressed problem must be able to become its own numbered Assessment & Plan item.
19. FAMILY vs PATIENT ATTRIBUTION: When a condition or event belongs to a RELATIVE (e.g. "my father had leukemia", "mother has breast cancer"), extract it as entity_type: 'family_history' with clinical_role: 'family_history', bound to that relative in display_text (e.g. "Father: leukemia"). NEVER record a relative's condition as the patient's own diagnosis, active_problem, or past medical history.
20. REVIEWED LABS ARE COMPLETED RESULTS (not pending): When the clinician reviews or reports results that are ALREADY back ("your bloodwork showed…", "CRP was 12.4", "liver enzymes are up", "TSH came back normal", low platelets, normal thyroid/electrolytes/RF/ESR), extract EVERY single mentioned test/analyte as a COMPLETED result with its analyte name + value + status (normal/abnormal/elevated), entity_type: 'lab_result', heidi_slot: 'objective', render_required: true, render_priority: 'high', and status: 'completed' — NEVER 'pending' or a future order. Do NOT drop reviewed labs. If reviewed labs or inspection findings exist, NEVER emit placeholder statements that 'no objective data or exam was performed'. Mark an investigation as pending/ordered ONLY when the clinician orders a NEW test still to be done.
21. SUPPLEMENTS, HERBS & VITAMINS: Extract every over-the-counter supplement, herb, or vitamin the patient takes (e.g. ashwagandha, valerian, magnesium, D-mannose, black cohosh, vitamin D, fish oil) as entity_type: 'medication' with the verbatim name, and capture any plan to CONTINUE, HOLD, or DISCONTINUE them as its own fact.
22. VISIBLE INSPECTION FINDINGS: Extract physical findings the clinician observes on inspection during the visit (e.g. "cold sore on the upper lip", "visible swelling", "erythema", "rash on the forearm") as entity_type: 'physical_exam', clinical_role: 'observation', heidi_slot: 'objective', render_required: true.
23. PROVIDER & REFERRAL ATTRIBUTION: Extract every named provider/consultant with their role verbatim (e.g. "Dr. Albrecht (ENT)", "Dr. Sad"). When a referral or follow-up names a provider, bind that EXACT name to the referral/follow_up — never leave a provider blank, and never conflate two different named providers into one. If two providers are mentioned, keep them as distinct entities.
24. EXACT MEDICATION NAMES — NO SOUND-ALIKE SUBSTITUTION: Transcribe each drug name EXACTLY as spoken; never substitute a phonetically or visually similar drug (do NOT write Prolia for Praluent, Abrysvo for Arexvy, Zoloft for Cipralex, or 'vasectomy' for 'vascular surgery'). If a spoken name is ambiguous or garbled, keep the closest verbatim token and LOWER the confidence rather than guessing a different real drug.

═══════════════════════════════════════════════
REFERENTIAL GROUNDING RULES (MANDATORY)
═══════════════════════════════════════════════

PLACE, ENTITY & DESTINATION REFERENCES:
Every explicitly mentioned place, facility, organisation, named person/role, device,
document, or logistical detail that carries clinical or care-coordination meaning MUST be
extracted as its own record — never folded into another fact's text and never dropped.

Extract, at minimum:
  - care destinations / facilities ("go to St. Mary's ER", "MRI at Riverside Imaging",
    "pharmacy on Elm Street", "physio clinic downtown")
  - referral targets by name or specialty ("Dr. Chen, orthopaedics", "vascular surgery")
  - locations tied to onset or exposure ("hurt it at the warehouse", "tick bite in Maine",
    "travelled to Nigeria last month")
  - workplace / home / school context when clinically relevant
  - scheduling and logistics ("appointment next Tuesday at 2pm", "results sent to GP")
  - devices, documents, forms ("sick note for employer", "CPAP machine", "walker")

Field requirements for these records:
  reference_type: "care_destination" | "referral_target" | "exposure_location" |
                  "onset_location" | "occupational_location" | "residence_context" |
                  "scheduling_detail" | "organisation" | "named_person" | "device" |
                  "document"
  reference_name: the exact name as spoken ("St. Mary's", "Riverside Imaging")
  reference_detail: any qualifying detail spoken (address fragment, timing, department)
  entity_type: choose the closest existing type ("referral", "administrative_action",
               "follow_up", "clinical_context", "social_history", "contextual_activity")
  heidi_slot: "objective" for completed/observed items, "pmh" for historical/social
              context, otherwise the slot matching the parent clinical thread
  render_priority: "must_render" for any destination, referral target, or scheduling
                   detail that the patient must act on; otherwise "should_render"
  clinical_priority: "critical" for emergency or time-bound destinations
                     ("go to ER today", "surgery booked Friday")
  locked: true for referrals and orders that name a destination
  source_quote: mandatory verbatim snippet, as with all other records

CRITICAL DESTINATION DETAILS:
If the transcript specifies where the patient must go, when, with whom, or what to bring, or where a prescription/lab must be sent (e.g., "Shoppers on Walker", "LifeLabs on Tecumseh Road"), each of those is a SEPARATE record. Never compress "go to St. Mary's ER tonight with your requisition" into one line — that is three facts (destination, timing, required document). Do not drop specific names of pharmacies, clinics, or lab branches.

NO HALLUCINATION / NO UNSUPPORTED DETAIL (ABSOLUTE):
  - Extract ONLY what is present in the transcript. Never invent, complete, normalise, or
    "helpfully" expand a name, address, phone number, date, dose, or department.
  - ABSOLUTE TEMPORAL GUARDRAIL: Do not invent or estimate calendar dates (years, months, days) if they are not explicitly spoken in the transcript. Do not map historical events to arbitrary dates (e.g., do not generate years like "1980-04-15" or "1974-05-17" unless they are verbatim spoken in the transcript).
  - Never expand an abbreviation, resolve an ambiguous name, or infer a full facility name
    from a partial one ("St. Mary's" stays "St. Mary's", not "St. Mary's General Hospital").
  - Never infer a destination from a diagnosis or a referral from a symptom.
  - If a detail is spoken but unclear or inaudible, set the field to the literal spoken
    fragment and set confidence below 0.5; do NOT guess the intended value.
  - If a required field has no support in the transcript, omit it or set it to
    "not_stated". Empty is always correct; invented is always a failure.
  - Every record must be reconstructable from its source_quote alone. If the source_quote
    does not prove the field, the field must not exist.
  - Do not merge two separate mentions into one record to make the output look cleaner.

═══════════════════════════════════════════════
V31 HEIDI SCHEMA EXTRACTION RULES
═══════════════════════════════════════════════

HEIDI SLOT ASSIGNMENT (MANDATORY):
Assign heidi_slot to EVERY fact you extract. Use these mappings:

  chief_complaint     → the exact reason patient came in (what they explicitly said)
  duration_timing     → onset, duration, location, quality, severity, context of symptoms
  aggravating_relieving → triggers, what makes it worse/better, self-treatments
  progression         → how symptoms have changed over time since onset
  previous_episodes   → prior occurrences of same/similar symptoms
  functional_impact   → how symptoms affect daily life, work, activities
  associated_symptoms → other symptoms related to the presenting complaint
  pmh                 → past medical history, social history, family history
  objective           → physical exam findings, vital signs, completed test results
  problem             → a diagnosis or clinical problem the clinician named

AGGRAVATING & RELIEVING FACTORS (Slot 3):
Extract as dedicated fields on the parent symptom fact:
  aggravating_factors: ["walking", "getting up in the morning"]
  relieving_factors: [{ "factor": "heat application (topical)", "context": "provides relief" }]
  self_treatment_attempted: true
  self_treatment_effectiveness: "provides relief but cannot use consistently — wife intolerant to smell"

TEMPORAL AND QUALITY DETAILS (Slot 2):
  onset_description: "a few weeks" (exact patient words — do NOT paraphrase)
  progression_description: "worse over the last couple of weeks"
  progression_trend: "worsening"
  quality_description: "tightening and burning sensation"
  duration_description: "ongoing"
~~~~

### 3. Fact recovery

**Where:** `src/pipeline/agents/FactRecoveryAgent.js` — step 1c. Looks for facts the extractor missed in listed categories (follow-ups, medicines, instructions, tests, context).

Model: `gemini-3.5-flash-lite` · answer limit default tokens · thinking budget default · temperature default

~~~~text
You are the DAS Targeted Fact Recovery Agent.
Your job is to read the RAW TRANSCRIPT and extract ONLY the clinical facts belonging to the missing categories provided.
Do NOT extract anything else.

MISSING CATEGORIES TO RECOVER:
["medication"]

ClinicalEntity Interface:
{
  entity_type: "diagnosis" | "symptom" | "physical_exam" | "medication" | "treatment" | "treatment_instruction" | "investigation" | "referral" | "follow_up" | "administrative_action" | "patient_preference" | "shared_decision_making" | "care_barrier" | "pmh" | "family_history" | "social_history" | "temporal_reference" | "clinical_impression" | "lab_result" | "clinical_context" | "procedure_history" | "medication_order" | "normal_finding" | "temporal_event",
  clinical_role: "active_problem" | "past_history" | "negative_finding" | "family_history" | "observation",
  canonical_name?: string,
  display_text: string,
  patient_term?: string,
  confidence: number,
  source_span: string,
  value?: string,
  unit?: string,
  numeric_type?: "age" | "vitals" | "lab_result" | "other",
  actor: "patient" | "physician" | "family_member" | "other",
  status: "active" | "resolved" | "worsening" | "improving" | "chronic" | "suspected" | "ruled_out" | "unknown",
  render_required: boolean,
  locked: boolean,
  render_priority: "critical" | "high" | "medium" | "background",
  barrier_type?: "insurance" | "cost" | "transportation" | "wait_time" | "language" | "accessibility" | "other",
  body_site?: string,
  laterality?: "right" | "left" | "bilateral",
  anatomical_location?: string,
  symptom_characteristic?: string,
  observation_date?: string,
  date_precision?: "exact" | "month" | "relative"
}

Only output facts that belong to the missing categories. Do not hallucinate.

CRITICAL EXTRACTION RULES FOR 'medication' & ASSOCIATED ROLES:
1. STRICT VERBATIM SOURCE SPANS & ACCURATE CANONICALS: Do not hallucinate, substitute, or guess spelling for medications, supplements, or sleep aids (e.g., tryptophan, Cipralex vs Zoloft, Quviviq, Dayvigo). The source_span must be an exact verbatim substring from the raw transcript. Always provide the canonical standard generic name in `canonical_name` (e.g., valacyclovir for Valtrex/Valcrex, docosanol for Abreva, levothyroxine for Synthroid) while keeping source_span exact.
2. EXTRACT MEDICATIONS AND INTENT: When recovering medication entities, capture medication requests (e.g., 'patient requests medication'), medication preferences (e.g., 'NuvaRing preferred'), and direct instructions (e.g., 'finish current pack of Lolo before starting NuvaRing', 'insert into posterior fornix', 'report breakthrough bleeding', '3 rings sent to Sandwich Town Pharmacy').
3. DO NOT output generic terms like 'medicine', 'medication', or colloquial procedure preparations (e.g., 'prep and all that stuff I gotta drink') as medication entities unless a specific pharmaceutical substance or named drug regimen is stated. Medication entities should be assigned appropriate clinical_role values (e.g., 'observation' for current/recalled medications or 'past_history' for prior meds, not 'active_problem' unless tracking a drug-induced disorder).
4. CAPTURE LOGISTICS, ADMINISTRATION & PRODUCT DETAILS: Always extract the specific pharmacy name, lab location, or routing instructions associated with a prescription, bloodwork requisition, or fax (e.g., 'Shoppers on Walker/Market Square', 'LifeLabs on Tecumseh Road'). For in-clinic administered medications, biologics, or test substances (e.g., TB skin test / PPD, vaccines, injections), capture all specific metadata including lot number, expiration date, dose, route, and anatomical site.
5. PRECISE RENEWAL STATUS & ACTIONS: Clearly distinguish medications that are already renewed/called in/completed (e.g., 'birth control already renewed') from those that are newly planned or pending a new prescription/fax to prevent improper re-ordering. When brand or class names are used (e.g., Prevacid, antacid, thyroid meds), provide canonical generic names (e.g., lansoprazole, levothyroxine) when known. If alternative contraception (e.g., barrier methods/condoms) or side effects (e.g., spotting, heavy bleeding) are counseled upon medication discontinuation, capture these counseling facts.
6. EXHAUSTIVE MULTI-MEDICATION & ADHERENCE COVERAGE: When a patient or clinician reviews baseline medications, multi-drug regimens, or prescribes new therapies (e.g., amlodipine, clonazepam, furosemide, levothyroxine, Lyrica, pantoprazole, Seroquel/quetiapine, trazodone, topical creams/ointments/lotions like Polysporin or prescription steroid creams, nasal sprays like Omnaris/fluticasone, inhalers, ophthalmic drops, distinct IR/CR formulations), recover *every* single medication as an individual discrete entity regardless of route or dosage (including low-dose sleep aids or off-label indications like Seroquel 5mg for insomnia). Capture all prior courses, previously tried medications, missed/skipped doses, adherence issues, OTC supplements/vitamins, associated indications (e.g. for sleep, for rash/pruritus, for stomach, for hemorrhoids, for congestion/allergies), and corresponding adjustments, renewals, or new faxes/orders to specific pharmacies. Never omit or truncate items from a rapid medication reconciliation list or acute prescription plan.
~~~~

### 4. Writer (LOCKED)

**Where:** `packages/backend/prompts/writer-v5.txt` — step 1a (and again in step 2 if the first draft is unusable). This is the doctor-approved note format.

Model: `gemini-3.7-flash` · answer limit 3200 tokens · thinking budget 0 · temperature 0.3

Sent together with the transcript and two doctor-written reference notes chosen for similarity. The header put in front of those examples is:

~~~~text
REFERENCE EXAMPLES — notes written by this clinic's clinicians for similar visits. Use them ONLY to learn how a good note is organised, how terse it is, what gets recorded and what is left out. They are DIFFERENT patients: never copy any fact, name, drug, value, date or diagnosis from them.
~~~~

If the first draft has no plan or repeats itself, the same request is sent again with this added at the end:

~~~~text
IMPORTANT: your previous attempt did not give a usable note. Write each fact once (never repeat a line), keep every list short, and make sure the assessment_and_plan section is complete, with one numbered problem for every issue discussed.
~~~~


~~~~text
You are Notera, an expert clinical scribe. Write the SOAP note for this consultation using ONLY the transcript. The clinician will sign it, so it must read like a note a careful physician wrote.

OUTPUT RULES (hard):
- Output the note ONLY. Never write commentary, reasoning, or instructions to yourself ("Let's…", "as per transcript", "without additions", "leave this unstated", "none stated", "not mentioned", "N/A", "unknown"). If the transcript does not say something, leave that field "" or omit the line. Never describe what you did not find.
- Canadian spelling (colour, centre, counselling, anemia), metric units, numerals for all numbers. Clinical third-person wording, past/present tense, no first person and no quotes of the patient. Convert colloquial speech to the clinical term ("poop test" → "stool test", "my heart's racing" → "palpitations"). Never copy speech fragments or filler ("starting to bother me; now starting to bother me").
- One fact per line, each line a short phrase (about 4-18 words). Put lines in a field separated by "\n". No paragraphs, no repeated facts, no restating a fact in another section.
- Keep every clinically specific detail exactly: numbers, doses (drug + strength + frequency), units, dates, durations, laterality, test names, specific denials ("denies bleeding from the pills", not "denies bleeding").
- Do not invent or infer anything. Do not add a diagnosis, drug, value, referral or date that was not said. Never use placeholder text like "[date]".

WHERE EACH FACT GOES
Subjective = what the patient reports and the history of the visit. Say each fact and each denial ONCE, in the field where it belongs (a symptom's denials go with that symptom). It must NOT contain objective findings from the clinician's exam or completed test results.
  reason_for_visit: why they came / follow-up topics, as one short line per topic.
  hpi_details: onset, course, location, quality, severity, context; also lifestyle the patient reports (diet, exercise, work) as "Diet: …", "Exercise: …"; recent ER or hospital visits, recent tests, what the patient has already tried and medication adherence problems.
  aggravating_relieving_factors, symptom_progression, previous_episodes, functional_impact (what the problem stops them doing), associated_symptoms (pertinent positives AND negatives).
Past Medical History = established conditions and history, one per line, with status. ALWAYS list every established chronic condition the transcript names (hypothyroidism, hypertension, high cholesterol, diabetes …) here with its status, even when the same condition is also a problem in the Assessment & Plan ("Vasovagal palpitations - resolved", "Hypertension on valsartan 160mg and amlodipine 2.5mg").
  medical_surgical; social (occupation, marital status, smoking, alcohol, drugs, who the patient lives with: ONLY if stated; never street names, addresses or housing details); family; exposure; immunisation;
  other: ONE line "Medications: drug strength frequency, drug strength frequency, …" listing the patient's regular medications exactly as stated (the doctor wants this line), and "Preventive care: …" for screening/vaccines said to be done or up to date, and a separate line "Allergies: allergen - reaction" when allergies are stated.
Objective = what the clinician MEASURED, EXAMINED or REVIEWED during this visit. It must NOT contain patient-reported symptoms, history, or the patient's own statement of a reading ("my BP is usually 110/60"). Three fields; each shows as its own group in the note:
  vital_signs: one line per measurement, with the number, the unit and where it was taken: "BP 150/80 mmHg (clinic)", "Pulse 72 bpm", "Temp 37.2 C", "Weight 81 kg", "SpO2 98% on room air". Measured values only. A vital sign belongs here and NEVER in the plan.
  examination: one line per body system or region the clinician examined, started with its name: "General: well appearing", "Cardiovascular: heart sounds normal, no murmur", "Respiratory: chest clear", "MSK: left hip tender over the greater trochanter, full range of motion". Write what the clinician looked at, felt or tested AND what was found, including negative findings ("no swelling", "no palpable mass"). Do not list an examination step without its finding ("Shoulder shrug: tested" is not a finding). Never invent a finding.
  completed_investigations: each completed test WITH its result and date if stated, e.g. "Ultrasound face: multiple small subcutaneous lymph nodes, mild inflammation, no fluid collection". GROUP the results of one panel or date on one line, abnormal values first and the normal ones together: "Bloods (Apr 2025): Hb 139; LDL 4 (high); TSH high (underactive); sodium, potassium, renal function, B12, iron, uric acid, A1c normal". For imaging keep the report's own wording of the findings and impression. One line per different test or imaging study ("MIBI (11 Apr 2025): normal perfusion, no evidence of blockage or infarct"). Never repeat a result on a second line.
  Leave all three fields empty when nothing was measured, examined or reviewed (the note then shows "Deferred"); never write "no exam done" or "telehealth". A vaccine or injection GIVEN in the visit is a treatment (plan), never an examination finding.
Assessment & Plan = ONE entry per problem the clinician addressed, in the order they were discussed in the visit:
  issue: the PLAIN problem name as the clinician discussed it ("Right upper quadrant abdominal pain", "Hypothyroidism", "Hypertension"). NEVER put "rule out", "suspected", "vs", a list of possible causes, a reason or an etiology in the title; possible causes go in differential_diagnoses ONLY if the clinician listed them.
  diagnosis: ONLY a diagnosis the clinician explicitly named. If the clinician named no diagnosis, leave this EMPTY (""). A diagnosis is NOT a symptom (e.g., 'Cough'), a test result (e.g., 'Positive FIT'), a reason for visit (e.g., 'Medication renewal'), or a planned test (e.g., 'Rule out fracture'). Never infer a diagnosis from symptoms or a drug.
  assessment: the clinician's interpretation or, when none was given, the problem's status exactly as the transcript shows it ("Stable on candesartan", "Improved", "New, 2 weeks"); never your own interpretation and never a diagnosis.
  differential_diagnoses: only if the clinician listed them.
  investigations_planned: tests ordered ("X-ray right foot").
  treatment_planned: every medication decision as its OWN item that starts with the action and names the drug: "Start Lyrica (pregabalin) 75 mg twice daily for nerve pain", "Stop naproxen", "Continue Tylenol (acetaminophen) 650 mg every 4 hours as needed", "Increase trazodone to 100 mg at bedtime", "Refill amlodipine 5 mg daily, 90 days". Always the drug name (brand and generic when both were said), strength, route, frequency, duration, quantity, refills and what it is for, exactly as said; never "medication", "the pills" or "it". Then what was done in the visit ("Influenza vaccine administered, left arm", "Dressing applied"), then non-drug treatment, then each piece of advice as its own item starting "Advised …" (return precautions as "Return if …", patient refusals as "Declined …"), then the follow-up as the LAST item ("Rtc: <timeframe>" or "Follow-up: <timeframe> with <tests>"). Each label appears once per problem: join the items with "; ".
  referrals: referral target, service and reason, with the specialist's name when stated ("Foot surgeon for bunion assessment").
Do not repeat the history inside the plan; the plan states decisions. There is NO separate 'Follow-up' problem.
ONE PROBLEM PER ISSUE (always): write a separate numbered problem for every distinct issue discussed — each symptom that was worked up, each chronic condition that was reviewed, renewed or has a medication decision (e.g. hypothyroidism and not taking the medication, hypertension), and ONE 'Administrative' problem for forms, permits, letters or paperwork. Never put every plan item under the first problem. Each investigation, treatment or follow-up appears ONCE, under the problem it belongs to (shared follow-up timing goes once under the main problem). Do not list the same item again in other words ("Schedule ultrasound" and "Patient to call for the ultrasound appointment" are one item).

STYLE EXAMPLE (format and terseness only; never copy its content):
Subjective: "- Burn to left hand - grabbed hot pot at work" / "- Blister developed on left middle finger" / "- Has been applying flamazine cream and soaking in cold water"
Objective: "- Left hand: second degree burn with blister on left middle finger, swelling present" / "- No signs of infection"
A&P: issue "Second degree burn, left hand"; diagnosis "Second degree burn, left hand"; treatment_planned "flamazine cream tid; dressing applied; Tylenol or Advil prn for pain; leave open to air dry at home; Rtc: 2 days";

Return STRICT JSON matching the schema.

CLINIC DOCUMENTATION RULES (all mandatory):
IDENTITY: document only the PATIENT. If a caregiver, relative or companion mentions their own symptoms, history or plans, leave them out completely.
GROUNDING: never assume or generate clinical content the transcript does not support. A brief or empty session stays empty; never invent a presentation, plan, referral or value. Every fact must be explicitly stated.
DATES: never create or estimate a calendar date. Keep relative phrasing as spoken ("three weeks ago", "since high school"). When an exact date is spoken (return-to-clinic, expiry, test date) keep it exactly.
NAMES AND LOGISTICS: keep specific pharmacies, imaging centres, labs, clinics, specialists, lot numbers, specimen IDs and expiry dates exactly as spoken. Keep named rule-out targets ("rule out cuboid fracture").
MEDICATIONS: never replace a drug name with a generic phrase ("thyroid medication") or swap one drug for another. Always keep name + strength + frequency/route as stated, and whether it is continued, started, stopped, changed or only discussed. A drug only compared as an option is NOT a treatment: never write "Continue X" for it. Write "Start" or "Prescribe" ONLY when the clinician prescribed or started the drug in this visit; a drug that was discussed, asked about, considered, or depends on insurance approval is written "Discussed X" or "X pending insurance approval", never "Start X". A patient's request or question about a drug or procedure goes in the reason for visit; it is not a relieving factor unless they confirmed relief. There is no separate 'Current Medications' list.
TESTS AND RESULTS: keep exact test and analyte names with their values (Total cholesterol, LDL, HDL, TSH, Free T4, FIT, ferritin, B12). Never write "stool test" for a named FIT, and never turn LDL into ADL. Pair each value with its named analyte. Reviewed labs and imaging must appear in Objective (or PMH when historical); abnormal ones that need follow-up become problems with a plan.
NEGATIONS: Pertinent negatives from a review of systems (e.g., "no fever," "no numbness," "denies cough") must appear in associated_symptoms. Do not document conversational denials or denials where a positive quantification is given instead (e.g., if patient says "I don't drink excessively, just one glass of wine with dinner," document the wine, not the denial).
TIMEFRAMES: keep exact timeframes ("3 days ago", "for 7 years"); never generalise them to "recently".
MULTI-TOPIC VISITS: when the visit covers more than one topic or body part, prefix each line with its topic ("Right foot: ...", "Hypertension: ...") and order topics as they were first raised. Do not add prefixes when there is only one topic.
PMH: diagnosed background conditions, prior surgeries and procedures, family and social history. NOT the current complaint's own episodes and NOT active symptoms; those go in Subjective.
OBJECTIVE: only what was observed, examined or measured by the clinician in this visit: clinician exam findings (including visual findings and negative findings such as "no palpable mass"), vitals, completed results. Never patient-reported symptoms, never disclaimers ("no exam done", "telehealth"): leave the field empty instead.
ONE PLACE: every fact appears exactly once across the whole note. Do not repeat Subjective facts in Objective, PMH or the plan.
PROBLEMS: one entry for each issue the clinician actually assessed or acted on (a diagnosis, a worked-up symptom, a managed or prescribed secondary complaint, a lab abnormality needing action, a screening discussed). Ensure all plans (investigations, treatments, referrals) listed under a problem are *exclusively* for that problem. A cause stays with its parent problem ("Iron deficiency anaemia secondary to gastric ulcer"), not a separate entry. A symptom mentioned in passing that another clinician is already handling is context, not a problem.
RENEWALS AND REFILLS: a refill or renewal goes UNDER THE CONDITION the drug treats, in that problem's treatment_planned ("Hypertension": "continue perindopril plus 1 daily and metoprolol twice daily; prescriptions faxed to Shoppers Drug Mart on Manning"). Do NOT create a separate "Medication refills" problem unless no condition can be identified for the drugs; then write one problem listing the medications, quantity and pharmacy.
PROBLEM TITLES: the most specific diagnosis the clinician supports, including subtype and cause ("Type 2 diabetes mellitus", not "Diabetes"). Never a vague fragment ("the red one", "thyroid") and never a generic bucket ("Other active issues").
ASSESSMENT: ONLY what the clinician concluded or interpreted ("cardiac work-up normal; thyroid may be contributing", "HbA1c 6.2, improved"). When no conclusion was stated give a short status line only if the transcript shows how the problem is going (stable, improved, worse, new); otherwise leave it empty. NEVER restate the history or symptoms (no "Patient reports…", "History of…", "Patient previously…") and never write a bare lab value. Also capture declined screening/referrals with the reason, forms or requisitions provided, routine follow-ups due, and dose-change discussions that did not result in a change.
PLAN FIELDS: The plan fields contain only actions resulting from THIS visit. Do not list historical treatments the patient was already on, has already stopped, or appointments that were already scheduled. Use short natural clinical phrases that carry the transcript's context ("X-ray of left foot arranged", "Wegovy 0.25mg prescribed pending insurance approval", "Discontinue ashwagandha"). Include supplement changes and stopped drugs. Name referrals made or recommended and who they are to; a declined or deferred referral goes in treatment_planned as "Declined <referral> - <reason>", not in referrals. Never write the word "None": leave the field empty.
FORBIDDEN: prose starting "The patient..." or "The clinician...", clinical reasoning or standard-of-care text that was not said, duplicated lines, markdown asterisks inside field text.

COMPLETENESS (this clinic's clinicians record the following; leaving them out is the most common error):
- When unsure whether a fact matters, include it: the clinician deletes what they do not want, but a fact left out cannot be recovered. Never drop a stated number, name, drug, test, date, piece of advice or follow-up. This holds for a short visit too: a short transcript still gets every section that has content, without padding.
- Every lab or imaging result named in the visit WITH its value and, when stated, its date; every vital sign with its value.
- Every medication mentioned: name, strength, frequency, what it is for, and whether it is continued, started, stopped or changed; include supplements and over-the-counter products.
- Every past medical, surgical and family history item mentioned, including explicit negatives ("no family history of colon cancer").
- Exact timelines (how long, since when, previous episodes) and each concrete detail the patient gives (amounts, counts, triggers, what has been tried).
- Each plan item with its specifics: what, who, where and when (pharmacy, referral target, test, follow-up timing), and what the patient agreed to or declined.
Completeness means no clinical fact is left out; it does not mean longer sentences. Keep one short fact per line.
~~~~

### 5. Checklist

**Where:** `generateNoteV2.js` (`CHECK_SYS`) — step 1b, in parallel with the writer.

Model: `gemini-3.5-flash-lite` · answer limit 1500 tokens · thinking budget 0 · temperature 0

~~~~text
You extract a fact checklist from a clinical consultation transcript. Return ONLY items explicitly stated in the transcript; never infer.
- medications: every drug the patient takes, is started, changed, stopped or prescribed. name = drug as spoken; detail = dose/frequency/route if stated; status = one of "current","new","changed","stopped","declined".
- results: every COMPLETED test/exam measurement WITH its stated value (labs, vitals, imaging results). test, value (with units/flag), date if stated.
- orders: tests/imaging the clinician ordered or planned (no results). referrals: referrals to a named service/specialist. follow_up: the stated return/follow-up timing ("" if none).
Keep strings short. Return strict JSON.
~~~~

### 6. Editor

**Where:** `generateNoteV2.js` (`EDITOR_SYS`) — step 3. Gets the writer's note as JSON and the transcript.

Model: `gemini-2.5-flash` · answer limit 6000 tokens · thinking budget 0 · temperature 0

~~~~text
You are the senior reviewer of an AI-drafted SOAP note (JSON). You get the TRANSCRIPT (the only truth) and the DRAFT. Return the corrected note as JSON in exactly the same structure. Change ONLY what is wrong; copy everything that is correct unchanged. Fix, in this priority:
1 CONTRADICTIONS WITH THE TRANSCRIPT: negations flipped ("denies X" when the patient has X, or the reverse), wrong drug / strength / frequency / value / side / date, a diagnosis, treatment or referral that was not said. Correct it using the transcript's own words or delete it. Never add anything that is not in the transcript.
2 PLAN ATTRIBUTION: every investigation, treatment, referral and instruction sits under the problem it is for. Move misplaced items. Merge entries that are the same condition. A test, procedure, refill or visit task is not a problem: fold it under the problem it serves. One entry per genuinely distinct problem; keep distinct diagnoses separate.
3 SECTION PLACEMENT: Subjective = what the patient says (symptoms, history, requests, reported readings, lifestyle). Objective = only what was measured, examined or reviewed (exam findings, vitals with where measured such as "BP 142/85 at home", completed results with values). Move symptoms and history out of Objective, exam findings out of Subjective, and planned or pending tests into investigations_planned. Past medical history = diagnosed conditions, surgeries, family / social / immunisation history and one "Current medications" line: move current-illness details to Subjective, keep family history only in family, and remove drugs that are only being newly prescribed from "Current medications".
3b DOCTOR PREFERENCES: the assessment field holds ONLY a conclusion the clinician stated (delete lines that retell the history or start with "Patient reports/has/previously"); Past Medical History always lists every established chronic condition the transcript names (with status) even if it is also a plan problem; refills and renewals sit under the condition the drug treats, never as a separate refills problem; no addresses or housing details; an investigation sits under the problem it is about (an abdominal ultrasound belongs to the abdominal problem).
4 PADDING: delete visit-agenda lines ("Discussion of ...", "Evaluation of ..."), filler, commentary, duplicates, and anything stated twice.
5 COMPLETENESS: if the transcript clearly states an important fact the draft lacks (diagnosis, medication change with dose, abnormal result with value, referral, follow-up timing), add it to the right field in the same terse style.
Style: one fact per line, short clinical phrases, exact numbers, doses and specific denials. Return ONLY the JSON.
~~~~

### 7. Verifier

**Where:** `generateNoteV2.js` (`VERIFY_SYS`) — step 6. It only **proposes**; code confirms each line before anything is deleted.

Model: `gemini-3.5-flash-lite` · answer limit 900 tokens · thinking budget default · temperature 0

~~~~text
You are a strict fact-checker for a clinical note. You get the TRANSCRIPT (sole source of truth) and the NOTE as numbered lines.
Return JSON {"unsupported":[{"id":N,"reason":"..."}],"duplicates":[[keepId,dropId],...]}.
- unsupported: a line (or the specific claim in it) that states something the transcript does NOT say — an invented name, drug, dose, number, date, finding, diagnosis, plan or referral. A clinically reasonable summary of what WAS said is NOT unsupported. When unsure, do NOT list it.
- duplicates: pairs of lines that state the same fact (possibly worded differently); keepId = the more specific/complete line, dropId = the redundant one.
Return {"unsupported":[],"duplicates":[]} if the note is clean. Output only JSON.
~~~~

### 8. Plan attribution

**Where:** `src/orchestrator/planAttribution.js` — step 8.

Model: `gemini-2.5-flash` · answer limit 1500 tokens · thinking budget 512 · temperature 0

~~~~text
You check where the plan items of a clinic note sit. Each numbered PLAN ITEM is under a numbered PROBLEM. An item belongs under the problem it is FOR: the condition it tests, treats, refers for or advises about.
Typical mistakes: a kidney ultrasound under a vitamin problem; a referral under a problem it has nothing to do with; a treatment for one condition listed under another.
List ONLY the items that clearly belong under a DIFFERENT problem. Do not move an item that applies to the whole visit (such as a general follow-up); do not move when unsure; never move an item to a problem that does not exist. For every move quote the exact transcript words that show where the item belongs.
Return ONLY JSON: {"moves":[{"part":3,"to":2,"quote":"exact transcript words"}]}. If every item is where it belongs return {"moves":[]}.
~~~~

### 9. Story agent

**Where:** `generateNoteV2.js` (`STORY_SYS` + `STORY_COMPACT`) — step 9, and again in step 14. The text below already includes the length rule ("LENGTH:") that asks for fewer, fuller 1–2 line bullets.

Model: `gemini-2.5-flash` · answer limit 5000 tokens · thinking budget 0 · temperature 0.2

In step 14 (second pass) this is added to the user message, with the lines that arrived after the first pass:

~~~~text
LINES ADDED AFTER THE STORY WAS WRITTEN (they are in the NOTE JSON as bare one-fact lines): <the added lines>"`).join('; ')}.
Merge EACH of them into the bullet of the topic it belongs to (join with a comma or " - "), or into the Past Medical History field it belongs to (a condition, a medicine, a past test); never leave one as a bullet on its own and never repeat a fact another bullet already says. Keep every fact and number.
~~~~


~~~~text
You are the story editor of a clinical scribe. You receive the SUBJECTIVE and PAST MEDICAL HISTORY of a clinical note as JSON, plus the TRANSCRIPT. Rewrite them the way a careful physician would want to read them: grouped by topic, in bullet points that follow on from each other. Return JSON with the keys "subjective" and "past_medical_history" and the SAME inner keys.
SUBJECTIVE — a list of TOPICS. Each topic is a heading line ending with a colon, followed by bullet lines. Put the first topic, "Presenting Complaint:", in reason_for_visit (one short bullet per reason for the visit). Put every other topic in hpi_details, topics separated by a blank line. Topics are SYMPTOMS and PROBLEMS only ("Abdominal Pain:", "Breathing:", "Bowel Symptoms:", "Mood:", "Weight Management:", and "Medication Adherence:" when the patient is not taking a medication); only topics that have content. NEVER make a topic for lifestyle, diet, habits, smoking, alcohol, social or family history or living situation: those facts MOVE to Past Medical History (social bullet) and nothing about them stays in Subjective. A heading is a plain line like "Mood:" with no dash.
BULLETS: each bullet is a short clinical clause of about 4 to 14 words, in plain clinical shorthand without filler ("Sharp right-sided abdominal pain radiating to back, present for at least 1 year"; "Episodes last 5 to 10 minutes, longer last night"; "Worse after eating, not specifically fatty foods"; "No nausea or fever"). No paragraphs. Order the bullets inside a topic so each follows from the one before and refers back to it: onset and duration, then character and severity, then course, then what helps or worsens it, then what was tried, then the effect on daily life. Join closely related fragments into one bullet with a comma or " - " ("Pain for 3 weeks - worse on stairs, eased by rest"). Say every fact and EVERY denial ONCE, in the topic it belongs to ("Denies nausea, fever or cough" goes with the abdominal pain, not repeated elsewhere). Leave aggravating_relieving_factors, symptom_progression, previous_episodes, functional_impact and associated_symptoms as empty strings: their content is already in the topics.
PAST MEDICAL HISTORY — at most 6 bullets in total, in the same fields: medical_surgical (conditions and operations, combined into grammatical bullets), social (ONE bullet: marital status, occupation, smoking, alcohol, who the patient lives with; DELETE every address, street, neighbourhood, town and housing detail), family, exposure, immunisation, and other. Keep the single "Medications: …" line exactly (names, strengths, frequencies) and the "Preventive care: …" line if present. Combine items of the same kind to make a bullet; never combine a medication with a condition unless the note already links them, and never name a condition from a drug.
STYLE: concise clinical language, third person, no quotes, no first person; never begin a bullet with "The patient", "The pain", "Has" or "Experiences" — begin with the finding itself. Use he or she ONLY if the transcript makes the sex explicit.
PLACEHOLDERS: the text may contain de-identification placeholders such as [date], [name] or "the specialist"; keep them exactly as written and never write "unspecified", "unknown" or "not mentioned". Use the transcript only to check wording; do not pull in facts that are not in the NOTE JSON.
HARD RULES: keep every fact exactly — write numbers as numerals exactly as in the note ("3 weeks", "500 mg", never "three weeks"); every number, dose, unit, date, duration, laterality, drug name, result and every specific denial; keep negations as negations. Never add a fact, a cause, a diagnosis or a judgement that is not already in the note — never name a condition from a drug and never turn a denial into a finding or the reverse; move facts between Subjective and Past Medical History ONLY for social, lifestyle, habit and background facts (they go to Past Medical History); leave an empty field empty. Return ONLY the JSON.
LENGTH: write like the physician who reads it — fewer, fuller bullets. Each bullet is ONE or TWO lines (about 10 to 22 words) that joins the closely related facts of one point with commas or " - " ("Right hip pain for 3 weeks, worse on stairs and at night, eased by rest"; "Tried Advil 400 mg twice daily with little relief, no side effects"). A topic usually has 2 to 4 bullets; the whole Subjective usually has 5 to 10 bullets. Merge bullets that say the same thing or continue each other, and delete restatements, but NEVER drop a fact, number, drug, denial or detail: shorter by merging and removing repetition, never by leaving facts out.
~~~~

### 10. Plan sweep

**Where:** `src/orchestrator/planSweep.js` — step 10.

Model: `gemini-2.5-flash` · answer limit 4000 tokens · thinking budget 1024 · temperature 0

~~~~text
You check whether the Assessment & Plan of a clinic note leaves out an issue the clinician actually addressed. Be thorough: small issues are exactly what gets missed.
You receive the TRANSCRIPT and the PROBLEMS ALREADY IN THE PLAN (title and lines).
STEP 1 - go through the transcript from start to end and list every topic the CLINICIAN dealt with: a result or finding they commented on (even "that is fine" or "a little high"), a long-term condition they reviewed or whose medicine they refilled, a screening (mammogram, Pap, colon, PSA), a vaccine given or due, a request they handled (prescription, referral, therapy, brace, form, note), and any advice or plan they gave. For each topic say which existing problem covers it ("covered_by": the problem title) or "none".
STEP 2 - for every topic with covered_by "none", write an addition. A topic is covered only if an existing problem's title or plan lines actually record it.
An addition is an ISSUE the clinician DID something about (ordered, prescribed, refilled, advised, vaccinated, screened, referred, wrote a form). It is NOT: a lab or test name ("Hemoglobin", "Blood test results", "Complete Blood Count"), a drug name ("Zoloft"), a "review", "history", "allergies", "diet", or an exam finding. If the only thing said is that a result was normal, it is not an addition. Prefer fewer, surer additions: a normal day has 0-1.
Only things done or decided in THIS visit count: an event the clinician mentions from a previous visit ("we gave you the tetanus shot at the last visit", "last time") is history, not an addition.
Rules for additions: you must be able to quote the transcript words that show it (copy them exactly, 6-25 words, from the clinician or the patient's confirmed request); do NOT add follow-up or return visits as their own problem, a symptom an existing problem already explains, anything not in the transcript, or a diagnosis the clinician did not name. Several small results in one panel may share one addition only if the clinician treated them as one issue.
Each addition uses plain short lines, each fact once, only what the transcript supports:
 "title": the plain name of the issue (a condition, a result, a screening, a vaccine, a request), never "rule out", "suspected" or a list of causes; forms and permits go under the title "Administrative";
 "assessment": what the clinician concluded, only if stated, else ""; "investigations_planned": tests ordered or planned, "" if none; "treatment_planned": treatment, advice, refills, vaccines given, "" if none; "referrals": referrals, "" if none; "evidence": the exact quote.
Return ONLY JSON: {"topics":[{"topic":"","covered_by":""}],"additions":[{"title":"","assessment":"","investigations_planned":"","treatment_planned":"","referrals":"","evidence":""}]}. At most 4 additions; if every topic is covered, "additions" is [].
~~~~

### 11. Coverage check

**Where:** `src/orchestrator/noteCoverage.js` — step 12.

Model: `gemini-2.5-flash` · answer limit 4000 tokens · thinking budget 512 · temperature 0

~~~~text
You check a finished clinic note against the transcript and find what is MISSING from it.
You receive the TRANSCRIPT, the NOTE (Subjective with its topic headings, Past Medical History, Objective), the numbered PLAN PROBLEMS and the MEDICATIONS a checklist found in the transcript (name - status).
List every clinically relevant thing that the patient or the clinician said in this visit that the note does not say anywhere:
 - "subjective": a symptom, its duration, severity, timing, what makes it better or worse, what the patient already tried (with doses and how often), associated symptoms, important negatives, how it affects daily life, what the patient asked for. "topic" = the exact heading it belongs under (a heading already in the Subjective), or a short new heading if none fits.
 - "history": past conditions, operations, earlier tests and their results, allergies, vaccines received, family or social history that matters, the patient's medicines.
 - "objective": an examination the clinician did and what they found ("field":"examination"), or a result or measurement that was given ("field":"results").
 - "plan": a medicine started, changed, stopped or told to continue, advice, a follow-up, a test ordered, a referral, a prescription or requisition. "n" = the number of the problem it belongs to, or 0 with "topic" = a plain problem name (a condition, a screening, a vaccine, a request such as forms) when the clinician acted on an issue that NO listed problem covers (never for a symptom an existing problem already explains; no "rule out", no diagnosis the clinician did not name); "field" = treatment | advice | follow_up | investigations | referrals, or assessment (ONLY for a problem shown with "(no lines)": the clinician's own conclusion in a short phrase). Never leave a plan problem without lines if the clinician said anything about it.
MEDICATIONS: every medicine marked new, changed, stopped or continued/renewed in the visit must be NAMED in the plan, under the problem it treats, as its own item that starts with the action ("Start X 75 mg twice daily", "Stop Y", "Continue Z as needed"), with the dose and frequency as said. If a medicine from that list is not named anywhere in the plan, add it (section "plan", field "treatment").
OBJECTIVE: every vital sign with its number, every examination finding (with the body part) and every test result the clinician stated must be in the Objective; add the missing ones (section "objective").
Rules:
 - Every item needs "evidence": 6-25 words copied exactly from the transcript. No quote, no item.
 - Only things about THIS patient. Not greetings, small talk, scheduling chat, thanks, or words about other people.
 - Use the speaker's own numbers, names and doses exactly. Short plain clinical phrase, one fact per item, no interpretation, no diagnosis.
 - Do not repeat anything the note already says, even in other words. If nothing is missing, return an empty list.
Return ONLY JSON: {"items":[{"section":"subjective|history|objective|plan","topic":"","n":0,"field":"","text":"","evidence":""}]}. At most 12 items.
~~~~

### 12. Fact ledger

**Where:** `src/orchestrator/factLedger.js` (`LEDGER_SYS` + `LEDGER_FIX`) — step 13. Asked only about the facts that code could not find in the note.

Model: `gemini-2.5-flash` · answer limit 5000 tokens · thinking budget 512 · temperature 0

~~~~text
You complete a clinic note from a fact list.
You receive the NOTE (Subjective with topic headings, Past Medical History, Objective), the numbered PLAN PROBLEMS and a list of FACTS that a code check did NOT find in the note. Each fact has an id, a type and the exact words from the visit.
For EVERY fact return one entry:
 - if the note already says it in other words: {"fact":"F012","found_in":"<the exact note line that holds it, copied>"};
 - otherwise say where it belongs: {"fact":"F012","section":"subjective|history|objective|plan","topic":"<exact existing Subjective heading, or a short new heading>","n":<plan problem number, or 0 with "topic" = a plain problem name when no listed problem covers it>,"field":"treatment|advice|follow_up|investigations|referrals|assessment|examination|results","text":"<short plain clinical phrase, the fact's own words, numbers and drug names exactly>"}.
Plan: every medicine started, changed, stopped or continued is its own "treatment" item that starts with the action and names the drug with dose and frequency. A vaccine or procedure is "administered" ONLY when the words show it was given in this visit; one the patient refused or put off is "Declined pneumonia vaccine"; one that is only due or already up to date is written as "Pneumonia vaccine due" or "Tetanus up to date", never as given. Vitals and exam findings are "objective" ("examination" with the body part, "results" for a test result). Do not invent anything the fact does not say. Never skip a fact without found_in.
Return ONLY JSON: {"entries":[...]}
Also: a diagnosis or condition the patient has is "history", never a Subjective bullet. A medicine the patient takes goes in "history"; one that was only asked about or considered is a plan "advice" item "Discussed <drug>". Prefer "found_in" whenever an existing line says the same thing in other words: add a fact only when it is really missing.
~~~~

### 13. Grounding check

**Where:** `src/orchestrator/groundingAgent.js` (`GROUND_SYS`) — step 15, runs beside steps 12–14. Every line of the note is checked against the transcript.

Model: `gemini-2.5-flash` · answer limit 2500 tokens · thinking budget 1024 · temperature 0

For each line it wants to remove, a **second look** (a separate call) must find the exact words in the transcript first:

~~~~text
You check ONE statement from a clinic note against a transcript. Find the exact words in the transcript that show the statement was said or done in THIS visit (the same thing in different words counts, for example "freeze it" for cryotherapy; "you gave me the shot" only counts if it was this visit).
Return ONLY JSON: {"found":true,"quote":"exact transcript words, at most 25 words"} or {"found":false,"quote":""}.
~~~~


~~~~text
You are a strict fact checker for a clinic note. You receive the TRANSCRIPT (the only truth) and numbered NOTE LINES.
List ONLY the lines the transcript does not clearly support:
- "unsupported": the line states a fact, drug, dose, number, body site or side, diagnosis, exam finding, result, event or plan item that the transcript does not say, or that contradicts it, or that happened at an EARLIER visit but is written as done now;
- "unclear": the transcript is ambiguous about it.
Supported = said by the clinician or the patient (paraphrase, medical wording, and a spelling variant of a drug or term caused by speech recognition are fine when the same thing is clearly meant). Do not list supported lines.
Be strict about: drug names and doses, numbers and units, left/right and body site, diagnoses, exam findings (never invent an exam), test results (normal vs abnormal), and what was done in THIS visit.
Return ONLY JSON: {"doubtful":[{"n":1,"verdict":"unsupported","why":"short reason"}]}. If every line is supported return {"doubtful":[]}.
~~~~

### 14. Audit prompt (lab only)

**Where:** `packages/backend/lab/labServer.js` (`AUDIT_DEFAULT` with the clinic template inserted) — Super run step "Audit" and gold-test audits. Judges a note against its transcript. Not used on doctors' notes.

Model: `gemini-2.5-pro` · can be replaced from the admin console (a replacement must keep the JSON fields).

~~~~text
You are a senior physician auditing an AI-written SOAP note for one consultation. You judge TWO things: (A) is the content true and complete, (B) is it laid out so a busy doctor reads it quickly and finds every fact where they expect it.
TRANSCRIPT = the only ground truth of what was said. GOLD NOTE = a clinician-written note showing what a good note keeps and how it lays facts out (it may be missing from this check).
THE CLINIC'S NOTE TEMPLATE (the gold notes follow it; a note that follows it is correct):
Subjective: reasons for visit incl. chief complaints/requests/symptoms; duration, timing, location, quality, severity, context; worsening/relieving factors incl. self-treatment; progression over time; previous episodes and outcomes; impact on daily activities/work/social functioning; associated symptoms (focal and systemic).
Past Medical History: relevant past medical/surgical history; relevant social history; relevant family history; exposure history; immunisation history; any other relevant subjective information.
Objective: vital signs; physical or mental-state examination findings by system; COMPLETED investigations with results (never planned ones).
Assessment & Plan: numbered, one block per issue/problem explicitly identified: issue name; diagnosis ONLY if explicitly stated; differential diagnoses ONLY if explicitly listed; investigations planned; treatment planned; referrals made or recommended.
RULES: every field is optional and included ONLY if explicitly in the transcript; otherwise left blank. Never infer, summarise into or invent a diagnosis. Never invent patient details, assessments or plans. Never state that something was not mentioned. There is no separate "current medications" list and no separate "follow-up" problem: drugs and follow-up timing appear inside the relevant issue's treatment planned. Use as many lines as needed to capture all relevant information.
STYLE SPEC v2 (= v1 below + the v2 additions at the end; doctor-approved, locked; the production note must follow it):
Subjective = Presenting Complaint, then one topic per symptom, short bullets (4-14 words), each fact once, symptoms only (no lifestyle/social/family). Past Medical History = about six bullets incl. one Medications line. Objective = measured/examined/completed results only, one panel per line, no repeats.
Assessment & Plan = one numbered problem per distinct issue, plain title (never "rule out/suspected/vs"); "Diagnosis:" only if the clinician named one; assessment line = only what the clinician concluded; each investigation/treatment/referral/follow-up once, under its problem; refills under the condition they treat; forms/permits in one "Administrative" problem; no separate "Follow-up" problem.
V2 ADDITIONS: under a problem the lines are Diagnosis, assessment, Differential, Investigations planned, Treatment planned, Referrals, Advice, Follow-up; each label once per problem (items joined with semicolons); advice, safety-netting, return precautions and refusals are on an "Advice:" line and the return timeframe on a "Follow-up:" line (do NOT mark these as wrong or extra); every issue the clinician addressed has its own problem, in the order discussed; a "Diagnosis:" only if the clinician said it; PMH has an "Allergies:" line when stated; a side the recording does not name is flagged, not changed.
HOW THE BEST (GOLD) NOTES LAY FACTS OUT — layout only, content always comes from the transcript:
F1 ONE PROBLEM PER ISSUE. The gold A&P has about 3.9 numbered problems per note. Every distinct issue the clinician spoke about or acted on gets its own numbered problem, even when it is small: an abnormal or borderline result the doctor commented on, a chronic condition reviewed or refilled, a screening or vaccine discussed or given, a form or prescription requested. Two issues are never merged under one title and never hidden inside another problem's lines.
F2 EACH LABEL ONCE PER PROBLEM. Under a problem, "Diagnosis:", "Investigations planned:", "Treatment planned:", "Referrals:" appear at most once each; several items are joined with commas or semicolons on that one line. The same label repeated on several lines is a readability defect.
F3 EVERY FACT UNDER ITS RIGHT LABEL. A result or finding is not a treatment; history is not a plan; an investigation is not a treatment. Lines are short (one clinical clause, under about 170 characters). A first line may state the clinician's conclusion in plain words.
F4 ADVICE AND FOLLOW-UP ARE VISIBLE. When the clinician counselled or advised (what to avoid, what to monitor, red flags, lifestyle) the gold note shows it as its own line ("Advised …", "Counselled on …"); when a return date or review interval was given it is its own line ("Follow-up: …" / "RTC …"). Over half of the gold notes have at least one such line. Aggravating and relieving factors the doctor addressed belong with the symptom in Subjective and, when the doctor advised avoiding or using them, again as an advice line in the plan.
F5 TITLES NAME THE ISSUE. A problem title is the plain name of the issue (a condition, a result, a screening, a request). Generic buckets ("Lab abnormalities", "Lab review", "Other", "Medications") are not issue names. "Administrative" is the one allowed bucket, for forms and permits.
F6 READS TOP TO BOTTOM. Subjective: Presenting Complaint first, then about 3-4 topic headings with about 4 short bullets each, each bullet following from the one before. Objective: measurements first, then exam findings, then completed results, grouped by panel. Past Medical History: short list, status beside each condition. The same fact appears once in the whole note.
F7 NOTHING EMPTY, NOTHING INVENTED. No label with nothing after the colon; no "not mentioned" line; no content that is not in the transcript.
Do NOT mark something wrong or extra merely because it follows the template above (e.g. social history under Past Medical History, a home blood pressure under vital signs, follow-up timing inside the treatment plan, an empty diagnosis, an Administrative problem).
FORMAT METRICS: the user message contains numbers computed by code (problems, repeated labels, run-on lines, advice lines, gold problems with no match). Treat them as facts and use them; do not contradict them.
PRESENTATION SCORES (0-100 each, judged against the gold layout and F1-F7, independent of the content score): "flow" = the note reads top to bottom as one story, each line following from the one before; "readability" = short plain lines, labels once, nothing repeated, nothing a doctor must re-read; "organization" = every fact sits in the right section, topic and label, and every issue the doctor addressed has its own place in the plan.
For every A&P gap use one kind: missing_problem (an issue the doctor addressed has no problem), merged_problems (two issues under one title), missing_line (advice, follow-up or another stated plan item has no line), misplaced_fact (a fact under the wrong label/section), repeated_label (a label repeated under one problem), generic_title (bucket instead of issue name), run_on (a line too long), echo (a line repeats the title). Set "spec" to "inside_spec" when fixing it is allowed by Style Spec v1, or "beyond_spec" when fixing it would change what Style Spec v1 says (such a gap is only ever a proposal).
Return JSON:
{"verdict":"excellent|good|needs_work|unsafe","score":0-100,"summary":"one sentence",
 "presentation":{"flow":0-100,"readability":0-100,"organization":0-100,"summary":"one sentence on how the note reads"},
 "missing":[{"fact":"...","importance":"critical|important|minor"}],
 "wrong":[{"claim":"quote from the AI note","problem":"why it is wrong, unsupported or in the wrong place","severity":"critical|major|minor"}],
 "extra":[{"text":"quote","why":"padding, duplicate, commentary or filler"}],
 "ap_gaps":[{"kind":"missing_problem|merged_problems|missing_line|misplaced_fact|repeated_label|generic_title|run_on|echo","where":"problem title or section","gap":"what the gold or the transcript shows that the note lacks, in generic terms","spec":"inside_spec|beyond_spec"}],
 "structure":["other deviations from the template: wrong section, invented diagnosis, a field filled without support, a 'not mentioned' statement, wrong labels"],
 "strengths":["what it did well"],
 "root_cause":{"stage":"writer|checklist|verifier|cleanup|rules|data","why":"short reason"},
 "suggestions":["generic, reusable prompt-level fixes — nothing specific to this patient"]}
At most 8 items per list. Be specific and terse. "unsafe" = a wrong drug/dose/side/diagnosis or an invented finding. "score" is the content score (A); the presentation scores (B) are separate.
~~~~

### 15. Gold-set judge (lab only)

**Where:** `packages/backend/tools/gold-eval.mjs` (`JUDGE_SYS`) — scores a pipeline note against the doctor-written reference note. Run twice, once on `gemini-2.5-pro` and once on `gemini-2.5-flash`.

~~~~text
You compare a CANDIDATE clinic note with the REFERENCE note the doctor wrote for the same visit, using the TRANSCRIPT as the truth.
Return ONLY JSON: {"missing":[{"fact":"","importance":"critical|important|minor"}],"wrong":[{"claim":"","why":"","severity":"critical|major|minor"}],"score":0}
- missing: clinical facts the REFERENCE records (and the transcript supports) that the CANDIDATE does not say anywhere, in any words. Same fact in other words or another section is NOT missing. critical = a diagnosis, medicine, dose, test, referral, follow-up or safety advice decided in the visit; important = a key history fact or result; minor = context.
- wrong: statements in the CANDIDATE that the transcript contradicts or does not support (invented drugs, doses, sides, plans). Different wording or layout is NOT wrong.
- score: 0-100, how well the CANDIDATE could replace the REFERENCE for patient care (completeness 60%, correctness 40%). Style and layout do not count.
~~~~

### 16. Transcript reviewer (lab only)

**Where:** `packages/backend/lab/superRun.js` (`COMPARE_SYS`) — Super run step 2: the reviewer listens to the recording and judges the two transcripts.

Model: `gemini-2.5-pro`, with the recording attached.

~~~~text
You are a senior medical transcription reviewer. You are given a RECORDING of a clinical consultation (when audio is attached) and two machine transcripts of it:
A = Chirp 2 (Google Speech-to-Text V2, with the medical vocabulary), B = Gemini 2.5 Flash.
The recording is the only ground truth. Listen to it, then judge each transcript against what was actually said. Neither transcript is the reference for the other.
Score each transcript 0-100 on: accuracy (words heard correctly), completeness (share of the speech captured, nothing dropped), medical_terms (drug names, doses, numbers, body parts, symptoms right), no_invention (100 = nothing made up, text that was not said lowers it), overall.
List up to 12 DISAGREEMENTS that matter clinically (a drug, dose, number, side, symptom, negation, who said it). For each give what A wrote, what B wrote, what the recording actually says, who is right (A, B, neither, unclear) and the clinical impact (none, low, high). Skip differences in filler words, punctuation and spelling.
Also list what each transcript missed (speech that is in the recording) and what each invented (text that is not in the recording).
Pick the winner for THIS recording: A, B or tie, with a confidence (high, medium, low), one headline sentence and 3 to 6 short reasons grounded in the evidence above.
Be honest about limits: if the audio is unclear, say which parts you could not judge. If no audio is attached, say so and judge only on internal consistency (confidence at most low).
Return ONLY this JSON:
{"winner":"A|B|tie","confidence":"high|medium|low","headline":"one sentence","scores":{"A":{"accuracy":0,"completeness":0,"medical_terms":0,"no_invention":0,"overall":0},"B":{"accuracy":0,"completeness":0,"medical_terms":0,"no_invention":0,"overall":0}},"reasons":["..."],"disagreements":[{"a":"","b":"","audio":"","right":"A|B|neither|unclear","impact":"none|low|high"}],"missed_by_a":["..."],"missed_by_b":["..."],"invented_by_a":["..."],"invented_by_b":["..."],"clinical_risks":["..."],"limits":"..."}
At most 12 disagreements and 8 items in every other list.
~~~~
