# Notera pipeline audit — what we checked, what we measured, what is live, and the shorter plan

2026-10-27. Basis: the owner's audit plan (*Notera SOAP Pipeline Audit & Optimization Plan*), the research paper (Asgari et al., *A framework to assess clinical safety and hallucination rates of LLMs for medical text summarisation*, npj Digital Medicine 2025, 8:274), the system guide (`docs/PIPELINE_AND_SYSTEM_GUIDE.md`) and about 40 lab runs of the 30-note gold set plus a 30-note hold-out. The locked note format (Style Spec v2.3.3) was not touched.

---

## 1. Bottom line

1. **Live now: coverage, the ledger question and the grounding check start while the story agent works** (`GAP_EARLY`, `GROUND_EARLY`, on by default). Time per note fell about 25%: 38 s to 28 s on the hold-out (−10.7 s and −7.7 s in two runs, t = −4.7 and −3.4), 35 s to 24 s on the gold set. Critical misses, wrong lines and fact recall did not change beyond noise on either set.
2. **Quality did not improve in any experiment we ran.** Nothing we tried produced a measurable gain in critical misses or fact recall. So no "quality" change is switched on. Every candidate that did not prove itself is in the code, off, with its numbers below.
3. **The measurement was the weakest part of the system.** 38–42% of the "critical misses" the judges listed were only synthetic dates left in the de-identified gold transcripts. The same notes judged three times differed by 8 points and changed their critical count in 14 of 30 notes. The control run was always judged first, which made every other run look worse. All three are fixed (section 4). One claim I made earlier — that removing the editor, grounding, attribution or story stages raised unsupported lines — came from that bias and is retracted.
4. **Cost telemetry undercounted by about 70%.** The stored cost counted 3 of about 17 model calls per note. Fixed (all calls are counted); the real cost is about $0.075 per note, 73,000 input tokens, 17 calls.
5. **Where the real misses come from:** when a critical fact is really missing, it was usually never extracted into the fact graph (1 of 12 traced losses was in the graph). Improving extraction recall is the highest-value next step.
6. **Errors by the paper's taxonomy:** half of our wrong claims are in the plan, and the commonest kind (49%) is a wrong detail — a number, dose, drug, name or date — not a fabrication.

---

## 2. The research paper, and what we took from it

The paper reports 18 prompt/workflow experiments on 450 transcript–note pairs (12,999 note sentences, 49,590 transcript sentences, all annotated by two clinicians plus a senior reviewer, major/minor by whether the error "could change diagnosis or management"). Findings that matter to us:

| Finding in the paper | What it says for Notera | What we did |
|---|---|---|
| Hallucination 1.47%, omission 3.45% of sentences; 44% of hallucinations and 17% of omissions were major | Hallucinations are rarer but more dangerous | Report omissions and wrong lines separately, each with a severity, not one blended score |
| Hallucination types: fabrication 43%, negation 30%, contextual 17%, causality 10%. Most major ones in the Plan | Plan lines and negations need the most care | Applied the same taxonomy to our own judged wrong claims (section 7) |
| **Extracting atomic facts first and writing from them made notes worse** (major hallucinations 4 to 25, major omissions 24 to 47) | Do not feed the fact graph to the writer | Matches our own test (`FACTS_TO_WRITER`: worse). The graph stays an independent checker |
| Structured prompt (base, template, style), an "unknown / not mentioned" status and explicit negation rules cut major hallucinations 75% and major omissions 58% | The writer is already structured and locked | No change to the locked writer |
| Per-problem structured JSON output plus style rules took major omissions from 61 to 0 | Same | Already how the writer works |
| Change **one thing at a time**, same cases, fixed settings | The only way to attribute an effect | Every arm below is one switch against a same-time control |
| Two clinicians per sentence, a senior reviewer, severity by harm; LLM judges only as screening | Judge scores are not safety evidence | The plan (section 9) adds a clinician-annotated hold-out |
| Limits: one model (GPT-4), 25 transcripts per experiment | Small samples | We state our own power: 30 notes detect only about 0.35 critical misses per note |

The paper's revision-step experiments (14 and 15) are described only in its supplement, which we do not have.

---

## 3. The audit plan, claim by claim

