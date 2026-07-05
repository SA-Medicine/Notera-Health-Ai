# Roadmap to Launch — What's left to beat the current SOAP-note platforms

Competitor set: Heidi, Nabla, Abridge, DeepScribe, Freed, Suki, Sunoh, Tali.
Legend: ✅ done · 🟡 partial/stubbed · ⬜ not started. Cross-refs to `planning/00`–`10`.

---

## Already in place (so you don't rebuild it)
- ✅ Ported multi-agent generation pipeline (Gemini) → schema v2 (your exact Heidi template)
- ✅ De-identify → generate → re-identify (AI-Studio-safe); guardrail med cross-check
- ✅ In-house NER sidecar (scispaCy/Med7/medspaCy) — graceful-degrade
- ✅ Firestore data layer + append-only audit log; memory driver for dev
- ✅ Next.js frontend: landing, login (mock), review UI, dev pipeline-logs, history
- ✅ Eval harness + metrics + dataset/tuning-file builder
- ✅ Cloud Run deploy scripts, Firebase config, `.env`

---

## P0 — Must-have to run a real pilot (weeks 1–4)

### Auth & tenancy
- ⬜ Real **Firebase Auth** (swap the 3 mock fns in `AuthProvider.tsx`)
- ⬜ **Roles** (clinician/admin) enforced server-side, not just UI
- ⬜ **Org / clinic** entity → multi-tenant data isolation in Firestore + rules
- ⬜ Email verification, password reset, session expiry/refresh
- ⬜ Real clinician identity threaded into every backend call + audit (replace `demo-clinician`)

### Ambient capture (the #1 competitor feature)
- 🟡 Browser mic capture exists → ⬜ **stream audio to backend → medical ASR** (currently paste-only)
- ⬜ **Live streaming transcription** while the visit happens (Chirp streaming)
- ⬜ Real **speaker diarization** shown/editable (clinician vs patient)
- ⬜ Audio file **upload** path (mp3/wav/m4a → GCS → ASR)
- ⬜ Mobile-friendly capture (record on phone)

### Async job flow (doc 10 §5)
- 🟡 Generation is synchronous → ⬜ **queue + live status** (transcribing→drafting→ready) via Firestore listener or SSE; progress bar in UI (backend already emits `onProgress`)
- ⬜ Idempotency/retry so a re-submit never double-creates a note

### Compliance to touch real PHI (doc 04)
- ⬜ Sign **Google Cloud BAA**; confirm Firestore/GCS/Speech coverage + region
- ⬜ **Consent capture** (documentation vs training — separate) + storage
- ⬜ Validate de-identification on real samples; add DATE/AGE edge cases
- ⬜ Data **retention + right-to-erasure** delete flow (consult + derived + deidMap)
- ⬜ Encrypt/lock the `deidMap` collection harder (separate KMS/Secret Manager)

---

## P1 — Competitive parity (weeks 4–10)

### Note quality & output
- ⬜ **Confidence per section** populated (schema supports it; wire from pipeline) → highlight low-confidence in UI
- ⬜ **Source traceability**: click a note line → highlight the transcript span (pipeline already tracks `source_span`) — a real differentiator few have
- ⬜ **Multiple templates**: SOAP, your Heidi template, referral letter, patient-friendly summary, specialty variants (doc 02 base+extensions)
- ⬜ Per-clinician **custom templates** + saved preferences (tone, length, headings)
- ⬜ **ICD-10 / CPT / SNOMED** code suggestions per A&P issue
- ⬜ **Dictation / edit commands** ("add to plan…", voice corrections)
- ⬜ Multi-language consults (ASR + note language)

### EHR integration (huge moat; the old extension hinted at it)
- 🟡 FHIR export exists in pipeline → ⬜ **SMART-on-FHIR** app + write-back to Epic/Cerner/athena
- ⬜ **One-click copy / paste into EHR field** (revive the extension's inject, or a browser companion)
- ⬜ Patient context read-in (problem list, meds, allergies) to pre-fill PMH

### Feedback flywheel (docs 02 §8, 03 §5)
- 🟡 Feedback record stored → ⬜ actually **compute the draft→final diff** and store per field
- ⬜ Weight/oversample edited cases → periodic **Gemini tuning** job (Vertex, when you switch)
- ⬜ "Why did it change?" analytics per section to target weak spots

### Admin & trust surface
- ⬜ **Admin dashboard**: usage, $/note, acceptance rate, edit distance, model version
- ⬜ **Model registry UI** + eval scorecard (docs 03 §6, 04 §4) with champion/challenger
- ⬜ Audit-log **viewer** for compliance officers

---

## P2 — Differentiators & scale (weeks 10+)

- ⬜ **Custom BioClinicalBERT NER** head if pre-trained misses schema entities (doc 03 §3b)
- ⬜ Shadow-deploy → canary → promote pipeline; rollback (doc 04 §4)
- ⬜ Monitoring/observability: latency p50/p95/p99, error rate, **quality drift** alerts (doc 04 §5)
- ⬜ Load test at peak; autoscaling verified (doc 04 §7)
- ⬜ CI/CD (tests + eval gate on every PR), staging env, secrets rotation
- ⬜ Prompt-injection defense (transcripts are untrusted input, doc 04 §6)
- ⬜ Pen test / security review before go-live (doc 04 §8)
- ⬜ Real-time collaboration / hand-off between scribe and clinician
- ⬜ Analytics for patients: after-visit summary export

---

## Minute / polish (cheap wins, high perceived quality)

- ⬜ **Copy note** button + **Export PDF/Word** of the finished note
- ⬜ **Print** stylesheet
- ⬜ Loading **skeletons** + a real progress bar during generation
- ⬜ Toast notifications for save/approve/errors (replace inline only)
- ⬜ Empty states + friendly error pages (404/500)
- ⬜ **Autosave** draft edits (debounced) so nothing is lost
- ⬜ Keyboard shortcuts (⌘↵ approve, ⌘S save, / focus transcript)
- ⬜ Transcript **side-by-side** with the note on review
- ⬜ Unsaved-changes guard on navigate away
- ⬜ Favicon, OG/social meta, app icons, page titles per route
- ⬜ Accessibility pass (labels, focus rings, aria, contrast) + screen-reader test
- ⬜ Dark mode
- ⬜ Mobile/responsive QA on the review screen
- ⬜ Rate limiting + input size caps on API routes
- ⬜ "Remember me" + idle timeout on auth
- ⬜ Per-note **status badges** in history (draft/flagged/signed) + search/filter
- ⬜ Settings page (default specialty, template, ASR language)
- ⬜ In-app feedback/thumbs on each section
- ⬜ Version/commit shown in footer; health page
- ⬜ Seed a few demo consults so History isn't empty on first run

---

## Suggested order (fastest path to a credible pilot)
1. Firebase Auth + roles + real clinician id (P0 auth)
2. Async status + progress bar + copy/export note (P0 flow + polish)
3. Audio upload → medical ASR, then live streaming (P0 ambient)
4. Confidence + source-traceability highlighting (P1 quality — cheap, impressive)
5. BAA + consent + retention/delete (P0 compliance) before any real PHI
6. Admin dashboard + feedback-diff flywheel (P1 trust + moat)
