# Style Spec v1 — LOCKED (doctor-approved)

**Hard rule, set by the owner on 2026-10-20: the note format below is final for now. Nothing may change it until the owner explicitly says to.**
It was built live with the training doctor's answers on a real consultation and validated on 100 unseen notes
(parity 84.1 vs 80.7, critical wrong claims unchanged). It is **not** to be "improved" using:
* the gold-note comparisons (older gold notes were written in a different style and do not contain this one),
* the newer-style cohort analysis in `docs/plans/NOTERA_STUDIO_PLAN_2026-10-20.md` (that analysis feeds **Studio only**, never this spec),
* any automatic prompt-upgrade, diagnosis loop or tuning experiment.

## The spec
**Subjective** — topics, then short bullets.
* First topic `Presenting Complaint:`; then one topic per symptom/problem (`Abdominal Pain:`, `Breathing:` …), shown as bold headings.
* Bullets are short clinical clauses (about 4–14 words), no paragraphs; each follows from the one before; every fact and every denial appears **once**, under its topic.
* Symptoms and problems only. Lifestyle, diet, habits, smoking, alcohol, social and family history are **not** in Subjective — they belong in Past Medical History.

**Past Medical History** — about six bullets: conditions/operations (every established chronic condition named in the plan is always listed, with status), one social bullet (no addresses or housing), family, immunisation/preventive, and **one `Medications:` line** with names, strengths, frequencies. No repeated drug. No "not mentioned" lines.

**Objective** — only what was measured or examined (vitals with numbers, exam findings, completed results with value and date). Results of one panel are grouped on one line, abnormal first, normals together. A result is never stated twice; patient-reported statements never appear here.

**Assessment & Plan** — one numbered problem per distinct issue, in plain wording:
* Title is the plain problem name — never "rule out…", "suspected…", "vs…" or a list of causes.
* `Diagnosis:` only if the clinician named one (never just the symptom). Differentials only if the clinician listed them.
* Assessment line = only what the clinician concluded; never a retelling of the history ("Patient reports…", "History of…").
* Each investigation / treatment / referral / follow-up appears **once**, under the problem it is about (an abdominal ultrasound belongs to the abdominal problem).
* Refills and renewals sit under the condition the drug treats (no separate "Medication refills" problem unless no condition is identifiable). Forms/permits go in one `Administrative` problem. No separate "Follow-up" problem.

**Reference names** — a brand name the clinician said gets its generic in brackets (`Synthroid (levothyroxine)`, RxNorm); a stated diagnosis gets its ICD-10-CM code in the note data when it matches exactly (no code is guessed); a diagnosis found in no reference is flagged.

**Pipeline in force:** writer (gemini-3.7-flash, 2 reference notes) ∥ checklist → merge → drug guard → chronic-in-PMH, template and placement guards, drug-plausibility flag → verifier → reviewer (editor) → story agent (topics) → repeated-fragment/result/plan tidy → address removal → investigation re-attach → assessment trimming → reference names → render.

## How the lock is enforced
| Layer | What it does |
|---|---|
| `ops.spec_lock` (database) | Locked by default. While locked: prompts cannot be promoted/activated/reset, spec-shaping settings cannot be changed, and stored overrides are **ignored** — the shipped defaults always apply. Fails closed if the database cannot be read. |
| `packages/backend/src/orchestrator/specLock.js` | The guard used by `promptStore`, `runtimeConfig` and the admin console (HTTP 423 `SPEC_LOCKED`). |
| `packages/backend/spec/LOCK.json` + `test/specLock.test.mjs` | SHA-256 fingerprint of every prompt, the shipped defaults of every spec-shaping setting, the writer prompt file, the guards, the renderer and the reference-name code. The test fails if any of them changes. |
| `node scripts/spec-lock.mjs` | Check (default) or, **only with the owner's approval**, `write <version>` to record a new approved spec. |
| Admin console → `GET /api/console/spec-lock` | Shows the state; `POST /api/console/spec-lock/unlock` needs the exact phrase `UNLOCK STYLE SPEC v1` and is audited. |

Operational limits (timeouts, hedge times, output caps) stay tunable.

## Changing the spec later
Only when the owner says so: (1) unlock in the console, (2) change, (3) re-run the validation, (4) `node scripts/spec-lock.mjs write <new version>`, (5) lock again. Studio proposals (doctor suggestions) are queued as **proposals** and never applied automatically.
