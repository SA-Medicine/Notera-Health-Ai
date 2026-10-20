# Notera Studio — honest review and plan for a doctor-grade note engine
Prepared 2026-10-20. Nothing in this document is implemented yet; it is for approval.

## 0. The short version
1. **Your gold data is not one style — it drifts, and the newest notes are the style you described this week.** Topic-headed Subjective (and Objective), 21.7 Subjective lines (vs 6.5), numbered A&P with labels. Only 9 % of our few-shot examples use it. We have been teaching the model the *old* style.
2. **The system works but is now a stack of patches around one prompt.** The last six weeks added ~15 deterministic repairs (regex and heuristics). Each is justified, but together they are the sign that the generator does not yet know the target format.
3. **We still judge notes against another doctor's note.** That cannot reward "the note this doctor would sign". The market and the research have moved to (a) a clinician-quality rubric, (b) an error taxonomy for hallucination/omission, (c) learning from what the clinician *edits*.
4. **Recommendation:** build **Notera Studio** as a separate service: a *Style Spec* per doctor/clinic (what you and I did by hand in this session, made repeatable), a doctor-centred evaluator, evidence-linked generation, an edit-learning loop and a measured fine-tuning track. Phase 0 (one week) already fixes the biggest mismatch.

## 1. What the data says (checked today)
| Cohort | Notes | Topic headings in Subjective | Avg Subjective lines | A&P numbered | "Treatment planned:" labels |
|---|---|---|---|---|---|
| Encounters Dec 2025 – Mar 2026 | 1,325 | 0 % | 5–8 | – | 0–59 % (varies by month) |
| Encounters Apr 2026 | 307 | 23 % | 10.1 | – | 44 % |
| Encounters May 2026 | 230 | 38 % | 11.9 | – | 57 % |
| Latest import batch (undated, 14 Aug) | 898 | 28 % | 11.3 | – | 68 % |
| **All topic-headed notes** | **410** | 100 % | **21.7** | **99 %** | 50 % |
| All other notes | 2,380 | 0 % | 6.5 | – | 29 % |

* **Caveat:** the files carry no creation timestamp. I used the encounter date in the transcript header (1,876 of 2,801 have one, Nov 2025 – Jul 2026) and the import batch. The 898 notes of the latest batch have no encounter date; their higher share of headed notes (28 %) suggests they are newer. **Please confirm the real creation dates if you have them.**
* The "recent-style" training pool = headed notes ∪ encounters from Apr 2026: **790 notes (751 with a usable transcript)**.
* Our few-shot bank (300 pairs) has **26 headed examples (9 %)**. That alone explains why the model keeps writing flat bullet lists.
* Eval mismatch: gold transcripts have **no speaker labels**; production ASR runs with diarization on. We test on a different input than we ship.

## 2. What the system is today (a map)
```
audio -> Google STT (latest_long / chirp_2, diarization) -> de-identification
  -> v2 pipeline: writer (gemini-3.7-flash, 2 reference notes) || checklist (flash-lite)
     -> merge dropped facts -> drug-name guard -> template/placement guards
     -> verifier (LLM) -> reviewer/editor (LLM) -> story agent (LLM, Subjective)
     -> plan tidy / dedupe / reference names (RxNorm, ICD-10) -> markdown render
Admin console: prompts (versioned), runtime settings, system map, Lab (runs, audits, diagnose, upgrade), 84 unit tests
Evaluation: similarity (word overlap), parity (LLM vs gold), strict audit (gemini-2.5-pro), critical claims/note
```
**What is genuinely good (keep):** versioned prompts/settings with rollback; a lab that measures before shipping; drug-name safety guard; audio end-to-end test; honest metrics (we found and dropped the misleading "90+" claim); reference-note few-shot; a 2.7k-pair dataset few competitors can touch.

