# Agent loop run: audit → diagnosis → prompt upgrade → validation (2026-10-20)

## What was built into the admin panel
| Step | Where | New |
|---|---|---|
| Audit every note against the transcript and the gold note | Review notes / Diagnose | The auditor's **rubric is now visible and editable** (Diagnose → "Audit rubric") and **already contains the clinic's note template**, so a note is not marked wrong for following it |
| One report from all audits + logs | Diagnose | The report now also judges **template conformance** (invented diagnoses, forbidden medication/follow-up lists, completed vs planned investigations) |
| Prompt upgrade | Diagnose → **Create prompt upgrade from this report** | A new agent reads the current prompt, the template, the whole diagnosis, the 24 weakest audits, the pipeline logs of the 8 weakest notes and the similarity/omission numbers, and returns an upgraded prompt **plus suggestions beyond the prompt** (guardrails, pipeline, data). It lands in Improve as a candidate with the same validation and gate |
| Score as the doctor sees it | Trends | **Similarity (as shown)**: word overlap computed on the note with its section labels, like the gold notes |

## Findings that explain "the output got worse"
1. **Gold notes label their plan lines "Treatment planned / Investigations planned / Diagnosis / Referrals"** (2,700 of 2,790 notes). The renderer wrote "Treatment / Investigations" and dropped the Diagnosis line when it matched the title, so every note lost 4–5 matching words. Fixed (renderer now uses the gold labels): **similarity as shown 0.345 → 0.395**.
2. Gold notes have **no "Current medications" list (5 %), "Preventive care", or separate "Follow-up" problem (13 %)**; our writer added them to most notes. Removing the medication list from the automatic checklist merge is live; the new prompt tells the writer not to create them.
3. **Template check:** the app's live Scribe already defaults to **Auto-detect**; no real transcript is treated as a blank encounter (0 of 2,727 gold transcripts), and a specific specialty only changes the label, never the note. A leftover screen that defaulted to the first specialty (`NewConsult`) was unused and has been deleted.

## Experiments (3.7-flash writer, same method every time)
| Run | Notes | Parity | 90+ | Strict gold audit | Transcript audit | Critical claims/note | Sim shown |
|---|---|---|---|---|---|---|---|
| Template-literal prompt (follow the pasted template word for word) | 60 | **73.8** | 9/58 | 53.1 | 56.0 | 0.26 | 0.359 |
| Previous production prompt | 60 | 81.0 / 83.8 | 21 / 16 | 56.6 / 58.3 | 59.1 / 59.4 | 0.38 / 0.49 | 0.396 / 0.393 |
| **Report-based upgrade (dev set)** | 60 | 81.7 | 19 | 59.0 | 62.8 | 0.31 | 0.396 |
| Previous production prompt — **hold-out** | 100 | 83.0 | 45 | 61.0 | 63.2 | 0.31 | 0.394 |
| **Report-based upgrade — hold-out** | 100 | **85.2** | 41 | **63.2** | **64.6** | **0.25** | 0.396 |

* Following the template **literally** ("leave blank unless explicit") **hurt**: completeness fell 3.8 → 3.2 and parity 81 → 74. The gold notes are richer than the template text suggests. That prompt was reverted within the hour; production was never left on it for longer than the test.
* The prompt built from the **diagnosis report** removed the forbidden lists and invented-diagnosis pattern without losing completeness. On notes it had never seen: parity +2.2, strict gold audit +2.2, critical claims −19 %. The number of notes at 90+ is 4 lower, and the gains are within the ±2 noise band, so it is a small, consistent improvement, not a breakthrough. **It is now the default writer prompt** (`packages/backend/prompts/writer-v3.txt`, editable in Prompts).

## Similarity and the 90 target
Similarity (as shown) is now ≈0.40, up from 0.345 because of the label fix. It will not approach 0.9: it is a word-overlap score between two *different* authors' notes, so a perfect paraphrase scores about 0.4. The strict gold-referenced audit sits at ≈63 and the clinicians' own notes score 73 against the transcript. Parity (the old "90+" comparator) is 85, with 41–45 of every 100 notes at 90+.

## Suggestions the agent raised that need your decision
1. A deterministic post-writer guardrail that deletes any "Follow-up" problem block and any "Current medications" line (belt and braces for rule 2 above).
2. A verifier rule for section misplacement (reported symptoms in Objective).
3. A drug plausibility check against a drug dictionary and the stated indication.
4. Input validation: reject schedules or lists passed as transcripts (found in the gold data).