| Claim in the audit | Verdict | Evidence |
|---|---|---|
| Overlapping passes: plan sweep, coverage, ledger, grounding | **Partly true.** They overlap but do different work | Removing coverage cost about 2.5 recall points; removing graph + ledger about 1 point; sweep about 0.7. None is provably redundant at 30 notes, and none provably needed for critical misses |
| Consolidate them into one call over the graph | **Not safe as written** | Coverage finds facts the graph never extracted; dropping it lowers recall. We kept all calls but ran them in parallel instead (the time win) |
| Grounding may check an earlier copy of the note | **True** | Before the change it ran on a copy taken before coverage, the ledger and the story merge; about 8 of 31 lines per note were never seen. A catch-up check found 4 unsupported lines in 232 (including "Continue Cymbalta 60 mg" when 16 mg was said) but cost +7 s |
| Story prompt has two length rules (4–14 and 10–22 words) | **True** | But the word check rarely rejects it (3 of 43 rejections). 16 of 43 were the model dropping topic headings |
| `thinking_budget` is deprecated on Gemini 3.x and gives 400 errors | **Not seen** | No such errors in 14 days of logs. Switching 3.7 to `thinking_level=low` was 4.5 s slower with no quality gain |
| ~150,000 input tokens per note | **True for the longest transcript only** | Typical note: 73,000 input tokens, 17 calls |
| The fact graph is the main token cost | **True** | Extractor and recovery are 42% of input tokens (their prompt is repeated per window), but they run beside the writer |
| Do not turn thinking off | **Agreed** | Measured: off was worse |
| Story: validate meaning, not word overlap | **Low value** | Word overlap caused 3 of 43 rejections |
| Medication canonical names must not erase what was said | **Agreed** | Existing rules keep the spoken name; the drug check only suggests |
| Evidence contract for inserted facts | **Agreed, partly built** | Dose repair and graph-supported grounding exist but did not fire or help on 30 notes |
| Stronger evaluation (error taxonomy, severity, clinician adjudication, paired runs, repeats) | **Agreed and done, except clinicians** | Section 4 |
| Targets: input cost −30%, median 25 s | **Median reached** (24–28 s). Cost −30% only by dropping the graph (−46%), which we do not recommend without a recall plan |
| Entity-based evidence retrieval; PostgreSQL first | **Reasonable, later.** Inside one visit the whole transcript fits in a prompt, so retrieval would only shrink prompts. A plan-check experiment used evidence passages and was too noisy (section 6). Cross-visit history retrieval needs identity, chart integration and permissions first |

---

## 4. How we measure now, and why the old numbers misled

| Problem found | Size | Fix |
|---|---|---|
| Synthetic dates in the gold transcripts are listed as "critical misses" ("duration for 2002-07-16") | 38–42% of listed critical facts | Excluded from the headline critical count |
| The judge alone is noisy | Same notes, three passes: score spread 8.3 points; critical count differs in 14 of 30 notes; 35% of criticals not repeated | Pro judge three times, a fact counts when at least two passes list it. Flash judge no longer used for decisions (it listed 2–3 times more criticals, 185 of 267 flags by one judge only) |
| Run order bias: the control was judged first and looked best | The "all ablations raise wrong lines" result vanished when notes were shuffled | `score-multi.mjs` judges all runs together, notes shuffled |
| The doctor's reference note defines "missing" | A fact the doctor left out is never counted | Added **fixed-fact recall**: 792 transcript facts (147 critical) from the fact graph, scored present / partial / absent in each note. Caveat: the facts come from the same extractor the pipeline uses, so arms that include the ledger have a small built-in advantage |
| One run per variant | Run-to-run spread of the same setup: critical 0.45–0.83 per note, fact recall 87.9–92.3% | Every variant runs at the same time as a control; paired per-note differences with standard errors |
| Small sample | 30 notes: about 0.35 critical misses per note is the smallest difference we can see | A second 30-note hold-out set on topics not used before (`eval/gold-set-b.json`) |

Tools: `packages/backend/tools/audit/` (README there).

---

## 5. What we ran, and what each result was

All numbers are against a same-time control, scored with shuffled three-pass judging. "t" is the paired t-statistic; below about 2 it is noise. Critical = pro-judge critical misses per note without date artifacts (control about 0.5–0.7). Recall = fixed-fact recall (control 88–92%).

### 5.1 Remove one stage at a time (30 notes)

| Stage removed | Critical | Wrong lines | Recall | Time | Cost | Reading |
|---|---|---|---|---|---|---|
| Fact graph and ledger | −0.07 ± 0.22 | −0.40 ± 0.39 | −1.1 | −4.1 s | **−46%** | Not detectable. Biggest cost saving |
| Coverage (and plan completeness) | −0.03 ± 0.18 | −0.33 ± 0.49 | **−2.5** | −0.2 s | −6% | Largest recall contribution |
| Plan sweep | +0.03 ± 0.18 | −0.07 ± 0.59 | −0.7 | −3.0 s | −11% | Not detectable |
| Editor | +0.33 ± 0.20 (t 1.7) | +0.17 ± 0.39 | +0.3 | −0.7 s | −6% | Possible effect on criticals |
| Plan attribution | +0.07 ± 0.22 | +0.80 ± 0.58 | +1.8 | +0.7 s | −3% | Not detectable |
| Story merge (second pass) | +0.13 ± 0.21 | +0.50 ± 0.54 | −1.4 | −0.5 s | −3% | Not detectable |
| Story agent | −0.20 ± 0.17 | +0.30 ± 0.45 | +0.7 | +1.8 s | −9% | Not detectable |
| Grounding | −0.20 ± 0.22 | +0.60 ± 0.72 | +1.2 | +0.9 s | −7% | Not detectable. It removes about 0.1 lines per note |