## 3. Honest weaknesses, ranked by impact on "a note this doctor likes"
| # | Weakness | Evidence in our own runs | Cost of leaving it |
|---|---|---|---|
| 1 | **Target style is implicit.** The format lives in prompt prose + regex guards, not in one machine-readable spec. | The same transcript gave three different A&P structures in three runs; I fixed placement, titles, refills and addresses with separate code each time. | Every new doctor preference = another patch; fragile and untestable as a whole. |
| 2 | **Training/reference data not matched to the current style.** | 9 % headed examples vs 28–38 % in the newest notes. | Model reverts to the old format. |
| 3 | **Evaluation is comparison-based.** | Clinicians' own gold scores 73/100 on our strict audit; similarity cannot pass ~0.4 between two authors. | We optimise toward a moving, different author instead of "acceptable to sign". |
| 4 | **No learning from edits.** | The product stores finals but nothing turns a doctor's correction into a rule. | Heidi/Freed already do this; each correction is a free training signal we discard. |
| 5 | **No per-claim evidence.** | The verifier asks an LLM "is this supported?" in bulk; unsupported claims are only found when it happens to notice. | Trust: doctors cannot check a line in 2 seconds; auditors cannot measure. |
| 6 | **Speaker attribution is weak in eval and unproven in prod.** | Gold transcripts are unlabeled ("who said it" is guessed). Plan items drift between problems; "denies/reports" can flip. | The CREOLA study found negation errors are 30 % of hallucinations. |
| 7 | **Latency crept up** (17 s -> 21 s median; 30 s p95+) and five sequential LLM stages. | Measured above. | Doctors compare against 5–10 s scribes. |
| 8 | **One big module** (`generateNoteV2.js`, ~720 lines, plus 280 of guards). | Patches are applied by scripts; stages are not independent plugins. | Hard to reason about, hard to hand to another engineer. |
| 9 | **Model choice is untested for tuning.** | We tuned prompts only; 2.7k pairs are unused for training. | The largest lever may be untouched. |
| 10 | **Governance not visible.** | De-id placeholders in gold ([date]); region/BAA/consent not documented in the repo. | Blocks clinic adoption. |

