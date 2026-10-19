# Story agent and report guardrails (2026-10-20)

## Why
Doctors read the Subjective as a list of clipped fragments ("Pain / left knee / 3 weeks"). The old multi-agent pipeline had a story composer; v2 dropped it. The note was complete on paper but did not read as a history.

## What was built
| Piece | Where | Behaviour |
|---|---|---|
| **Story agent** (independent stage) | `generateNoteV2.js` `storyPass`, prompt `v2-story` (Prompts), keys `story.*` (Settings) | Runs **last**, after the verifier, guardrails, condense and dedupe, so it only rewords a note that is already checked. Rewrites **Subjective only** as a physician-style history: one sentence for why the patient came, one to three short paragraphs (onset, course, what helps, what was tried, impact), one sentence of associated symptoms and denials. Model `gemini-2.5-flash` (about 2 s per note). |
| **Fact check in code** | `editorAccepts(..., { noPlan })` | A rewrite is **rejected and the original kept** if it changes or adds a number or dose, keeps under 72 % of the draft's content words, adds more than 8 new content words, or says "unspecified / not mentioned". Number words equal digits ("three" = 3). On 100 unseen notes 78 rewrites were accepted. |
| **Paragraph rendering** | `renderMarkdown.js` | A story Subjective renders as paragraphs, not one bullet per sentence. Without the story agent the note renders as before. |
| **Template guard** | `postGuards.js` `enforceTemplate` | Removes a "Current medications:" line and folds a separate "Follow-up" problem into the last real problem's plan (the clinic template has neither). |
| **Placement guard** | `fixMisplacement` | Patient-reported statements ("reports…", "denies…") under Objective move to Subjective; exam findings and vitals never move. |
| **Drug plausibility flag** | `drugPlausibility` | Flags (never edits) a common drug planned when nothing in the transcript hints what it is for. |
| **Input check** | `checkInput` (`guards.inputCheck` = off / flag / reject) | Flags schedules, lists and very short text; default flag. |
| Lab | Run & inputs → "pipeline stages for this run" | Story agent, story model and guards can be switched per run; the blind judge now also scores **readability**. |

Rejected design: an earlier story prompt that only tidied fragments made no difference to the audits, and a version that also rewrote Past Medical History joined unrelated facts ("hypertension, treated with prednisone"), so the agent is limited to Subjective.

## Evidence (production writer gemini-3.7-flash, same 100 unseen notes)
| Run | Parity | Transcript audit | Strict gold audit | Critical wrong claims / note | Flow | p50 |
|---|---|---|---|---|---|---|
| Story off | 80.7 | 64.0 | 62.8 | 0.29 | 0.864 | 16.7 s |
| Story on | 81.9 | 67.7 | 60.4 | 0.37 | 0.906 | 18.0 s |
| **Story + template + placement guards** | **83.4** | **67.6** | 61.8 | **0.28** | 0.914 | 17.9 s |

Also, an earlier story variant on the same 100 notes: parity 84.3, audit 66.6, critical 0.26. On the dev set (60 notes) the story agent on 3.7-flash gave transcript audit 64.5 vs 58.8, but cost about 22 s per note, so the story model is `gemini-2.5-flash`.

Reading of the numbers: the noise floor on a 50–100-note mean is about ±2 points and ±0.08 on critical claims. Story alone does **not** raise wrong claims beyond that noise; the strict gold audit (which compares against a different author's note) moved by −1 to −2, within noise. The readable-story gain is large on flow (0.86 → 0.91–0.93) and consistent on the transcript audit (+3.6). The guards recover the small critical-claims drift. Similarity as shown stays 0.39 (word overlap cannot reward better prose).

## Defaults now live
Story agent on · template guard on · placement guard on · drug plausibility flag on · input check = flag. Each can be switched off in **Settings → Story agent / Safety guards** (takes effect within 30 s), and the story prompt is editable in **Prompts → Story agent**.

## Honest limits
* About 1 note in 5 keeps the original bullet Subjective because the fact check refuses the rewrite (a changed number, or too many dropped words). That is the safe direction.
* The writer's own draft is the input, so a thin or de-identified draft ("the specialist", `[date]`) gives a thin story. The agent keeps placeholders as written.
* The pronoun is "the patient" unless the transcript makes the sex explicit.
