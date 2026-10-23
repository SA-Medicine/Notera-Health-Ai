# Style Spec v2.1 — LOCKED (v1 set 2026-10-20; v2 approved 2026-10-22; v2.1 fidelity guards 2026-10-22)

**Hard rule: the note format below is final for now. Nothing may change it until the owner explicitly says to.** Unlocking needs the owner's instruction and the exact phrase `UNLOCK STYLE SPEC v1` (the phrase is kept from v1 on purpose).
v2 = [Style Spec v1](STYLE_SPEC_V1_LOCKED.md) plus the changes below. Everything in v1 that is not mentioned here still applies. It was built from the doctor's Style Interview profile (confirmed), the format analysis of 410 newest-style gold notes (`docs/reports/FORMAT_ANALYSIS_2026-10-22.md`) and checked on 30 unseen transcripts (candidate v5f).

## What changed from v1
**Assessment & Plan**
* **Advice and Follow-up on their own lines.** Under a problem the lines are, in this order: `Diagnosis:` · assessment · `Differential diagnoses:` · `Investigations planned:` · `Treatment planned:` · `Referrals:` · `Advice:` · `Follow-up:`. Advice, safety-netting, return precautions and patient refusals go on `Advice:`; the return date / timeframe (and the tests it needs) goes on `Follow-up:`. Neither is a problem of its own (v1 rule kept).
* **Each label once per problem.** Several items are joined on one line with semicolons.
* **One problem per issue, in the order discussed.** Every issue the clinician addressed gets its own problem (a result they commented on, a long-term condition reviewed or refilled, a screening, a vaccine, a request). A *plan sweep* may add a missing issue only when it quotes the transcript, the issue was dealt with in this visit (not an earlier one), and it is not a test name, a drug name or a review; at most 2 additions. Nothing existing is changed.
* **`Diagnosis:` is the clinician's.** If the key words of a diagnosis are not in the transcript the line is cleared (the problem title stays).
* **Assessment line** = the clinician's conclusion, or the problem's status as the transcript shows it (stable, improved, worse, new).
* A declined referral is a plan decision (`Declined <referral> - <reason>`), not a referral.
* Medications: drug, dose, route, frequency, duration, quantity and refills when stated.
* No spoken words in the plan ("And you did that…"); "your" becomes "the".