Reading: with 30 notes the data cannot show that any stage is useless or essential for critical misses. We removed none.

### 5.2 Candidates (30 notes; the last two also on the hold-out)

| Variant (switch) | Time | Quality | Decision |
|---|---|---|---|
| **Coverage + ledger question asked early** (`GAP_EARLY`) | −3.6 s (t −3.5) | Neutral. The grounding check then became the slowest step | Part of the shipped change |
| **Plus grounding started early** (`GROUND_EARLY`) | **−11.8 s** (t −6.3) | Neutral: critical +0.10 ± 0.18, wrong +0.17 ± 0.39, recall 88.4 vs 87.9 | **Shipped, on by default** |
| Hold-out, 30 new notes, 2 runs | −10.7 s and −7.7 s | critical +0.10 ± 0.21 and +0.03 ± 0.11, wrong lines −0.58 and −0.45, recall 93.1/90.6 vs 90.5/92.1 | Confirmed |
| Late-line grounding check, all unseen lines (`GROUND_DELTA=1`) | +6.8 s | Removed 4 lines in 30 notes (a wrong dose, two invented exam findings, one unsupported "continue") | Off |
| Same, only plan and Objective lines, in the background (`GROUND_DELTA=2`) | +2.7 s | Recall +2.0 (noise); removed 1–2 lines per 30 notes | Off |
| `thinking_level=low` on 3.x models (`LLM_3X_THINKING_LEVEL`) | +4.5 s | None | Rejected |
| Story attempts in parallel (`STORY_PARALLEL`) | +1.3 s | None | Rejected |
| Story heading reminder (`STORY_VARIANT=remind`) | +0.1 s | Story rejections 48 and 40 down to 24 | Optional, low value |
| Grounding that skips lines the fact graph supports (`GROUND_FACTS`) | slower when combined (graph wait) | 46% of lines supported by the graph; removes 0.03 vs 0.10 lines per note | Off |
| Dose repair from the graph (`DOSE_REPAIR`) | none | **Fired on 0 of about 120 notes** | Off, unproven |
| Negation guard, flags only (`NEG_GUARD`) | none | 0.2–0.37 flags per note, mostly unspoken denials and invented exam findings; precision not verified | Off, pilot candidate |
| Plan action check, flags only (`PLAN_CHECK`) | +4.5 s if serial | Catches 51–55% of judged wrong plan claims but flags 4 items per note; 1 in 5 matches the judge, many legitimate referral decisions flagged | Off |

### 5.3 Where the time goes

| Stage (mean seconds, control → early start) | Control | Early start |
|---|---|---|
| Writer + checklist (fact graph runs beside it) | 8.6 | 7.2 |
| Editor | 3.0 | 2.9 |
| Story | 3.3 | 3.8 |
| Plan sweep | 1.8 | 1.7 |
| Coverage wait | 7.0 | **0.7** |
| Ledger wait | 5.8 | **0.9** |
| Story merge | 1.8 | 2.2 |
| Grounding wait | 0.2 | 1.1 |
| Pipeline total | 42.7 | 31.9 |

The grounding check itself takes about 9.5 s either way; it used to hide behind coverage and the ledger, now it runs beside them. The remaining critical path is writer, editor, story, then the longest of the parallel checks.

---

## 6. What changed in the code

On by default (kill switch in brackets):

| Change | Where | Kill switch |
|---|---|---|
| Coverage and ledger questions asked on a copy of the note while the story agent works; answers applied afterwards (plan numbers re-mapped by problem title, "already says it" claims moved to the matching current line) | `gapEarly.js`, `generateNoteV2.js` | `GAP_EARLY=0` |
| Grounding check started at the same moment on the same copy; its removals reach the final note by text, a Subjective line the story reworded is flagged instead of removed | `generateNoteV2.js` | `GROUND_EARLY=0` |
| Every model call of a note is counted (cost, tokens, thinking); stored cost uses each call's own model price | `LLMService.js` (`ensureUsage`), `opsLog.js`, `generateNote.js` | none (monitoring only) |
| The note quality record now holds the grounding gap and complete usage | `generateNoteV2.js` | none |

