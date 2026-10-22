# Style Spec v2 — LOCKED (owner-approved 2026-10-22)

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
**Safety** — a left/right side that the recording does not name for that body part is **flagged** for the doctor ("Please check the side"), never changed silently.
**Robustness (no format change)** — a writer draft with no plan or a repetition loop is retried once on the same model, then once on the fallback model.

## Open questions, kept as in v1 (owner decision 2026-10-22)
Refills stay under the condition the drug treats (A5) · Past Medical History stays at about six bullets plus Medications (P1) · results of one panel stay on one line (O2) · bullets stay short clinical clauses.

## Pipeline in force
writer (gemini-3.7-flash, prompt `prompts/writer-v5.txt`, 2 reference notes) ∥ checklist → (draft retry if no plan/loop) → merge → drug guard → chronic-in-PMH, template and placement guards, drug-plausibility flag → verifier → reviewer (editor) → story agent (topics; 3 tries, then grouping fallback) → repeated-fragment/result/plan tidy → address removal → investigation re-attach → assessment trimming → **quality guards (diagnosis, spoken words, side check)** → **plan sweep** → **grounding agent** → reference names → **labels joined** → render → **Advice / Follow-up lines**.
Switches for emergencies only: `QUALITY_GUARDS=0`, `ADVICE_LINES=0`, `PLAN_SWEEP=0`, `PLAN_JOIN_LABELS=0`, `GROUNDING=0`.

## How the lock is enforced
Same as v1: `ops.spec_lock` (database, fails closed), `specLock.js`, `spec/LOCK.json` + `test/specLock.test.mjs` (SHA-256 of the writer prompt `prompts/writer-v5.txt`, every prompt, shipped defaults of spec-shaping settings, the guards, the renderer, reference names **and the v2 code**: plan join, plan sweep, quality guards, laterality, advice lines, writer retry, topic grouping, grounding agent), `node scripts/spec-lock.mjs` (check; `write <version>` only with owner approval). Studio checks notes against `spec/style-spec-v2.json` (rules A8–A11, P5, G2, G3 added).

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