**Past Medical History** — an `Allergies:` line (allergen - reaction) when allergies are stated.
**Subjective** — recent ER or hospital visits, recent tests, what the patient already tried and medication adherence problems are included; if the story rewrite cannot be verified, the existing lines are grouped under topic headings (nothing reworded).
**Objective** — imaging keeps the report's own wording of findings and impression.
**Language** — Canadian spelling, metric units, numerals for numbers.
**No hallucination (added 2026-10-22 on the owner's instruction)** — a *grounding agent* is the last model step: a separate call checks every line of the note against the transcript (drug names and doses, numbers, side and site, diagnoses, results, what was done in this visit). A line the model calls unsupported **and** whose key words are mostly missing from the transcript is removed; a doubtful line stays and the note is flagged "Please check against the recording". Every removal and flag is written to the note flags and the trace. `GROUNDING=0` switches it off.
**Conditions nobody said (BUILT, OFF BY DEFAULT)** — when switched on (`CONDITION_GUARD=1`), Past Medical History and problem titles name a disease only if the recording says it or says the drug that proves it (`conditionGuard.js`). A result alone never makes a diagnosis: "Diabetes" from a sugar of 6.1 is removed from Past Medical History and the title becomes "Blood sugar"; if nothing in a title is supported the note is flagged. It was switched off after a paired A/B (30 transcripts x 3 pairs, 2026-10-22): audit score 69.0 with it vs 70.9 without (pairs -3.5, +1.1, -3.3), time unchanged, the auditor's invention count lower (7.9 vs 13). The audit compares with the gold note, which keeps the conditions the guard removes. A flag-only variant (warn the doctor instead of removing) is the proposed next step.
**Plan items under the right problem (added 2026-10-22)** — a *plan attribution* step asks a model, beside the story agent, which numbered plan items sit under the wrong problem; code moves an item only with a quoted transcript line, only to an existing problem, at most 6 per note, and never changes its wording (`planAttribution.js`, `ATTRIBUTION=0` switches off).
**Other people** — lines about a partner, ex-wife, friend or similar (age, surgery, therapy) are removed from Past Medical History; the patient's own social line ("Lives with partner") and family history stay (`THIRD_PARTY=0` switches off).
**Safety** — a left/right side that the recording does not name for that body part is **flagged** for the doctor ("Please check the side"), never changed silently.
**Robustness (no format change)** — a writer draft with no plan or a repetition loop is retried once on the same model, then once on the fallback model.

## v2.1.0 — fidelity guards (owner unlocked 2026-10-22 after a reviewed note: invented smoking/living details, an unspoken drug, a "sleep study" nobody said, "Rovastatin" next to "Crestor (rosuvastatin)", an empty heading, a stool test written twice)
Pure-code step `fidelityGuards.js` after the grounding agent and the reference names (switch `stage.fidelityGuards`, `FIDELITY_GUARDS=0`); no format or prompt change.
* **Social history** (smoking, alcohol, drugs, living situation, marital status, work) stays only if the recording has the patient say it, or the clinician ask them. A clinician listing reflux triggers is advice, not history. Unsupported clauses are removed (flag "Removed from the note").
* **Drug names the recording never says**: by ending (-prazole, -sartan, -statin, -tidine …) replaced by the class ("PPI") and flagged; any other medication name nothing in the recording resembles becomes "medication (name unclear)" and is flagged with the name (`drugGuard.js`). Ordinary English words are never taken as a drug "heard" ("Allegra" is not "allegedly"). A name the recognizer split in two ("zep bound") counts as said.
* **One name per drug**: when a spoken brand has an exact generic (Crestor = rosuvastatin) and the recording also holds a near spelling ("rovastatin"), the generic is written everywhere; a drug is listed once in Medications.
* **Tests nobody mentioned** (sleep study, ultrasound, biopsy …) are taken out of the plan with the words around them and flagged.
* **Tidy**: empty headings dropped; a stool test (FIT, "poop kit" -> stool test kit) written once per problem; vaccines are treatment, not investigations; a referral already in the investigations line is not repeated; screening status and diet lines in Past Medical History that the plan or story already carries are dropped.
* **Flags only (nothing changed)**: a dose or duration in the plan that the recording never says; wording about MRI compatibility of an implant when the recording is not clear ("confirm from the operative record").

## v2.1.1 — plan completeness (owner unlocked 2026-10-23 with `UNLOCK STYLE SPEC v1`, after a reviewed note whose plan had two bare headings, "Weight loss" and "Benign prostatic hyperplasia", and lacked the advice "weigh at every visit" and the two-week report-back)
Cause: the guards correctly remove a `Diagnosis:` line that only repeats the heading (quality guards, tidy), and the writer had put nothing else under it; nothing then looked at the bare heading again. New stage `planComplete.js` after the plan sweep and before the grounding agent (switch `stage.planComplete`, `PLAN_COMPLETE=0`); no format or prompt-registry change.
* One call reads the transcript and the numbered problems and returns what the clinician decided that a problem's lines leave out: treatment, advice, follow-up, tests, referrals; an assessment only for a problem with no lines. Every item needs an exact 6–25 word quote that is really in the transcript, is not history, not a stopped medicine, not already in the plan; at most 3 per problem, 10 per note. No diagnosis is ever created and no existing line is reworded.
* Advice and follow-up are added as parts of the treatment line, so the unchanged Advice / Follow-up splitter shows them on their own lines.
* A problem that is still a bare heading after that is removed (the Subjective already tells the story); if the model could not be asked the heading stays and the clinician gets a "Nothing is written under this problem" check. If every problem is bare they all stay.

## v2.1.2 — coverage check (owner unlocked 2026-10-23 with `UNLOCK STYLE SPEC v1`: "there should be nothing missing")
New stage `noteCoverage.js` after plan completeness and before the grounding agent (switch `stage.noteCoverage`, `NOTE_COVERAGE=0`); no format or prompt-registry change.
* One call reads the transcript against the finished note and lists what was said and is not in it: Subjective facts (under the topic heading they belong to, or a new heading), history (earlier tests and results, conditions, vaccines, medicines), examination and results, and plan items (through the plan-completeness checks).
* An item needs an exact 6–25 word quote that is really in the transcript, must not already be in the note, is a short plain phrase, and is capped at 12 per note. No diagnosis is created, no existing line is reworded or removed. The grounding agent then checks the added lines like all others.

## Open questions, kept as in v1 (owner decision 2026-10-22)
Refills stay under the condition the drug treats (A5) · Past Medical History stays at about six bullets plus Medications (P1) · results of one panel stay on one line (O2) · bullets stay short clinical clauses.

## Pipeline in force
writer (gemini-3.7-flash, prompt `prompts/writer-v5.txt`, 2 reference notes) ∥ checklist → (draft retry if no plan/loop) → merge → drug guard → chronic-in-PMH, template and placement guards, drug-plausibility flag → verifier → reviewer (editor) → story agent (topics; 3 tries, then grouping fallback) → repeated-fragment/result/plan tidy → address removal → investigation re-attach → assessment trimming → **quality guards (diagnosis, spoken words, side check)** → **plan sweep** → **plan completeness (v2.1.1)** → **coverage check (v2.1.2)** → **grounding agent** → reference names → **labels joined** → render → **Advice / Follow-up lines**.
Switches for emergencies only: `QUALITY_GUARDS=0`, `ADVICE_LINES=0`, `PLAN_SWEEP=0`, `PLAN_COMPLETE=0`, `NOTE_COVERAGE=0`, `PLAN_JOIN_LABELS=0`, `GROUNDING=0`.

## How the lock is enforced
Same as v1: `ops.spec_lock` (database, fails closed), `specLock.js`, `spec/LOCK.json` + `test/specLock.test.mjs` (SHA-256 of the writer prompt `prompts/writer-v5.txt`, every prompt, shipped defaults of spec-shaping settings, the guards, the renderer, reference names **and the v2 code**: plan join, plan sweep, quality guards, laterality, advice lines, writer retry, topic grouping, grounding agent, condition guard, plan attribution), `node scripts/spec-lock.mjs` (check; `write <version>` only with owner approval). Studio checks notes against `spec/style-spec-v2.json` (rules A8–A12, P5–P7, G2, G3 added).

## Result on the 30 held-out transcripts (candidate v5f, lab)
| | v1 pipeline | v2 |
|---|---|---|
| Notes with topic headings | 18 / 30 | 29 / 30 |
| A&P problems per note (gold 3.87) | 3.60 | 3.77 |
| Notes with a repeated plan label | 12 | 0 |
| Notes with no plan | 2 (earlier run) | 0 |
| Advice lines / follow-up lines per note (gold 0.47 / 0.50) | 0.03 / 0 | 1.40 / 0.37 |
| Auditor content mean (Gemini 2.5 Pro) | 67.2 | 70.0 |
Known weak spots: advice lines run about three times the gold rate; "oesophageal"/"esophageal" can mix; a plan item such as a vaccine can land under investigations; ambiguous audio can produce a wrong body site (the side check only flags a side).