In the code, off by default (each with tests): `GROUND_DELTA`, `GROUND_FACTS`, `DOSE_REPAIR`, `NEG_GUARD`, `PLAN_CHECK`, `STORY_PARALLEL`, `STORY_VARIANT=remind`, `LLM_3X_THINKING_LEVEL`, `V2_WRITER_THINKING_LEVEL`. The writer prompt, the style spec, the renderer and every locked file are unchanged (`node scripts/spec-lock.mjs`: unchanged).

---

## 7. The paper's taxonomy applied to our errors

534 distinct wrong claims judged in five control and early-start runs:

| By type | Share | By section | Share |
|---|---|---|---|
| Wrong detail (number, dose, drug, name, date) | 49% | Plan | 49% |
| Contextual (wrong problem, person or time) | 20% | Subjective | 33% |
| Fabrication | 17% | Objective | 11% |
| Negation | 13% | Assessment | 7% |
| Causality | 0.2% | | |

Judged critical or major only (173): plan 60%, subjective 27%; wrong detail 51%, fabrication 20%, negation 18%, contextual 11%.

Samples of the major plan errors: "Started: Injection" when it was only an option to research; "Discussed antibiotic drops" when they were prescribed; "Continued: Tetanus Diphtheria" when Adacel was given today; a referral to the wrong doctor's name; "faxed" when the patient asked for it printed. These are **action-status and detail errors**, which is what the plan check tried to catch.

Caveat: some "wrong detail" claims are again de-identification artifacts ("[date]" placeholders), so the true detail-error share is lower.

---

## 8. Honest limits of this audit

- 30 notes per run (60 on the hold-out) cannot show differences smaller than about 0.35 critical misses per note. Several of the candidate changes may help or hurt by less than that.
- The judge is an AI model reading a doctor's reference note. It is a screen, not safety evidence. There was no clinician review.
- The fixed-fact recall uses facts from the pipeline's own extractor, so it favours arms that include the ledger.
- The gold transcripts are de-identified with synthetic dates and placeholder names, which understates how the system behaves on real recordings.
- Timings come from the lab under load; production timing will differ. The relative saving (about 25%) was consistent in three runs.
- The early-start change adds parallel model calls. Under heavy concurrent use, Google's 429 busy answers may become more frequent; the retry logic handles them, but this has not been measured at production load.

---

## 9. The shorter plan

In order of value. Each step is tested in the lab against a same-time control on the gold set and the hold-out before anything goes live.

1. **Watch production for a week.** Compare time per note, retries and 429 counts against the week before; the Quality page now shows true cost and calls per note. Kill switches: `GAP_EARLY=0`, `GROUND_EARLY=0`.
2. **Raise fact recall at the source.** Real misses are mostly facts the extractor never saw (advice, follow-up, referral and plan details). Test a targeted second extraction pass for those categories on the hold-out; measure with fixed-fact recall.
3. **Cut the fact graph's cost.** It is 42% of input tokens because its 17,000-character prompt repeats per window. Measure how much Vertex already caches, then test a shorter prompt and merging the recovery pass. Target: −30% input tokens with the same recall.
4. **Get clinician review.** Two clinicians annotate 60 notes sentence by sentence (omission / hallucination, major / minor, the paper's categories) and adjudicate the judge's critical findings. Use it to replace the AI judge as the release gate, and to clean the synthetic dates out of the gold set.
5. **Plan action status, done properly.** Re-try the plan check with evidence passages chosen from the fact graph's own quote positions, only for "started / prescribed / referred / faxed" items, and show it only when the quote proves a mismatch (target: under 1 flag per note, at least half real).
6. **Medicine evidence contract.** Lines the ledger writes by rule ("Continue X 60 mg") must carry the fact's own dose and an action word from its own quote; otherwise they are written as "Discussed X" or flagged. Dose repair already does the first half; test it on a larger sample because it fired 0 times in 120 notes.
7. **Later: patient history retrieval.** Prerequisites: reliable patient identity, EHR integration, data provenance and permissions. Then test hybrid search in PostgreSQL (full text plus vectors) over prior notes before any separate vector database.

Release rule for every step: no change if fact recall falls by more than 1 point, critical misses rise by more than 0.2 per note, or wrong lines rise by more than 0.5 per note, with at least 30 paired notes and the hold-out; faster or cheaper counts only when quality is unchanged; a quality gain counts even if it costs seconds.

---

## 10. Reproduce

```
# inside the lab container, from /app/packages/backend
node tools/gold-eval.mjs <run> 2 --env=KEY=V          # one variant (run a control at the same time)
node tools/audit/score-multi.mjs <runs...>            # shuffled 3-pass judge + fixed-fact recall
node tools/audit/compare.mjs <runs>-j3                 # one table
node tools/audit/paired.mjs <control-j3> <arm-j3>      # paired difference with standard error
# hold-out: GOLD_SET=gold-set-b.json FACTS_FILE=/lab-data/gold-facts-b.json
```
