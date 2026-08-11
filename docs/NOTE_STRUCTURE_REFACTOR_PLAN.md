# SOAP Note Structure Refactor — Plan (codebase‑referenced)

**Goal (your two asks):**
1. **Objective** — dissolve the "Key Findings" sub‑section; make the whole **Objective concise and small**.
2. **Subjective** — **merge "Presenting Complaints" + "History of Presenting Complaint"** into one section, and de‑duplicate against **"Associated Symptoms"**. Motive: **no duplicates**, a **detailed story at the top**, and **summarized/condensed points at the bottom**.

This is a plan only — no code changed yet. Every step cites the exact file/function/line so we implement against reality.

---

## 0. First, one thing to confirm (the only ambiguity)

`"Key Findings"` is **not a literal label anywhere** in the code, the gold notes (`data/gold/*.txt`), the eval results, or the prompt store — I grepped all of them. So it's the name you're giving to a block you *see* rendered. Based on the renderers, it almost certainly means the **"Exam Findings"** sub‑block of Objective (and/or the fact that Objective currently splits into several sub‑headers and reads long).

**My working interpretation** (used throughout this plan): "dissolve Key Findings" = **collapse the Objective sub‑headers ("Vital Signs / Investigations / Exam Findings") so exam findings are no longer a separate verbose block, and render Objective as one short, tight section.** If you actually meant a different block, tell me and I'll re‑point steps in §3.

---

## 1. Where the note structure actually lives (three renderers + schema)

The note is defined by the **schema** and drawn by **three different renderers**. Knowing which one you're looking at matters, because a change in the wrong file won't show up.

| # | File / function | What it renders | Is it what you screenshotted? |
|---|---|---|---|
| Schema | `schema/index.js` → `emptyNote()` (obj at L66‑69) | Field shape: `subjective{reason_for_visit, hpi_details, aggravating_relieving_factors, symptom_progression, previous_episodes, functional_impact, associated_symptoms}`, `objective{vital_signs, examination, completed_investigations}` | Data model only |
| R1 | `eval/run_eval.mjs` → `renderSchemaMarkdown()` (L82‑92) | **"Presenting Complaints" / "History of Presenting Complaint" / "Associated Symptoms"**, Objective = **"Vital Signs" / "Investigations" / "Exam Findings"** | **✅ YES — the "Notera — generated" pane in Results is this** |
| R2 | `packages/backend/src/orchestrator/renderMarkdown.js` → `noteToMarkdown()` | Flat "Subjective" (already merged, one block) + "Objective" (vitals+exam+investigations) + numbered A&P | The hidden "RAW PIPELINE RENDER" section + product `renderedNote` |
| R3 | `packages/backend/src/pipeline/agents/TemplateAssemblyAgent.js` (subj L1259‑1296, obj L1052‑1062) | Many sub‑headers (Reason for visit, HPI, Symptom characteristics… Associated symptoms) + Objective (Vital Signs / Blood Work / Imaging / Exam Findings) | Legacy/product pipeline path |

**Deduplication already exists** in `packages/backend/src/orchestrator/condenseNote.js`:
- `dedupWithinSection()` (L40‑58) removes near‑duplicate sentences *within* a section.
- Step 2 (L96‑110) drops A&P sentences that repeat Subjective/Objective.
- Step 3 (L112‑123) dedups **examination vs completed_investigations** in Objective.

And the **LLM tightener** (`tightenNote.js`, SYS prompt L31‑48) already has rules for grounding/conciseness/no‑repetition.

**Design decision for this refactor:** make **R2 `noteToMarkdown` the single source of truth** for structure, and have **R1 `renderSchemaMarkdown` call it** (or mirror it), so we stop maintaining two divergent layouts. This is a prerequisite that makes both asks a one‑place change instead of three.

---

## 2. Subjective — merge Presenting Complaint + History, dedup vs Associated Symptoms

**Current (R1, `renderSchemaMarkdown` L87‑90):** three separate bold blocks — `Presenting Complaints` (`reason_for_visit`), `History of Presenting Complaint` (`hpi_details` + modifiers + progression + previous + functional), `Associated Symptoms` (`associated_symptoms`). This causes the duplication you see (the reason for visit is restated inside the HPI, and symptoms appear in both HPI and Associated Symptoms).

