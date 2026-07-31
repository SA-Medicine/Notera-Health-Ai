# Notera — System Upgrader Action Plan

_Consolidation of the 47 system-level suggestions produced by the LLM System Upgrader across runs #16–#19 (150-patient batch), deduplicated, prioritized, and grounded in current clinical-NLP practice._

---

## 1. TL;DR

The 47 raw suggestions are **highly redundant** — they collapse into **7 engineering initiatives** plus **1 meta-finding**. Roughly half of all suggestions (25/47) are two variants of the same idea: *stop the pipeline from misplacing medication content and mis-binding pharmacies*. Another ~10 are the same idea that *encounter classification should not gate downstream extraction*.

Almost every failure traces to **three patients**: `Patient9` (pharmacy/dose swaps), `Patient5` (medication dosing landed in Objective; gynecology classification suppressed ADD facts), and `kp` (empty transcript → hallucinated knee pain). Fixing the initiatives below resolves all of them.

| # | Initiative | Raw suggestions folded in | Priority | Effort | Type |
|---|------------|---------------------------|----------|--------|------|
| A | Deterministic Medication–Attribute Extractor + Section Router | 25 | **P0** | L | Pipeline + Guardrail |
| B | Empty / Blank-Transcript Fast-Path | 3 | **P0** | S | Guardrail |
| C | Decouple Encounter Classification from Extraction | 10 | **P1** | M | Pipeline |
| D | Medication Value Sanitizer + RxNorm Verification | 6 | **P1** | M | Guardrail + Data |
| E | qa-validator Output-Contract Fix | 4 | **P1** | S | Pipeline |
| F | Non-Patient Speaker (Caregiver) Filter | 2 | **P2** | M | Pipeline/Data |
| G | Negative-Fact + Temporal-Consistency Validators | 3 | **P2** | M | Guardrail |
| — | **Meta-finding:** the "prompt truncation" suggestions are a mirage | 2 | — | XS | Fix upgrader |

Legend — Effort: S ≤ 1 day · M ≈ 2–4 days · L ≈ 1–2 weeks. Priority: P0 = ships next, P1 = this cycle, P2 = backlog.

### Implementation status (updated)

**Phase 1 — SHIPPED & unit-tested** (`packages/backend/src/validation/upgrades.js`, 20/20 tests green in `upgrades.test.mjs`, wired into `orchestrator/generateNote.js`; every action prints an `[upgrade:*]` line to the run logs):

- ✅ **A — section-router** (`routeMedicationToPlan`): medication dosing/titration lines are moved out of Objective/Subjective into the best-matching problem's `treatment_planned`.
- ✅ **B — blank-encounter gate** (`isBlankEncounter`): an empty/phatic encounter emits an empty note and **skips** the narrative generator — no more `kp`-style confabulation.
- ✅ **G — temporal-validator** (`validateTemporalStatus`): a future/planned investigation carrying a completed result status ('normal'/'abnormal') is relocated to Plan with the status stripped.
- ✅ **D-Tier1 — value-flagger** (`flagSuspiciousValues`): doses fused with non-clinical tokens ("30 Brian") are flagged `critical` for sign-off.

**Phase 2 — SHIPPED & unit-tested** (32/32 tests green in `upgrades.test.mjs`; all log `[upgrade:*]`):

- ✅ **A-pharmacy-binding** (`verifyPharmacyBinding`, `upgrades.js`): extracts `(medication → pharmacy)` pairs from the transcript by proximity and flags any note assignment that contradicts them (Patient9 gabapentin→Rexall-vs-Prexol). Wired into `applyUpgradeGuardrails`.
- ✅ **C-classification decouple** (`adminRefillFailsafe`, wired into `EncounterClassifierAgent.js`): an `medication_refill_administrative` encounter that actually contains a dose change or pharmacy routing is promoted to `medication_refill` so downstream extraction runs at full fidelity.
- ✅ **D-Tier2 RxNorm** (`services/rxnorm.js`): RxNav client (RxCUI normalize + ATC/EPC class), base-URL configurable for RxNav-in-a-Box, injectable fetch, cached. Flags medications that don't resolve to a real drug concept. Opt-in via `RXNORM_VERIFY=1`, wired into `generateNote` (network-optional, never blocks). Logic unit-tested with a mocked RxNav.
- ✅ **E-qa-contract guard** (`looksLikeBenchmarkingPrompt`, wired into `ClinicalQAValidatorAgent.js`): if a benchmarking rubric was mistakenly published to `qa-validator`, the agent detects it and falls back to the gate prompt (non-destructive) so the runtime output contract can't drift.
- ✅ **F-caregiver flag** (`flagNonPatientContext`): transcripts here have no speaker labels, so instead of unsafely dropping facts it flags caregiver/proxy language for reviewer verification.
- ✅ **Meta — upgrader context-trim** (`handler.js`): the current prompt is now shown in full (60k view cap with an explicit "VIEW CAP ONLY — the live prompt is COMPLETE" marker), so the optimizer stops inventing phantom "prompt truncation" fixes.

