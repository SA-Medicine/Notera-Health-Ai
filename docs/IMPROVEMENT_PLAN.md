# Notera — System Improvement Plan (grounded in the 10-patient eval)

Generated from a full `eval/run_eval.mjs` run over the 10 gold Heidi transcripts,
plus a close read of every generated-vs-gold note. This is the prioritized plan to
raise note quality across schema, prompts, and engines.

## 1. Empirical scorecard (baseline)

| Metric | Value | Read |
|---|---|---|
| Schema validity | 100% | Structure never invalid ✓ |
| Avg section coverage | 72.5% | Several notes missing PMH/Objective/A&P |
| Avg similarity to gold | 0.28 | Low — paraphrasing + real omissions |
| Avg omission rate | 61% | High — content is being lost |
| Unsupported meds | 0 | (NER was off, so cross-check didn't run) |
| Hard failures | 1/10 (done_Patient3) | JSON truncation |
| Flagged | 2/10 (patient1, done_Patient3) | see below |

Per-patient: Patient6 sim 0.14 (garbled refill), done_Patient3 0.0 (crash),
patient1 flagged despite a good rendered note (structuring dropped its sections).

## 2. The two decisive root causes (fix first — biggest wins)

### P0-1 — `structureNote` (2nd Gemini pass) loses whole sections  ★ highest impact
**Evidence:** patient1's `renderedNote` contains a full PMH block and 4 numbered A&P
problems, but the *structured* `note.past_medical_history` is `""` and
`note.assessment_and_plan` is `[]`. The metric (and the review UI) score the
structured note, so good pipeline output is thrown away.
**Root cause:** the orchestrator renders the pipeline to markdown, then makes a
SECOND Gemini call (`backend/src/orchestrator/structureNote.js`) to re-parse that
markdown into schema JSON. That call is lossy and sometimes returns partial JSON.
**Fix:** replace the LLM re-structuring with a **deterministic mapper from the
pipeline's own `clinical_story`** (it already holds `subjective_slots`, `pmh_lines`,
`objective_lines`, `assessment_plan`). Map those slots straight into schema v2 — no
extra LLM call, no loss, faster, free. Keep the Gemini structurer only as a fallback
when `clinical_story` is absent.
**Files:** `backend/src/orchestrator/structureNote.js` (new `storyToSchema(story)`),
`backend/src/orchestrator/generateNote.js` (call it when `clinical_story` exists).

### P0-2 — Extraction JSON truncation crashes the whole note
**Evidence:** done_Patient3 → `Failed to parse output as JSON: Unterminated string at
position 99905`. The extraction produced ~100KB of JSON and still hit the output
limit, truncating mid-string; `safeParseJson` couldn't recover, so the pipeline
returned "Pipeline failed."
**Root cause:** long transcript × verbose extraction schema × `maxOutputTokens` cap.
**Fix (layered):**
1. Raise `GEMINI_MAX_OUTPUT_TOKENS` for the extraction call (set explicitly, e.g. 65536).
2. Make the extraction schema leaner (fewer verbose enum descriptions).
3. Harden `safeParseJson` to salvage a truncated array of entities (close the last
   complete object, drop the partial one) instead of returning null.
4. On extraction parse-failure, **retry once with a shorter/ް chunked prompt** rather
   than failing the note.
**Files:** `pipeline/utils/safeParseJson.js`, `pipeline/agents/ClinicalObservationExtractorAgent.js`, `.env`.

## 3. Deterministic rendering/engine bugs (P0 — cheap, high value)

### P0-3 — Exam findings duplicated + double region prefix at render time
**Evidence (Patient4 Objective):**
```
Gait: Gait: Normal heel and toe walking     ← "Gait:" prefixed twice
No palpable bump or mass                     ← appears twice
Gait: Normal heel and toe walking            ← duplicate of line 1
No pain on forward flexion or touching toes  ← near-dup of "No pain on bending over..."
```
**Root cause:** the renderer builds Objective exam from BOTH `story.objective_lines.exam_findings`
AND `entities(physical_exam)`, so the dedup that runs on the story is bypassed; and it
prepends the region label even when the text already starts with it.
**Fix:** in `TemplateAssemblyAgent` render one merged, deduped exam list (normalize +
subsumption), and only prefix the region when the text doesn't already contain it.
**Files:** `pipeline/agents/TemplateAssemblyAgent.js`.

### P0-4 — A&P title echoes still slip through
**Evidence (patient1 #3):** `Misstep and fall off stool.` / `Left Foot Pain.` (echoes
the problem title) — my `dedupeV31` removes title echoes, but `AssessmentReasoner`
runs AFTER the deduplicator and re-introduces lines.
**Fix:** run the title-echo/subsumption dedup as the FINAL step (after AssessmentReasoner),
or have AssessmentReasoner call the same dedup helper.
**Files:** `pipeline/PipelineEngine.js` (ordering), `pipeline/agents/AssessmentReasoner.js`.

