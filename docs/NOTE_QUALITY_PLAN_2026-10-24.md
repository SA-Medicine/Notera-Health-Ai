# Note quality plan: from a review of the real doctor's notes (2026-10-24)

Owner request (2026-10-24, "unlock the style spec"): the Super run still scored "needs work". Missing data, misplaced data, Objective unformatted, A&P without drug names or sub-points, short transcripts weak. Review Seema's real consults, audit all of them, fix the pipeline for the real world, and do it from a plan, not on the go.

## 1. Evidence

Source: the clinician account `seema.aggarwal@…` (the real doctor): 77 consults, 76 with a transcript, 8 under 200 words, median 771 words, longest 3 533. Only one has a saved edit and none is signed, so there is no human gold; the auditor (Gemini 2.5 Pro, the same one the Super run uses) is the yardstick, with its known variance (one run of the same note scored 85, another 65).

Baseline of the notes as stored (produced by the pipeline versions of the day, 77 audited):

| Measure | Value |
|---|---|
| Mean audit score | 57.9 (10 unsafe, 45 needs work, 21 good, 1 excellent) |
| Wrong / missing / extra / plan gaps per note | 3.6 / 4.0 / 2.1 / 4.6 |
| Presentation: flow / readability / organisation | 44.5 / 41 / 37 |
| Most common plan gap kinds | misplaced fact 86, missing problem 82, missing line 77, repeated label 55, merged problems 26, echo 16 |
| Wrong lines that are "misplaced" | 107 of 278 |
| Missing facts that are critical / important | 77 / 142 of 308 |
| Missing facts about medicines and doses / follow-up and advice / tests and results / exam and vitals | 69 / 61 / 65 / 31 |
| Notes with no Objective section | 12 of 77; 10 more have a single line |

Short transcripts (<200 words) score best (65.6) but are the ones where a blank or one-line section looks like a bug. Long ones (1 200+) lose most (53.5, 5 missing, 4.2 wrong per note).

The same measures are produced for the current pipeline by `packages/backend/tools/note-eval.mjs` (re-writes every consult without saving, measures with code, audits, and attributes missing facts to the guard that removed them). Baseline of the pipeline as deployed before this plan: see section 6.

## 2. Findings, by what the owner reported

1. **Data is missing.** (a) The pipeline removes lines on purpose: fuzzy "already stated" de-duplication (a real line about Tylenol every 4 hours was dropped as "already stated as Medication review"), the condenser dropping plan lines as "subjective-narrative bleed" (the knee brace and compression stocking prescriptions), plan tidy, covered-fragment removal, the verifier. (b) The writer leaves facts out and nothing checks the finished note against the transcript for omissions except the coverage check added in 2.1.2.
2. **Misplaced data.** A vital sign written as a treatment; a vaccine given in the visit written as an exam finding; the history repeated under Referrals; a result under the wrong section; follow-up written as treatment.
3. **Objective.** One undifferentiated list, no vital-sign / examination / result structure, no rule for exam findings, disappears when empty.
4. **A&P.** Drug names missing from the plan lines; "Treatment planned" a long run-on line; no distinction between what was started, stopped, changed, given today and what to carry on with; weak wording.
5. **Short transcripts.** Sections vanish or look empty.

## 3. Rules that limit data, and what is done with them ("free flow for now")

| Rule | Effect | Decision |
|---|---|---|
| Fuzzy "already stated" de-duplication of Subjective and Assessment lines (`dedupeNote.js`) | removes real lines | exact duplicates only |
| Condenser "narrative bleed" and "redundant A&P sentence" (`condenseNote.js`) | removes plan lines | off while free flow is on |
| Plan tidy "repeated / empty items" (`postGuards.js`) | removes items | exact duplicates and empty items only |
| Covered-fragment removal after the story agent | removes fragments | off while free flow is on |
| Verifier "unsupported" removals | removes lines | flag instead of remove; exact duplicates still removed |
| Grounding agent removals | removes lines | flag instead of remove |
| Diagnosis only if the clinician said it; unheard drug names replaced by class; social history only if said; third-party text | safety rules | kept: these prevent invention, they do not lose stated facts |

The exact list is filled from the measured attribution (section 6) and each relaxed rule has one switch (`FREE_FLOW=0` restores the previous behaviour in one step).

## 4. Changes

| # | Change | Where |
|---|---|---|
| 1 | Objective in three labelled groups (Vital Signs, Examination, Investigations); "Deferred" when nothing was measured, examined or reviewed | `renderMarkdown.js`, writer prompt |
| 2 | Writer prompt: Objective rules (units, one line per system with its finding, no step without a finding, vaccines given are treatment), plan items that start with the action and name the drug with dose and frequency, "when unsure include it", short visits keep every section with content | `prompts/writer-v5.txt` |
| 3 | Treatment planned as sub-points: Started, Changed, Stopped, Continued, Given today, Other; one item each, the drug named | `treatmentStructure.js`, web renderer, Super run |
| 4 | Placement rules: vital signs out of the plan into Objective, a vaccine given in the visit out of Objective into the plan, history text out of Referrals | `placementRules.js` |
| 5 | Coverage check also receives the checklist's medicines and must name each started, changed, stopped or continued medicine in the plan; and add missing Objective facts | `noteCoverage.js` |
| 6 | Free flow: data-removing rules relaxed per section 3 | per rule, switch `FREE_FLOW` |
| 7 | Evaluation harness and this document | `tools/note-eval.mjs` |