Everything above is deterministic and self-contained; the only external dependency (RxNav) is opt-in and degrades gracefully.

---

## 2. Why these matter (research grounding)

- **Medication-attribute extraction is a solved, benchmarked task.** The n2c2 2022 "Contextualized Medication Event" shared task (CMED, 500 notes) frames exactly what Notera needs: medication NER + *event* (is a change discussed?) + *context* (action / negation / temporality / certainty / actor). Best systems hit micro-F1 **0.973 / 0.911 / 0.909**. That is the blueprint for Initiative A — a small, deterministic-ish extractor that binds `(medication → dose → frequency → pharmacy → current|future)` before generation. ([n2c2 2022 overview](https://www.sciencedirect.com/science/article/pii/S1532046423001533), [deep-learning medication disposition + attributes](https://pmc.ncbi.nlm.nih.gov/articles/PMC10527481/))
- **Drug-name normalization has a canonical source.** NLM's **RxNorm / RxNav** `getDrugs` maps any spoken label to a stable RxCUI, and **RxClass** returns its ATC / EPC *therapeutic class*. That is precisely the check that catches "Lolo → Lunesta" (a sedative masquerading as a contraceptive) and blocks nonsense values like "30 Brian". Available offline via **RxNav-in-a-Box** (important for PHI/latency). ([RxNorm/RxNav APIs](https://lhncbc.nlm.nih.gov/RxNav/APIs/index.html), [getDrugs](https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getDrugs.html), [RxNorm normalization case study](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10796552/))
- **Proposition-level, LLM-free fact-checking beats prompt-only guardrails.** A 2025 module validates each clinical proposition against source data with discrete logical checks — **negation, temporal consistency, numerical comparison** — reaching **F1 0.856** for hallucination detection. That is the design pattern for Initiatives A, D, and G (deterministic post-checks, not another LLM asking an LLM to behave). Framework work reports hallucination rates of **1.47%** (well-guarded) vs **15–35%** (unguarded), and treats hallucination (precision) and omission (recall) as *distinct* error classes — matching what the Upgrader sees. ([clinical safety/hallucination framework, npj Digital Medicine](https://www.nature.com/articles/s41746-025-01670-7), [redefining hallucination for SOAP evaluation](https://arxiv.org/pdf/2604.14829))
- **Non-patient speaker attribution is a known weak spot.** Ambient-scribe literature notes speaker attribution "varies most across tools," and that a caregiver's *reported* history belongs in Subjective as reported-by — not merged into the patient's own symptoms. This validates Initiative F (Patient6: caregiver "Mona" contaminated the graph). ([ambient scribe diarization guide, AssemblyAI](https://www.assemblyai.com/ambient-ai-scribes-guide), [scaling ambient scribes, npj Digital Medicine](https://www.nature.com/articles/s41746-026-02554-0))

Recurring theme from the research: **prefer deterministic, source-grounded post-checks over more prompt text.** Every P0/P1 initiative below is a discrete validator or extractor, not a prompt tweak.

---

## 3. The initiatives

### A · Deterministic Medication–Attribute Extractor + Section Router — **P0**
**Folds in 25 suggestions** (all the "pharmacy swap", "medication in Objective", "section routing", "dosing guardrail" variants).

**Problem (evidence):**
- *Patient9* — pharmacies swapped across drugs (gabapentin → Rexall instead of Prexol; Shoppers Essex for Zepbound dropped) and a *proposed* dose (50 mg BID) conflated with the *current* dose.
- *Patient5* — ADD dosing/titration and a future pelvic ultrasound order placed under **Objective/Investigations** instead of **Plan**.

**What to build (two deterministic passes, before final synthesis):**
1. **Medication-relation extractor** — produce structured tuples `{medication, current_dose, target_dose, frequency, route, pharmacy_destination, action ∈ current|start|increase|stop|refill, actor, source_quote}` bound *at extraction time* from adjacent transcript spans. Model this on n2c2 CMED (NER → event → context). Can start rules-first (regex for `\d+\s?mg`, known pharmacy gazetteer, "increase to / start / sent to") and harden with the existing LLM extractor as backfill.
2. **Section router / guardrail** — a deterministic check (extend the existing `orchestrator/reconcileNote.js`, which already routes labs/vitals → Objective and referrals → A&P): *medication dosing, titration, starts, and future orders may never appear in Objective/Investigations or Subjective timing slots* → force-route to the relevant Problem's `treatments[]`. Reject/relocate on violation.
3. **Pharmacy-binding verifier** — post-generation, assert every `(medication → pharmacy)` edge in the note matches the edge in the extracted graph; block/flag cross-attribution.

**Where:** `packages/backend/src/pipeline/agents/ClinicalObservationExtractorAgent.js` (emit tuples), `packages/backend/src/orchestrator/reconcileNote.js` (section routing — already the right home), `packages/backend/src/validation/guardrails.js` (binding verifier + hard reject).

**Done when:** Patient5 dosing appears only in Plan; Patient9 pharmacies bind to the correct drugs and current≠target doses are distinguished; a regression test asserts "no `mg`/`daily`/`increase to` inside Objective or Subjective-timing".

---

### B · Empty / Blank-Transcript Fast-Path — **P0**
**Folds in 3 suggestions** (Empty/Silent Transcript Interceptor, Blank Encounter Fast-Path, and the `empty_or_invalid` classifier route).

**Problem (evidence):** `kp` had an essentially empty/phatic transcript; the generator invented a knee-pain presentation. This is the classic "no input → confabulation" failure that unguarded clinical LLMs show at 15–35%.

**What to build:** a gate immediately after fact extraction: if the clinical fact graph is empty or contains only conversational phatics (no medical entity after NER + medical-keyword check), **bypass slot-filling entirely** and emit a blank/administrative template — never call the narrative generator. Wire the encounter-classifier's `empty_or_invalid` verdict to short-circuit the pipeline.

**Where:** `packages/backend/src/pipeline/PipelineEngine.js` (early-exit branch), `EncounterClassifierAgent.js` (ensure it can return `empty_or_invalid`).

**Done when:** an empty/near-empty transcript yields an empty note (0 fabricated entities), verified by a fixture.

---

### C · Decouple Encounter Classification from Downstream Extraction — **P1**
**Folds in 10 suggestions** (gynecology dropped ADD; `medication_refill_administrative` dropped clinical detail; multi-issue/general_primary_care fallback; "classification for styling only").

**Problem (evidence):** *Patient5* was classified `gynecology`, after which downstream extraction dropped/misplaced the ADD-medication-start facts. Multiple runs show `medication_refill_administrative` causing aggressive compression that drops pharmacies and titration.

**What to build:**
1. **Classification is styling, not a filter.** Downstream extractors must capture *all* clinical facts regardless of the primary label. Remove any code path that prunes entity types based on the classifier output.
2. **Multi-label + safe fallback.** Allow a primary + secondary encounter type; if an encounter spans distinct domains (e.g., gynecology + mental-health), emit `general_primary_care` (flexible template) rather than a narrow single-specialty schema.
3. **Fail-safe upgrade.** If an "administrative" encounter contains a dose change or specific pharmacy routing, auto-promote `medication_refill_administrative → medication_refill` so full-fidelity extraction runs.

**Where:** `EncounterClassifierAgent.js` (multi-label + fallback), plus wherever the classification is consumed to select templates/slots (audit for filtering behavior).

**Done when:** Patient5 retains ADD facts under a general/multi template; an administrative refill with a dose change is extracted at full fidelity.

---

### D · Medication Value Sanitizer + RxNorm Verification — **P1**
**Folds in 6 suggestions** ("30 Brian" value validators × several, acoustic/medical spell-checker).

**Problem (evidence):** hallucinated value `"30 Brian"` (a name fused into a dose); `Lolo` birth control transcribed as `Lunesta` (a sedative).

**What to build (two tiers):**
1. **Cheap deterministic sanitizer (ship first):** regex/type validator on `ClinicalEntity.value` — a dosage value must be `number (+ unit)`; reject/strip trailing proper nouns and non-clinical tokens (`"30 Brian"` → `"30 mg"` or drop). Zero-dependency, catches the worst cases.
2. **RxNorm/RxClass verification (higher value):** normalize each extracted medication via RxNav `getDrugs` → RxCUI, then pull ATC/EPC therapeutic class via RxClass. Flag when the class contradicts context (sedative where the surrounding text is contraception). Deploy **RxNav-in-a-Box** locally to avoid sending PHI off-box and to keep latency bounded.

**Where:** `packages/backend/src/validation/guardrails.js` (Tier 1), a new `packages/backend/src/services/rxnorm.js` client + a reconciliation step (Tier 2).

**Done when:** `"30 Brian"` never reaches the note; a med whose therapeutic class contradicts context is flagged for review.

---

### E · qa-validator Output-Contract Fix — **P1**
**Folds in 4 suggestions** (schema mismatch across runs; benchmarking-vs-runtime contract drift; "unify output schema / distinct agent IDs").

**Problem (evidence):** across runs the qa-validator returns two different JSON shapes — sometimes the pipeline quality-gate `{status, missing_facts, addendum, action, retry_reason}`, sometimes the blind benchmarking evaluator (Heidi-vs-Notera, n=2000 rubric). The agent is being asked to do two jobs with conflicting output contracts.

**What to build:** split the two roles into **two distinct agent IDs / prompts** — `qa-validator` (pipeline quality gate, the `{status, action, …}` contract the runtime consumes) and `comparative-judge` (offline benchmarking). Pin each prompt to its exact runtime schema so there's no contract drift, and route them separately so the model never sees conflicting format instructions.

**Where:** prompt registry (`packages/backend/prompts/store/`), `ClinicalQAValidatorAgent.js`, and the comparator path in the admin handler (already separate — `COMPARATOR_SYS`).

**Done when:** the runtime qa-validator always returns the gate schema; benchmarking lives under its own id.

---

### F · Non-Patient Speaker (Caregiver) Filter — **P2**
**Folds in 2 suggestions** (Caregiver/Companion Speaker Segregation, Speaker Diarization Alignment Guardrail).

**Problem (evidence):** *Patient6* — caregiver "Mona" described *her own* symptoms; those facts contaminated patient "Alexi's" clinical graph.

**What to build:** a dialogue-preprocessing step that tags speaker role (patient / clinician / caregiver-companion). Facts from a companion's *self-referential* statements ("my arm hurts") are marked `non-patient context` and excluded from the patient's clinical graph; a caregiver's *reported history about the patient* stays, attributed as reported-by in Subjective. This is a known hard area (attribution accuracy varies), so ship it as a *flag-and-suppress* guardrail with the role signal from diarization, not a silent drop.

**Where:** a preprocessing stage before `ClinicalObservationExtractorAgent.js`; relies on speaker/role tags in the transcript (add if the ASR/diarization layer doesn't already emit them).

**Done when:** Patient6's caregiver-only symptoms don't appear as the patient's problems.

---

### G · Negative-Fact + Temporal-Consistency Validators — **P2**
**Folds in 3 suggestions** (Assertive Negative Fact Grounding; Enforce temporal sequence validation; future-investigation-as-normal-finding).

**Problem (evidence):** *Patient5* gold note records "BP and HR monitoring **not** discussed prior to starting ADD meds" (a clinically important *omission*), which Notera missed; and a *future* pelvic ultrasound was labelled "normal findings" (fabricating a result that doesn't exist yet).

**What to build (two discrete logical checks — the LLM-free fact-check pattern, F1 0.856):**
1. **Negative-fact capture:** when guidelines dictate a monitoring/counselling step, deterministically record "what was NOT done/discussed" as a negative finding.
2. **Temporal validator:** an investigation whose date is in the future (or "in 2 weeks", "August 2025" when the encounter predates it) may **not** carry a status of `normal/abnormal/completed` — force `planned/pending`.

**Where:** `packages/backend/src/validation/guardrails.js` (both checks operate on the structured note + fact graph).

**Done when:** future imaging is never "normal"; a mandated-but-absent monitoring discussion is captured as a negative finding.

---

## 4. Meta-finding — the "prompt truncation" suggestions are (mostly) a mirage
**Two suggestions** ("Fix Prompt Truncation in QA-Validator", "…truncate characters past ~4000-5000 chars", citing `"…assigns a medication to the wron…[+4328 chars]"`).

The `[+4328 chars]` marker is almost certainly **the System Upgrader's own context-trimming** — `buildUpgradeContext` shortens the *current prompt* when it feeds it to the optimizer. The optimizer then "sees" a cut-off prompt and confidently reports a truncation bug that **does not exist in the live pipeline**. Action: in the upgrader, either send the full current prompt or label the trimmed copy explicitly as "excerpt for context — not the runtime value," so the optimizer stops inventing truncation fixes. (Fast, XS.) Do verify once that the runtime `qa-validator` prompt is actually delivered whole — but don't build a "truncation guard" on the strength of this alone.

---

## 5. Suggested sequencing

1. **Now (P0):** B (empty-transcript fast-path — small, kills the scariest hallucination) → A (medication extractor + section router — the biggest, highest-impact block).
2. **This cycle (P1):** D-Tier1 (value sanitizer, trivial) → E (qa-validator contract split) → C (decouple classification) → D-Tier2 (RxNorm/RxNav-in-a-Box).
3. **Backlog (P2):** G (negative-fact + temporal validators) → F (caregiver filter, gated on diarization signal).
4. **Housekeeping (XS):** fix the upgrader context-trimming so it stops generating phantom "truncation" suggestions.

Build order rationale: A, D, and G are all the *same architectural pattern* (deterministic post-extraction validators over the fact graph), so land A's validator scaffold first and D/G reuse it.

---

## 6. Coverage — all 47 mapped

| Initiative | Runs / upgrades the suggestions came from | Count |
|---|---|---|
| A — Med extractor + section router | #1–#8 (pharmacy), #10–#12, #14, #15 (section placement) | 25 |
| B — Empty-transcript fast-path | #16 (Empty/Silent, Blank Encounter) | 3 |
| C — Decouple classification | #4–#8, #10, #12, #14, #15 (classification-gating) | 10 |
| D — Value sanitizer + RxNorm | #10, #13, #14 (value), #16 (spell-checker) | 6 |
| E — qa-validator contract | #8 (schema discrepancy), #16 (unify schema) | 4 |
| F — Caregiver filter | #16 (2× diarization) | 2 |
| G — Negative-fact + temporal | #11 (negative fact), #15 (temporal) | 3 |
| Meta — truncation mirage | #13, #14 (prompt truncation) | 2 |

_(Some suggestions touch two initiatives — e.g. the Patient5 "gynecology dropped ADD" items inform both A and C — so the column counts overlap slightly; every one of the 47 lines is represented.)_

---

## Sources
- n2c2 2022 Contextualized Medication Event extraction — https://www.sciencedirect.com/science/article/pii/S1532046423001533
- Deep-learning medication disposition + attribute extraction (PMC) — https://pmc.ncbi.nlm.nih.gov/articles/PMC10527481/
- RxNorm / RxNav APIs (NLM) — https://lhncbc.nlm.nih.gov/RxNav/APIs/index.html
- RxNorm getDrugs — https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getDrugs.html
- RxNorm drug-name normalization case study (PMC) — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10796552/
- Clinical safety & hallucination-rate framework for LLM summarisation (npj Digital Medicine) — https://www.nature.com/articles/s41746-025-01670-7
- Redefining hallucination for SOAP-note evaluation (arXiv) — https://arxiv.org/pdf/2604.14829
- Ambient AI scribe / diarization evaluation guide (AssemblyAI) — https://www.assemblyai.com/ambient-ai-scribes-guide
- Scaling ambient AI scribes across settings (npj Digital Medicine) — https://www.nature.com/articles/s41746-026-02554-0