### P0-5 — Administrative refill encounters produce garbage
**Evidence (Patient6):** gold = "Medication refills for Alexi — all meds incl. thyroid,
6-month supply, sent to McGregor pharmacy". Generated = junk problem **"Other active
issues: The red one. Thyroid."**, invented "Arm pain", dropped pharmacy + supply.
**Root cause:** `ProblemGeneratorEngine` builds a generic "Other active issues" bucket
and fragments; the admin-refill template isn't specialized.
**Fix:** detect `medication_refill_administrative` (Agent 0 already classifies it) and
route to a dedicated compact renderer: one problem "Medication refills for <patient>",
`Treatment planned: <meds> refilled for <duration>, sent to <pharmacy>`. Never emit
"Other active issues" or bare fragments ("The red one").
**Files:** `pipeline/agents/engines/ProblemGeneratorEngine.js`, `pipeline/agents/engines/templates/MedicationManagementTemplate.js`, `TemplateAssemblyAgent.js`.

### P0-6 — Objective rendered empty when exam content exists
**Evidence (Patient8 derm):** Objective block empty though the rash exam was described.
**Fix:** route derm/skin exam descriptions to `objective.examination`; if Objective has
no vitals/labs but there are exam findings, still render the exam sub-block.

## 4. Fact-accuracy / prompt issues (P1)

### P1-1 — Fabrications (invented facts)
**Evidence (patient1):** family history "Uncle, **Father**" (gold: uncle only);
drug "almunia/Alumnia" rewritten to "**Ilumya**" (model "corrected" a transcription).
**Fix:** (a) strengthen the extraction + slot-filler prompts: "NEVER add a person,
relationship, drug, dose, or value not literally in the transcript; NEVER normalize or
correct a drug name — copy it verbatim." (b) Add a **fabrication guardrail**: cross-check
family-history relations and drug names in the note against the transcript tokens; flag
any not present. (c) Turn on the NER med cross-check in the eval (run the sidecar).
**Files:** `ClinicalObservationExtractorAgent.js`, `ClinicalStoryLLMAgent.js`, `backend/src/validation/guardrails.js`.

### P1-2 — Disease-management block not grouped
**Evidence:** gold carves a **"Diabetes Management:"** subjective sub-block (home glucose,
eye exam, diet); Notera scatters these into HPI.
**Fix:** add a `disease_management` subjective slot to the slot-filler schema + prompt,
and render it as its own bold sub-header ("<Condition> Management:"). This matches Heidi
and removes the HPI clutter.
**Files:** `ClinicalStoryLLMAgent.js` (slot), `TemplateAssemblyAgent.js` (render), `schema` (optional field).

### P1-3 — Specific context omitted
**Evidence:** "while fixing garage door opener", "sent to McGregor pharmacy", "6-month
supply" dropped. Similarity is low partly from this.
**Fix:** slot-filler prompt: "preserve the specific who/where/how-much context clauses
verbatim; do not generalize." Consider a coverage pass that flags gold-style key nouns
(pharmacy names, durations, mechanisms) missing from the draft.

### P1-4 — Flexible, encounter-driven sub-headers
**Evidence:** gold uses bespoke subjective headers (Parental Concern, Prescription refill
requests, Weight Progression, Home blood glucose monitoring) — Notera is fixed to 3.
**Fix:** allow the slot filler to emit an optional labeled "other" subjective block, and
let encounter type drive header names (already have per-specialty templates to key off).

## 5. Measurement / eval improvements (P2 — so we can trust the numbers)

- **Section-coverage false positives:** it penalizes legitimately-empty PMH/Objective
  (e.g. a pure refill has no PMH). Weight coverage by what the gold note actually fills.
- **Similarity/omission are token-overlap** → they punish good paraphrase. Add an
  **LLM-as-judge factuality metric** (facts present / hallucinated / omitted) as the real
  signal, keeping token metrics as a cheap proxy.
- **Score the `renderedNote`, not only the structured note** (until P0-1 lands they
  diverge; after P0-1 they'll agree).
- **Run the NER sidecar during eval** so the medication cross-check actually reports.
- Add a **regression gate**: re-run these 10 after every change; no change ships if it
  lowers factuality or reintroduces a fixed bug.

## 6. Prioritized roadmap

**Sprint 1 (P0 — do these first; mostly deterministic, no quality risk)**
1. P0-1 deterministic `clinical_story → schema` mapper (kills the biggest omission).
2. P0-2 fix extraction truncation (raise tokens + robust JSON salvage + retry).
3. P0-3 render-time exam dedup + region prefix.
4. P0-4 final-pass A&P dedup (title echoes).
5. P0-5 administrative-refill compact path.
6. P0-6 Objective renders exam when present.
→ Expected: coverage ~100%, omission down sharply, 0 crashes, no dup/echo garbage.

**Sprint 2 (P1 — accuracy & Heidi-fidelity)**
7. Fabrication guardrails + never-normalize-drugs prompt.
8. Disease-management subjective block.
9. Context-preservation prompt + coverage flags.
10. Flexible sub-headers.

**Sprint 3 (P2 — measurement & durability)**
11. LLM-judge factuality metric + coverage reweighting.
12. NER on in eval; regression gate; per-change scorecard.

## 7. One-line summary
The pipeline's *rendered* notes are already close to Heidi; the biggest losses are
(a) a lossy LLM re-structuring step that drops sections, (b) a truncation crash, and
(c) a few deterministic dedup/render bugs and the admin-refill path. Fix those six P0
items first — they're low-risk and should move coverage to ~100% and cut omissions hard
— then tighten fact-accuracy and the metrics.