**Target layout:**
```
Subjective:
  History of Presenting Complaint            ← ONE merged narrative
  - <detailed story, chronological, top>      ← reason_for_visit folded into the story
  - <continues…>
  Summary                                     ← condensed bullet points, bottom
  - <key point 1>
  - <key point 2>
  Associated Symptoms                         ← de‑duplicated vs the story above
  - <only symptoms NOT already stated>
```

**Changes:**

1. **Merge the two headers into one narrative block.** In R1 (and R2), stop emitting a standalone `Presenting Complaints` header; fold `reason_for_visit` into the front of the combined `hpi_details` story. Files: `eval/run_eval.mjs` L87‑89 and `renderMarkdown.js` `noteToMarkdown()` subjective section (L33‑38). Keep one header — e.g. `History of Presenting Complaint` — with the story as detailed bullets.

2. **"Detailed top, condensed bottom."** Render the full narrative first (`hpi_details`, `symptom_progression`, `previous_episodes`, `functional_impact`), then a short **`Summary`** of 2–4 crisp bullets. Two options:
   - **Deterministic (recommended for the plan's first pass):** a `summarizeSubjective(subjective)` helper that extracts the top‑N shortest declarative sentences / the reason_for_visit + progression endpoints → the bottom summary. Lives in `condenseNote.js` (new export) so it's testable.
   - **LLM‑assisted (higher quality):** extend `tightenNote.js` SYS prompt so the model returns a dedicated `summary` line inside `hpi_details` (append a rule 8: "End HPI with a one‑to‑three bullet 'Summary:' of the key timeline"). Requires a small schema/allowance and a parse tweak.

3. **De‑duplicate Associated Symptoms against the merged story.** Extend `condenseNote.js`:
   - Today `dedupWithinSection()` dedups *within* a section object across its fields — which already covers the merged Subjective if `reason_for_visit` + `hpi_details` + `associated_symptoms` are all fields of `note.subjective` (they are). **Action:** confirm `associated_symptoms` is included in the same `dedupWithinSection(note.subjective, …)` pass (it is, L68) and **lower the miss risk** by adding a targeted rule: any `associated_symptoms` sentence whose word‑set is contained (≥0.8) in an `hpi_details` sentence is dropped from `associated_symptoms`. This is the "no duplicates" guarantee.
   - Keep genuine **negatives** ("No fever, no chest pain") in Associated Symptoms even if the topic appears above, since pertinent negatives are clinically required — add a guard so `no /denies /negative` sentences are never dropped.

**Files touched:** `eval/run_eval.mjs` (R1 render), `renderMarkdown.js` (R2 render), `condenseNote.js` (merge‑aware dedup + optional summary), optionally `tightenNote.js` (LLM summary). **No schema change required** — we reuse existing fields; the merge is a *render + condense* change.

---

## 3. Objective — dissolve "Key Findings", make it concise

**Current:**
- R1 (`renderSchemaMarkdown` L77‑79): Objective = `Vital Signs`, `Investigations`, `Exam Findings` (three bold blocks).
- R2 (`noteToMarkdown` L46‑49): Objective = vitals + examination + completed_investigations bullets.
- R3 (`TemplateAssemblyAgent` L1059‑1062): `Vital Signs`, `Blood Work`, `Imaging`, `Exam Findings`.

**Target:** one short Objective. Vitals stay (they're compact and important). The "Exam Findings"/"Key Findings" block is **dissolved** — merged into a single concise line list, with the exam‑vs‑investigations dedup already provided by `condenseNote` step 3 (L112‑123) doing the heavy lifting.

**Changes:**

1. **Collapse Objective sub‑headers in R1.** In `eval/run_eval.mjs`, replace the three `blk('Vital Signs' | 'Investigations' | 'Exam Findings', …)` calls (L77‑79) with a single tight Objective block: vitals first (kept), then a short merged findings list (examination + completed_investigations already de‑duped). Drop the separate "Exam Findings" header so exam findings are *dissolved* into the objective rather than a standalone verbose section.

2. **Cap Objective length.** Add an `objective` conciseness pass in `condenseNote.js`: keep vitals verbatim; limit merged exam/investigation bullets (e.g. drop normal/duplicate exam lines already implied, keep abnormal + explicitly‑relevant normals). Deterministic and grounded — only removes, never invents (consistent with the existing guardrail philosophy).

3. **Mirror in R2** `noteToMarkdown` so the product render matches.

4. **Tightener prompt** (`tightenNote.js` SYS): add a rule — "Objective is terse: vitals, then only clinically relevant exam/lab findings as short points; do not create a separate 'key findings' subsection." (This stops the LLM re‑introducing the block we dissolved.)

**Files touched:** `eval/run_eval.mjs`, `renderMarkdown.js`, `condenseNote.js`, `tightenNote.js`.

---

## 4. Concrete step list (implementation order)

1. **Unify renderers.** Make `renderSchemaMarkdown` (R1) delegate to `noteToMarkdown` (R2) — or align them field‑for‑field — so structure lives in one file. *(Prereq; ~1 file.)*
2. **Subjective merge** in the unified renderer: one `History of Presenting Complaint` narrative (reason_for_visit folded in) → then a `Summary` of condensed bullets. *(renderMarkdown.js)*
3. **Objective collapse** in the unified renderer: vitals + one dissolved findings list, no standalone "Exam/Key Findings" header. *(renderMarkdown.js)*
4. **condenseNote.js** upgrades: (a) merge‑aware Associated‑Symptoms dedup with a pertinent‑negative guard; (b) an Objective conciseness pass; (c) optional `summarizeSubjective` for the bottom summary.
5. **tightenNote.js** SYS prompt: rules for the merged Subjective story+summary and the terse Objective (no key‑findings subsection).
6. **Tests:** extend `condenseNote.test.mjs` (currently 11 passing) with: "associated symptom duplicated in HPI is dropped", "pertinent negative kept", "objective has no separate Exam/Key Findings header", "subjective ends with a condensed Summary". Extend `tightenNote.test.mjs` if the LLM summary path is used.
7. **Verify:** run the three test suites, then a live re‑run on `weakness-shakiness` + 2 others and eyeball the Results pane against gold.

---

## 5. What does NOT change

- **Schema fields** (`schema/index.js`) — we reuse `reason_for_visit`, `hpi_details`, `associated_symptoms`, `examination`, `completed_investigations`. No migration.
- **Assessment & Plan** rendering (numbered problems + sub‑bullets) — untouched.
- **Guardrail philosophy** — every condense step only *removes/relabels*, never invents (keeps the anti‑hallucination guarantees intact).
- **Bullet rendering** — the green‑dot bullets we just fixed stay; the merge just changes which headers exist, not the bullet mechanics.

---

## 6. Risks / watch‑items

- **Pertinent negatives**: merging + dedup must not delete "No fever / denies chest pain" — explicit guard added in §2.3.
- **Two renderers drifting**: if we don't unify (step 1), a change in R2 won't show in the Results pane (R1). Unify first.
- **"Key Findings" interpretation**: if it's *not* Exam Findings (e.g. a label your LLM emits inside `completed_investigations`, or a gold‑note convention), §3 re‑points to that block instead — quick change once confirmed.
- **Summary quality**: the deterministic bottom‑summary is safe but blunt; the LLM summary reads better but needs the tightener on. Recommend shipping deterministic first, then switching to LLM summary behind `NOTE_TIGHTENER=1`.

---

## 7. File‑by‑file change map (quick reference)

| File | Change |
|---|---|
| `packages/backend/src/orchestrator/renderMarkdown.js` | Merge Subjective headers → one narrative + Summary; collapse Objective (dissolve Exam/Key Findings) |
| `eval/run_eval.mjs` (`renderSchemaMarkdown`) | Delegate to / mirror `noteToMarkdown` so Results pane matches |
| `packages/backend/src/orchestrator/condenseNote.js` | Merge‑aware Associated‑Symptoms dedup (+ negative guard); Objective conciseness pass; optional `summarizeSubjective` |
| `packages/backend/src/orchestrator/tightenNote.js` | SYS rules: merged Subjective story+summary; terse Objective, no key‑findings subsection |
| `packages/backend/src/orchestrator/condenseNote.test.mjs` | New tests (dedup, negative‑kept, no Exam header, Summary present) |
| `packages/backend/src/pipeline/agents/TemplateAssemblyAgent.js` | (Optional) align legacy product render if that path is still used |

*Nothing here is implemented yet — this is the plan. Confirm the "Key Findings" interpretation (§0/§3) and I'll implement in the order in §4.*