## 4. How the market actually works (with the evidence level)
| Product | What is public | Takeaway for us | Evidence |
|---|---|---|---|
| **Heidi** | Output follows a template; templates can be generated from a chat description, uploaded, pinned, shared by department. **Personalisation** (beta) tracks your edits and learns terminology, abbreviations and formatting, excluding patient data. [Heidi: notes that sound like you](https://www.heidihealth.com/blog/heidi-adapts-to-you) | The moat is *template + learned style*, not a magic model. | Vendor blog; internals not public |
| **Freed** | "Learned Templates" built automatically from your edits (headings, spacing, list vs narrative). [Freed FAQ](https://www.getfreed.ai/resources/faq-freed-note-templates) | Same loop, different unit (whole-note format). | Vendor |
| **Abridge** | **Linked Evidence** maps note sections to transcript spans; a separate confabulation-detection model (claims 97 % catch vs 82 % GPT-4o on an internal 10k-encounter set) plus auto-correction. [HIT Consultant](https://hitconsultant.net/2025/08/21/abridge-outlines-approach-to-eliminating-ai-hallucinations-in-clinical-notes/) | Evidence links make verification and trust cheap. | Company-reported, unverified |
| **Microsoft Dragon Copilot / DAX** | Capture -> draft -> clinician edit -> finalise; personalisation mostly via templates; ratings/comments feedback and note rollback. [Microsoft UX guidelines](https://learn.microsoft.com/en-us/industry/healthcare/dragon-copilot/sdk/get-started/ux-guidelines) | Enterprise value = workflow + EHR integration + feedback, not a secret prompt. | Docs + marketing |
| **Nabla / Suki / Ambience** | Template customisation per specialty ("problem splitting", section styling); no public closed-loop learning found. [Nabla blog](https://www.nabla.com/blog/ai-medical-scribes) | Problem-splitting is a *template option* — exactly what we hand-coded. | Vendor |
| **Independent trials** | UCLA RCT (NEJM AI, Nov 2025): Nabla -9.5 % time-in-note, DAX no significant change; burnout improved for both; occasional inaccuracies. [UCLA](https://www.uclahealth.org/news/release/ucla-study-finds-ai-scribes-may-reduce-documentation-time) | Time savings are modest; **trust and edit effort** decide adoption. | Peer-reviewed, single centre |

I found **no public description of the models, training data or tuning** of any of these products. Be sceptical of any comparison that says otherwise.

## 5. What the research supports
| Finding | Source | What it means here |
|---|---|---|
| Hallucination 1.47 % of note sentences, omission 3.45 % of transcript sentences (GPT-4, 450 notes, ~50 clinicians); 44 % of hallucinations "major", mostly in the **Plan**; negation 30 %. | [Asgari et al., npj Digit Med 2025](https://pmc.ncbi.nlm.nih.gov/articles/12075489/) | Use this error taxonomy as our standard; our "critical wrong claims 0.30/note" is not comparable until we do. |
| **Extracting facts first made errors worse; a rigid template also increased major hallucinations; structured prompts with style rules, negations and an explicit "unknown" status, and JSON function-calls, reduced them.** | same | Matches our own finding (literal template lowered completeness). **Do not rebuild around an extract-then-write pipeline.** |
| Clinician-rated quality of AI scribe notes comparable to physician notes; AI notes more thorough/organised, less succinct, more hallucination-prone. PDQI-9 adapted with 11 criteria + binary hallucination flag. | [Palm et al., Front AI 2025](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1691499/full) | A doctor-centred rubric exists and is validated enough to adopt. |
| LLM judges can approach clinician agreement on a PDQI-style instrument (best ICC 0.82, reasoning models best), but reviewer agreement on *hallucination* is the weak point; a vendor reports near-chance agreement. | [PDSQI-9 judge preprint](https://www.medrxiv.org/node/1085777), [Suki critique](https://origin-www.suki.ai/blog/the-broken-ruler-why-the-healthcare-industry-is-measuring-ai-notes-the-wrong-way-and-what-they-should-be-doing-instead/) | Keep human calibration on a small set; judge only what the judge can be shown to agree on. |
| **Learning a plain-language preference description from user edits** (PRELUDE/CIPHER) beats baselines on edit distance without fine-tuning; descriptions are user-readable and editable. | [Gao et al., NeurIPS 2024](https://arxiv.org/pdf/2404.15269) | Direct blueprint for "learn from the doctor's edits" with no model training. |
| Few-shot GPT-4 beat a fine-tuned model on MEDIQA-Chat 2023 (and was preferred as often as human notes); adapted open 13B models are viable for privacy/cost. | [WangLab 2023](https://arxiv.org/abs/2305.02220v2), [Wang et al. 2024](https://arxiv.org/pdf/2405.00715v5) | Fine-tuning is an *experiment to run and measure*, not a given. |
| Semantic entropy flags confabulation from disagreement across samples. | [Farquhar et al., Nature 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11186750) | Useful for high-risk entities (drug, dose, side, number), too costly for every sentence. |

## 6. Target design — Notera Studio (separate service)
A new repository/service (`notera-studio`) that owns *style, evaluation and learning*. The existing pipeline becomes one pluggable engine behind it. Seven parts:

1. **Style Spec (the core idea).** A versioned, human-readable spec per doctor/clinic/specialty: sections and order; Subjective = topics + bullets (max words); denial-once; PMH max 6 bullets + Medications line; A&P = one problem per issue, plain titles, assessment only if stated, refills under the condition; wording preferences; forbidden content. One spec **compiles into four things**: the writer prompt, deterministic validators (replacing today's ad-hoc guards), the judge rubric, and the few-shot filter. The session we just did becomes a product feature: **"Teach Notera" — show a note, ask targeted questions, convert answers to spec diffs, regenerate, accept.**
2. **Reference corpus manager.** Gold pairs with metadata: encounter/creation date, doctor, specialty, style cohort, quality label, de-id status. Date-based splits: train old -> test newest; "newest-first" sampling; a frozen newest-style test set.
3. **Doctor-centred evaluator (no gold comparison needed).** (a) PDQI-9-derived rubric (11 criteria) scored per section; (b) CREOLA-style error taxonomy with severity (hallucination: fabrication/negation/causality/contextual; omission: current/PMFS/plan); (c) Style-Spec conformance (deterministic); (d) blind pairwise "which would you sign" with order swap. Calibrated on a **150-note double-rated set** by two physicians; the judge is only trusted on criteria where its agreement with them is shown.
4. **Generation engine v3.** Keep single-pass structured JSON (the evidence says extraction-first hurts), but: speaker-aware transcript; every bullet carries source span ids (**evidence-linked**); a claim verifier that checks each bullet against its span (NLI-style) and flags unsupported ones; semantic-entropy style sampling only for medications/doses/laterality/numbers; the editor/story passes become *spec-driven* conformance passes instead of free-form rewrites.
5. **Edit-learning loop.** Capture the diff between draft and signed note at bullet level; classify edit types; induce readable per-doctor preference rules (CIPHER-style, PHI stripped), shown to the doctor to approve/edit; accumulate (draft, edited) pairs as the future tuning/DPO set.
6. **Tuning track (measured, not assumed).** Supervised tuning of the Gemini Flash model on the recent-style pool (751 pairs), evaluated on a frozen newest-style test set against the best prompt-only system. Success = fewer post-patches, lower latency, equal or better rubric score and error rate. Optional later: open-weights LoRA for on-prem privacy.
7. **Ops and governance.** Online metrics per doctor (edit rate per section, accept-without-edit, time-in-note), cost/latency dashboard, regression gate in CI (frozen set + rubric + validators), canary rollout, documented data residency/consent/BAA.

## 7. Phased scope (you approve phase by phase)
| Phase | Scope | Deliverable | Exit criterion | Effort* |
|---|---|---|---|---|
| **0 – Fix the data mismatch** | Date/style cohort index of the gold set; rebuild the few-shot bank from the 790-note recent pool; date-split frozen test (100 newest-style); give the lab speaker-labelled transcripts where possible | `cohorts.json`, new bank, test set, one report | Headed examples in bank 9 % -> >60 %; re-run holdout shows format conformance up | ~1 week |
| **1 – Style Spec + conformance** | Spec format; compile to prompt + validators; migrate today's guards into validators; "Teach Notera" session UI in the admin Lab | Spec v1 for the recent style; validators with tests | Conformance ≥ 95 % on the frozen set; guards deleted or reduced to spec rules | 2–3 weeks |
| **2 – Doctor-centred evaluator** | PDQI-9 rubric + error taxonomy judge; 150-note double rating; agreement report; replace "parity" as the headline | Evaluator v1 + calibration report | Judge-physician agreement documented per criterion; baseline numbers for current system | 2–3 weeks (+ physician hours) |
| **3 – Evidence-linked generation** | Span ids per bullet; claim verifier; high-risk-entity sampling; UI "show source" | Linked Evidence in the app; unsupported-claim flags | Major-hallucination rate measured with the taxonomy; target below the 1.47 % baseline | 3 weeks |
| **4 – Edit-learning loop** | Edit capture, preference induction, per-doctor rule review screen | Personalisation v1 | Edit rate on pilot doctors falls week over week | 2–3 weeks |
| **5 – Tuning experiment** | Vertex supervised tuning on recent-style pool; A/B vs prompt-only on frozen set | Decision memo: tune or not | Wins on rubric/error rate and latency, or we stop | 2 weeks + compute |
| **6 – Studio as its own product/repo** | Extract Style Spec, evaluator, learning into `notera-studio`; engine behind an interface | Separate deployable | Notera app consumes Studio via API | 2 weeks |
\*One engineer with me pairing; physician time is the real constraint in phases 1–4.

## 8. What I would not do
* More regex repairs for each new preference (that is what the Style Spec replaces).
* Chasing similarity or parity-to-gold as the headline — it measures resemblance to another author.
* Extract-first/template-literal generation (contradicted by both the paper and our own runs).
* Fine-tune before the evaluator is trusted — we could not tell if it helped.
* Adding "more models in more stages" for latency-critical paths.

## 9. Risks and honest unknowns
* No creation timestamps; style might also differ **by doctor**, which the files do not record. If several doctors wrote the gold notes, one spec will not fit all — Phase 0 should add a doctor field.
* A 150-note double-rated set needs ~2 physicians × ~10 hours. Without it the judge is unverified.
* Vendor figures (Abridge's 97 %, "personalisation" claims) are unverified; treat as direction only.
* Regulatory scope (Canada/US, medical-device classification of AI scribes, data residency) is outside what I can confirm — needs your legal/clinical lead.
* The tuning track can lose to prompting (WangLab 2023); we budget it as an experiment.

## 10. Decisions I need from you
1. **Approve Phase 0 now?** (the data/cohort fix; low risk, one week)
2. **Real creation dates and doctors:** do you have them, and how many doctors authored the gold notes?
3. **Physician time:** can 2 doctors rate 150 notes (about 10 hours each) for the evaluator, and join a short "Teach Notera" session per specialty?
4. **Separate product:** should Studio live in a new repository from the start (my recommendation after Phase 1) or inside this repo until Phase 6?
5. **Budget** for the tuning experiment and for LLM judging at scale (estimated low hundreds of dollars for the evaluator calibration; tuning cost to be quoted before Phase 5).

## Sources
[Heidi — notes that sound like you](https://www.heidihealth.com/blog/heidi-adapts-to-you) · [Freed templates FAQ](https://www.getfreed.ai/resources/faq-freed-note-templates) · [Abridge confabulation approach](https://hitconsultant.net/2025/08/21/abridge-outlines-approach-to-eliminating-ai-hallucinations-in-clinical-notes/) · [Microsoft Dragon Copilot UX guidelines](https://learn.microsoft.com/en-us/industry/healthcare/dragon-copilot/sdk/get-started/ux-guidelines) · [Nabla — AI medical scribes](https://www.nabla.com/blog/ai-medical-scribes) · [UCLA ambient-scribe trial](https://www.uclahealth.org/news/release/ucla-study-finds-ai-scribes-may-reduce-documentation-time) · [Asgari et al. 2025, npj Digit Med](https://pmc.ncbi.nlm.nih.gov/articles/12075489/) · [Palm et al. 2025, PDQI-9 for AI scribes](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1691499/full) · [PDSQI-9 LLM-judge preprint](https://www.medrxiv.org/node/1085777) · [Suki — PDQI-9 critique](https://origin-www.suki.ai/blog/the-broken-ruler-why-the-healthcare-industry-is-measuring-ai-notes-the-wrong-way-and-what-they-should-be-doing-instead/) · [Gao et al. 2024, learning from user edits (PRELUDE/CIPHER)](https://arxiv.org/pdf/2404.15269) · [WangLab MEDIQA-Chat 2023](https://arxiv.org/abs/2305.02220v2) · [Wang et al. 2024, adapting open models](https://arxiv.org/pdf/2405.00715v5) · [Farquhar et al. 2024, semantic entropy](https://pmc.ncbi.nlm.nih.gov/articles/PMC11186750) · [CliniKnote / K-SOAP](https://www.arxiv.org/abs/2408.14568) · [CLI-RAG](https://arxiv.org/pdf/2507.06715)
