# Gold format analysis, newer-notes run, and the new audit/report prompts (2026-10-22)

Style Spec v1 stays locked. Nothing here changes how production writes a note: the work is in the Lab (audit, diagnosis report), in a new read-only metrics module, and in proposals. `node scripts/spec-lock.mjs` still says "unchanged".

## 1. How the format was learned (the "reverse engineer" idea)
Two public projects were studied. **RPE – Reverse Prompt Engineering** (EMNLP 2025, `hanklee97121/RPE_Reverse_Prompt_Engineering`) recovers the hidden prompt behind a model from a handful of its outputs: propose rules from the outputs, regenerate, score how close the regenerated outputs are, keep the rules that score best. **GitReverse** (`filiksyos/gitreverse`) turns an existing artefact into one synthetic prompt that would reproduce it. Same logic used here, for *layout only*:

| Step | What was done |
|---|---|
| Induce | Measured 410 topic-headed gold notes (the newest style): headings, bullets per topic, A&P problems, labels, advice/follow-up lines (`goldFormat.mjs`, in the session scratchpad; results below) |
| Write the rules | Seven format principles F1–F7 (now in the audit and report prompts) |
| Validate | Generated 30 held-out gold transcripts with the unchanged pipeline, scored the layout of each note against its gold note with code (`packages/backend/lab/formatMetrics.js`), then had the auditor judge them |
| Self-test | The gold note scored against itself gives zero flags (unit test) |

The "reverse engineer" repo was not named in the request; RPE is the closest match. If another one was meant, say so.

## 2. What the best (newest-style) gold notes look like — 410 notes
* Subjective: 4.1 topic headings, 4.2 bullets per topic. First topic is "Presenting Complaint(s)" in 64 % of notes; then "Associated Symptoms" (18 %), "Medications", "Social History", "Weight Management", "Menstrual History", "Self-Treatment" (5–6 % each).
* A&P: **4.05 numbered problems per note**, 2.4 bullets per problem; 99 % of problems have bullets. Labels used: Treatment planned 66 % of notes, Diagnosis 59 %, Investigations planned 50 %, Referrals 41 %. The rest of each problem is free short lines: "Continue …" (257), "Rtc …" (106), "Prescription faxed …" (84), "Advised …" (62), "Follow-up …" (42), "Referral to …" (35).
* 54 % of notes have at least one advice / counselling / follow-up / monitor line; 22 % have a preventive-care or screening problem; 11 % have a refill problem.
* Aggravating / relieving factors: a topic heading in only ~8 % of notes, but when the doctor advised avoiding triggers it is an advice line in the plan ("Counselled on aggravating factors: …"). This is the case you described.

## 3. The newer-notes run (30 held-out transcripts, unchanged locked pipeline, gemini-3.7-flash)
Run `run_mvigy0wtb2b3ed`, all 30 completed, 0 failures, median 16 s. Mean per note, ours vs gold:

| Measure | Ours | Gold |
|---|---|---|
| A&P problems | **2.9** | **3.87** |
| Gold problems with a matching problem in our note | 59 % (conservative word match) | — |
| Notes with fewer problems than gold | 19 of 30 | — |
| Repeated label lines under one problem ("Treatment planned:" ×4) | **0.93** (12 notes) | 0 |
| Lines over 170 characters | 0.40 | 0.03 |
| Separate advice / counselling lines | **0** | 0.47 |
| Separate follow-up lines | **0** | 0.50 |
| Empty labels / generic bucket titles | 0.07 / 0.03 | 0.03 / 0 |

Auditor (Gemini 2.5 Pro, new prompt) on all 30: content verdicts 14 good, 12 needs work, 4 unsafe, mean content score 68.5. Presentation scores: flow 58, easy reading 59, facts organised 51.