Out of scope for now: signing/export formats, Studio rule checks (they still check the earlier format and will flag the new Objective groups), speech models.

## 5. Acceptance (measured on the same 77 consults, same auditor)

| Measure | Target |
|---|---|
| Audit score | clearly above the section 6 baseline; no note scored unsafe because of a placement error |
| Missing per note | below the baseline; missing facts that a guard removed: 0 |
| Misplaced plan gaps | below the baseline |
| Notes with an Objective section | 100% of notes that have any content ("Deferred" when empty) |
| Plan drugs named | every medicine the checklist marks new, changed or stopped appears by name in the plan |
| Problems with no lines | 0 |
| Note time | mean under 45 s |

The auditor varies from run to run; differences of a few points are noise. The comparison is on 77 notes with the same auditor on both sides.

## 6. Results

Filled in after the run (see the end of this file).

### Results (2026-10-23 evening, same auditor, today's 8 consults of the clinician account)

A/B with 2 repeats per consult, stored transcripts, the earlier pipeline (2.1.2: old writer prompt, old Objective layout, no placement rules, no treatment sub-points) against v2.2.0:

| Measure | Earlier (n=15) | v2.2.0 (n=16) |
|---|---|---|
| Audit score (mean; median) | 62.0; 65 | 64.1; 65 |
| Wrong lines per note | 5.67 | 4.94 |
| "Misplaced" wrong lines | 21 of 85 | 14 of 79 |
| Repeated-label plan gaps | 25 | 12 |
| Missing facts per note | 4.73 | 5.19 |
| Missing: critical | 9 | 14 |
| Plan gaps: missing line / missing problem / merged problems | 9 / 19 / 9 | 20 / 22 / 13 |
| Presentation flow / readability / organisation | 51 / 44 / 38 | 54 / 48 / 40 |
| Treatment sub-points per note | 4.8 | 5.7 |
| Note time (mean) | 58 s | 53 s |

Read: structure and placement are better (fewer wrong and misplaced lines, half the repeated labels, presentation up), score is level within the auditor's noise (it scored the same note between 45 and 85), and completeness is NOT better (missing facts and missing plan lines are slightly higher). A first run of v2.2.0 with the "free flow" rules relaxed scored worse (66.9 vs 72.5 for the notes as saved; junk "Referrals: <problem>" lines and fragment spam), so free flow is OFF by default (`FREE_FLOW=1` turns it on); only 5 of 34 audit-missing facts could be traced to a guard removal, so the guards are not the main cause of missing facts. The plan-drug check fell from 100% to 89%: the one miss was an ASR error ("a cand" for a drug name) that the unheard-drug guard correctly replaced by its class ("ARB").

Open: completeness (missing facts) needs a different approach than rules: better ASR vocabulary for drug names, and a larger sample (77 consults) once signed notes exist.

### Fact graph and ledger (v2.3.0, same 8 consults, 2 repeats, same auditor)

The owner's v1 fact-graph extractor and recovery agent now run beside the writer; a ledger checks every required fact against the finished note and places what is missing (model first, rule second). Rows are runs of 15-16 notes; the auditor varies by several points from run to run, so read the columns as trends.

| Measure | Earlier 2.1.2 | v2.2.0 | v2.3.0 final |
|---|---|---|---|
| Audit score (mean) | 62.0 | 64.1 | 67.5 |
| Missing facts per note | 4.73 | 5.19 | 4.19 |
| Missing rated important | 38 | 46 | 32 |
| Missing rated critical | 9 | 14 | 8 |
| Wrong lines per note | 5.67 | 4.94 | 5.06 |
| Merged-problem gaps | 9 | 13 | 4 |
| Presentation (flow / readability / organisation) | 51 / 44 / 38 | 54 / 48 / 40 | 55 / 47 / 46 |
| Note time (mean) | 58 s | 53 s | 36 s |

Across all fact-graph runs (five configurations, 80 notes) critical misses averaged 0.41 per note against 0.88 for v2.2.0. What the audit still calls missing is mostly detail on a fact the graph holds ("for life", a dose change, "four weeks, not two"): the ledger checks facts, not every attribute of a fact. Of 42 lines the ledger added, about 16 were flagged wrong by the auditor; the worst, a vaccine the patient declined written as "administered", is fixed (a vaccine is written as given only when the words say so).
Known remaining: a fact written twice in other words (for example a drug line and a "continued" line), a lab result under Treatment, third-party history, and wrong doses that come from a misheard drug name (the speech models).