### What the Assessment & Plan lacks (verified in the notes)
1. **Two notes have no Assessment & Plan at all** (`rt-sciatica`, `obesity-rt-hand-pain`, 2 of 30). Cause found in the pipeline log: in `rt-sciatica` the writer looped inside Subjective (19,967 characters, 1,601 duplicate lines removed by clean-up) and never reached the plan; in `obesity-rt-hand-pain` the writer returned an empty plan for a visit with seven issues. Nothing detects or retries either case.
2. **Issues merged or left out** (F1): haematuria and recurrent urinary symptoms merged under one title; low B12, hypertension, lower back pain, mildly raised cholesterol, mildly low iron, tetanus, breast and colon screening, a prescription refill, massage and back-brace requests all have their own problem in gold and none in ours.
3. **Same label repeated** (F2): "Investigations planned:" ×4 and "Treatment planned:" ×5 under one problem; gold writes one line per label with the items joined.
4. **Facts under the wrong label** (F3): "Treatment planned: B12 low.", "Treatment planned: Urine dipstick: 2+ blood", "Treatment planned: Weight management: on Wegovy for two months…".
5. **Advice and follow-up buried or absent** (F4): "Advised to increase green leafy vegetables" and "Follow-up in July" sit inside Treatment lines, or are missing.
6. **Bucket titles** (F5): "Lab abnormalities", "Lab review" (the spec allows only "Administrative").

Honest caveats: the auditor's headline ("failure", "unsafe") is harsher than the numbers; "critical medication error" claims on two notes compare our note with the gold note, not with the transcript. One is confirmed against the transcript: in `db` our note names **Ozempic**, which does not appear anywhere in the transcript (gold says Jardiance). The 59 % problem coverage understates real coverage (word matching misses synonyms). Gold notes are not the truth; they are the model for layout.

## 4. What changed in the tools (all in the Lab, nothing in the locked files)
| Piece | Change |
|---|---|
| Audit prompt (`AUDIT_DEFAULT`) | Judges two things: content (as before) and **presentation** — flow, easy reading, facts organised (0–100 each). Knows F1–F7 and a copy of Style Spec v1. New output `ap_gaps` (kind: missing_problem, merged_problems, missing_line, misplaced_fact, repeated_label, generic_title, run_on, echo; each marked `inside_spec` or `beyond_spec`). |
| Code metrics | `formatMetrics.js` computes the layout numbers above for every note and hands them to the auditor as facts; run-level summary at `GET /lab/runs/:id/format`; principles at `GET /lab/format-principles`. 6 new tests. |
| Diagnosis report (`OVERALL_SYS`) | Same priorities (nothing wrong → flow → easy reading → facts organised → completeness). New outputs: `presentation`, `format_findings` (with principle, count, fix, spec status), spec status on every recommendation. The worst-notes ranking now includes layout, not only omissions. |
| Prompt upgrade (`UPGRADE_SYS`) | Receives the principles and the format statistics; anything beyond Style Spec v1 may only appear as a "BEYOND SPEC" suggestion, never in the candidate prompt. Candidates still cannot be promoted while the lock is on. |
| Admin console | Per-note audit shows the three reading scores, the format flags and the A&P gap list; the report page shows reading KPIs, a layout-findings table and "needs spec change" chips. |

## 5. Proposals (nothing applied)
Inside Style Spec v1 (writer/pipeline work, needs your go-ahead because the writer prompt and `generateNoteV2.js` are locked):
1. Detect a writer output with no plan, or a repetition loop, and retry the writer once (2 of 30 notes lost the whole plan). This changes no format.
2. One problem per issue: bullet-level rule for small result comments, screenings, vaccines, refills (F1).
3. Each label once per problem, items joined (F2).
4. Facts under the right label; short lines (F3).
5. A drug name not found in the transcript is flagged, as the Ozempic case shows.

Beyond Style Spec v1 (needs `UNLOCK STYLE SPEC v1`):
6. A separate "Advised: …" line and a "Follow-up: …" line inside a problem (spec today says follow-up is part of the plan and has no separate problem; gold writes both as lines).
7. A separate problem for recurrent symptoms that are distinct from a new issue.

The same items are in the Studio proposals list as pending.

## 6. Not done / open
* No production frequency count of notes with an empty plan yet (the run suggests ~7 %); worth a statistics-only check.
* The audit and diagnosis were run on this one 30-note run; re-run after any pipeline change.
* Earlier commits in this repository carry `Co-Authored-By: Claude …` trailers; commits from this change carry none. Rewriting history is your decision (see the chat message).
