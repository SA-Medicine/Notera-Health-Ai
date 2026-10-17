# Harness scan — scan50 baseline

Run `run_mvcfz4wofd64c5` · writer `gemini-2.5-flash` · 50 gold notes · 2026-10-17T13:45:28.465Z

**Metrics** similarity 0.369 · omission 0.514 · flow 0.867 · coverage 0.930 · p50 5.1s · p95 10.2s · failed 0
**Audit** mean score 61.8/100 · verdicts {"needs_work":31,"good":13,"unsafe":6}

## Overall diagnosis

**The AI writer is fundamentally broken, consistently failing to adhere to basic SOAP structure and producing a high volume of unsafe notes with critical factual errors, hallucinations, and structural chaos.**

This run is a catastrophic failure of the writer stage. Across 40 audited notes, the AI demonstrated an inability to correctly categorize information into Subjective, Objective, Assessment, and Plan sections, leading to disorganized and clinically nonsensical outputs. More alarmingly, there were 9 unsafe notes containing critical errors, including hallucinating medications and dosages, inventing symptoms directly contradicted by the transcript, misattributing the cause of chief complaints, and even merging data from two different patients into a single note. The model appears to be extracting facts as a disconnected list and failing to synthesize them into a coherent, safe, or usable clinical narrative, rendering it unfit for any clinical purpose.

### Patterns
- **Systematic Misplacement of Information into Wrong SOAP Sections** (writer, major, 32/40) — A consistent failure to differentiate between subjective patient reports, objective exam/lab findings, and plan items. This includes placing patient-reported history (weight, past labs) in Objective (10/40), objective findings (exam, X-ray) in Subjective (7/40), past medical history in the current Plan (5/40), and acute medications or HPI details in Past Medical History (8/40).
- **Critical Factual Errors and Hallucinations** (writer, critical, 9/40) — The model generates claims that are either unsupported or directly contradicted by the transcript. This includes inventing a symptom the patient explicitly denied (2/40), stating the wrong cause for a chief complaint (2/40), creating a nonsensical future date ('1929'), hallucinating medications (3/40), and reporting a critical dosage error (1/40).
- **Disorganized and Fragmented Assessment & Plan** (writer, major, 25/40) — The A&P is frequently a chaotic list where treatments are misattributed to the wrong diagnosis (4/40), administrative tasks or procedures are listed as diagnoses (7/40), and a single clinical problem is fragmented into multiple redundant entries.
- **Fragmented, Non-Narrative Subjective/HPI** (writer, major, 16/40) — Instead of a coherent History of Present Illness, the Subjective section is often a bulleted list of disconnected facts, topics, or an agenda for the visit. This makes the patient's story difficult to follow and leads to repetition.
- **Misuse of Past Medical History Section** (writer, major, 15/40) — The PMH section is consistently used as a dumping ground for unrelated information, including social history like occupation and travel (7/40), family history (3/40), and details of the current illness (HPI) (5/40).
- **Omission of Critical Sections or Information** (writer, critical, 10/40) — Entire, essential parts of the note or encounter are missing. This includes omitting the entire Objective section (3/40), omitting a chief complaint discussed at length (1/40), and failing to mention critical diagnoses or medications (e.g., patient is on insulin).
- **Inclusion of Clinically Irrelevant Filler** (writer, minor, 8/40) — The model includes conversational chatter, jokes, or physician self-commentary in the clinical note, making it unprofessional. This includes a physician's personal medical history, a patient's joke about their occupation, and extensive details about family members' lives.
- **Merging Data from Separate Patients** (data, critical, 1/40) — In one instance, the AI included the chief complaint from a second patient who entered the room at the end of the first patient's encounter. This is a critical data segregation failure.

### Recommendations
1. **Halt Use of This Writer Model Immediately** [pipeline/writer, impact high, effort low] — The current writer model (gemini-2.5-flash with 'default' prompt) is producing an unacceptably high rate of unsafe and unusable notes. It should be taken out of production immediately and replaced with a model that has demonstrated basic structural competence and safety.
2. **Rewrite Writer Prompt to Enforce Strict SOAP Structure** [prompt/writer, impact high, effort medium] — The writer prompt must be fundamentally rewritten to enforce the strict separation of S, O, A, and P. It should include explicit, multi-shot examples demonstrating what belongs in each section and, crucially, what does not. For example, show that patient-reported history NEVER goes in Objective, and physical exam findings NEVER go in Subjective.
3. **Add a Pre-Processing Step for Patient Encounter Segmentation** [pipeline/data, impact high, effort medium] — Implement a data pre-processing step to detect and segment transcripts that contain more than one patient encounter. The critical failure in note 'annual-pe-st-inc' shows the model cannot be trusted to handle this boundary on its own. Each segment must be processed as a separate job.
4. **Mandate a Narrative HPI in the Writer Prompt** [prompt/writer, impact medium, effort low] — Explicitly instruct the writer model to synthesize the patient's story into a chronological, narrative History of Present Illness paragraph. Forbid the use of a simple list of topics or an agenda in the Subjective section. Provide examples of transforming conversational dialogue into a clinical HPI.
5. **Consolidate the Assessment & Plan in the Writer Prompt** [prompt/writer, impact medium, effort low] — Instruct the writer to structure the A&P by numbered clinical problem. For each problem, all related actions (meds, labs, referrals, follow-up) must be nested underneath. Forbid the creation of separate 'problems' for administrative tasks, procedures, or follow-ups.
6. **Implement a Post-Processing Guardrail to Check for Missing Sections** [guardrail/cleanup, impact medium, effort low] — Add a deterministic check after the writer stage that validates the presence of 'Subjective', 'Objective', 'Assessment', and 'Plan' headers. If any are missing, the note should be failed or flagged for manual review. This would have caught the 3/40 notes with a missing Objective section.
7. **Strengthen Rules for Social/Family History** [prompt/writer, impact medium, effort low] — Add explicit rules and examples to the writer prompt to differentiate Past Medical History, Family History, and Social History. Instruct the model to filter out clinically irrelevant social chatter (e.g., vacation plans, family members' jobs, jokes).
8. **Improve Medication Spell-Checking and Normalization** [pipeline/cleanup, impact low, effort medium] — The model is transcribing phonetic misspellings ('Pantoloc', 'Spreba'). Implement or improve a normalization layer that maps these common misspellings to their correct generic or brand names before the note is finalized.

Log stats: {"notes_with_logs":50,"verifier_removed":19,"verifier_refused":0,"verifier_skipped":0,"cleanup_removed":13,"checklist_skipped":0,"checklist_merged":42,"dedupe_removed":105,"stage_ms":{"writer+checklist":4596,"verifier":837}}

## Notes

| # | Note | Verdict | Score | Similarity | Omission | Missing | Wrong | Cause |
|---|---|---|---|---|---|---|---|---|
| 1 | mole-bleeding-wt | needs_work | 55 | 0.391 | 0.389 | 3 | 5 | rules |
| 2 | perimeno-symp-hip | needs_work | 55 | 0.464 | 0.342 | 3 | 4 | cleanup |
| 3 | aj-2 | needs_work | 55 | 0.290 | 0.544 | 7 | 7 | writer |
| 4 | wt-plateau-zepbound | good | 85 | 0.288 | 0.681 | 2 | 2 | rules |
| 5 | hyponatremia-leg-heaviness | good | 80 | 0.410 | 0.432 | 4 | 4 | cleanup |
| 6 | annual-pe-st-inc | unsafe | 35 | 0.436 | 0.436 | 5 | 4 | writer |
| 7 | vaccine-catch-up | needs_work | 60 | 0.394 | 0.478 | 4 | 3 | cleanup |
| 8 | session-154302 | needs_work | 55 | 0.217 | 0.786 | 5 | 1 | rules |
| 9 | meds-refills | good | 75 | 0.304 | 0.691 | 2 | 2 | cleanup |
| 10 | wb-2 | needs_work | 65 | 0.276 | 0.655 | 5 | 6 | writer |
| 11 | ar-ea-na-shoulder-lv | unsafe | 35 | 0.365 | 0.483 | 5 | 8 | writer |
| 12 | osteoporosis-hydrocele-r | good | 85 | 0.459 | 0.434 | 2 | 3 | writer |
| 13 | epigastric-pain-crp-elev | needs_work | 65 | 0.381 | 0.489 | 5 | 4 | writer |
| 14 | cervical-polyp-routine | needs_work | 60 | 0.313 | 0.551 | 7 | 5 | writer |
| 15 | insomnia-afib-patient-3009 | needs_work | 55 | 0.269 | 0.573 | 7 | 7 | writer |
| 16 | r-leg-pain-fall | needs_work | 60 | 0.459 | 0.337 | 6 | 6 | writer |
| 17 | shingles-fatigue-bp | needs_work | 65 | 0.358 | 0.529 | 6 | 8 | writer |
| 18 | rosacea-flare-up-rt | good | 85 | 0.329 | 0.633 | 4 | 1 | cleanup |
| 19 | elevated-lymphs-hypothyroid | unsafe | 40 | 0.440 | 0.467 | 4 | 4 | writer |
| 20 | prediabetes-shoulder | good | 85 | 0.486 | 0.306 | 3 | 2 | cleanup |
| 21 | obesity-rt-hand-pain | good | 80 | 0.387 | 0.518 | 5 | 2 | writer |
| 22 | post-biopsy-bleed | needs_work | 65 | 0.324 | 0.642 | 5 | 5 | writer |
| 23 | chest-pain-htn-anemia | good | 80 | 0.416 | 0.460 | 1 | 2 | writer |
| 24 | nasal-spray-bereavement | needs_work | 60 | 0.193 | 0.731 | 4 | 3 | writer |
| 25 | chest-pain-l-leg | needs_work | 55 | 0.440 | 0.402 | 4 | 6 | writer |
| 26 | cervical-arthritis-r-cuff-tear | good | 80 | 0.484 | 0.356 | 4 | 3 | cleanup |
| 27 | 15yo-checkup-labs | good | 78 | 0.420 | 0.512 | 4 | 3 | rules |
| 28 | skin-issue-hydromorphone-refill | good | 80 | 0.357 | 0.531 | 4 | 5 | rules |
| 29 | yeast-inf-breast | needs_work | 65 | 0.349 | 0.560 | 7 | 4 | writer |
| 30 | viral-illness-cough-3 | needs_work | 65 | 0.380 | 0.531 | 2 | 4 | writer |
| 31 | foot-cramps-back-pain | unsafe | 25 | 0.335 | 0.468 | 8 | 7 | writer |
| 32 | dm-l-shoulder-ozempic | needs_work | 55 | 0.435 | 0.410 | 4 | 5 | writer |
| 33 | viral-illness-fever | needs_work | 65 | 0.399 | 0.562 | 5 | 2 | writer |
| 34 | hmb-pallor-t-nail | needs_work | 65 | 0.468 | 0.380 | 3 | 3 | writer |
| 35 | mk-5 | needs_work | 55 | 0.284 | 0.634 | 6 | 4 | writer |
| 36 | session-189395 | unsafe | 25 | 0.243 | 0.697 | 6 | 7 | writer |
| 37 | testo-supp-cyst | needs_work | 60 | 0.354 | 0.505 | 4 | 5 | checklist |
| 38 | cb | needs_work | 55 | 0.442 | 0.359 | 5 | 6 | writer |
| 39 | cyst-cerv-art-dm | needs_work | 60 | 0.357 | 0.557 | 7 | 6 | writer |
| 40 | 1990-08-30 | needs_work | 60 | 0.277 | 0.640 | 5 | 4 | writer |
| 41 | hypercholesterolemia-ezetrol-rx | needs_work | 50 | 0.309 | 0.686 | 2 | 5 | writer |
| 42 | l-bc-abd-swelling | needs_work | 55 | 0.275 | 0.639 | 4 | 5 | writer |
| 43 | routine-prediabetes-weight | needs_work | 65 | 0.376 | 0.415 | 7 | 6 | rules |
| 44 | med-refills-skin | unsafe | 35 | 0.469 | 0.411 | 6 | 5 | writer |
| 45 | meds-refills-furosemide | needs_work | 55 | 0.342 | 0.488 | 4 | 3 | writer |
| 46 | l-wrist-pap-growth | good | 80 | 0.479 | 0.426 | 4 | 4 | cleanup |
| 47 | l-tinnitus-nasal-cong | needs_work | 60 | 0.406 | 0.445 | 3 | 4 | writer |
| 48 | diverticulitis-fatigue-r-t-e | needs_work | 65 | 0.300 | 0.552 | 5 | 6 | writer |
| 49 | f-u-gen-osteopenia | needs_work | 60 | 0.427 | 0.474 | 4 | 6 | writer |
| 50 | low-b12-iron-2 | good | 75 | 0.405 | 0.486 | 3 | 1 | cleanup |

## Per-note detail

### 1. mole-bleeding-wt — needs_work 55/100

The note correctly captured the chief complaint and plan but was poorly structured, miscategorizing extensive social history as Past Medical History and placing pending results in the Objective section.

- similarity 0.391, omission 0.389, 207 words, 4.1s
- MISSING (important): Patient does not shave the area of the mole.
- MISSING (important): Patient reports minimal sun exposure and uses moisturizer on her face.
- MISSING (important): The physician's physical exam finding of a mole under the chin.
- WRONG (major): “Pelvic ultrasound: performed end of January, results pending” — This is not an objective finding from the current visit; it is a historical event with pending results and belongs in the Assessment & Plan.
- WRONG (major): “Sister had melanoma on her back, which was removed” — This is Family History, but it was incorrectly placed under the Past Medical History section.
- WRONG (critical): “Investigations: upper arm and ultrasound” — This is unsupported by the transcript. The patient had a recent pelvic ultrasound, and the plan is a dermatology referral for the mole, not an arm ultrasound.
- WRONG (minor): “denies significant sun exposure” — This is part of the history of present illness, not Past Medical History.
- WRONG (minor): “Referrals: dermatologist” — This is a duplicate entry, listed immediately after "Referrals: Dermatology for evaluation".
- EXTRA: “Occupation: works remotely for short periods” — This is social history incorrectly placed in Past Medical History and is not clinically relevant to the presenting complaints.
- EXTRA: “Travel: travels frequently to visit boyfriend in British Columbia” — This is social history incorrectly placed in Past Medical History and is not clinically relevant to the presenting complaints.
- EXTRA: “Relationship: long-distance relationship with boyfriend in British Columbia, who is a karate teacher and dojo owner” — This is social history incorrectly placed in Past Medical History and is not clinically relevant to the presenting complaints.
- EXTRA: “Family: daughter Sydney will graduate in 1.5 years and plans to go away for school” — This is social history incorrectly placed in Past Medical History and is not clinically relevant to the presenting complaints.
- STRUCTURE: The Past Medical History section is almost entirely composed of irrelevant social history and miscategorized clinical facts.
- STRUCTURE: The Objective section incorrectly contains information about a pending test instead of physical exam findings.
- STRUCTURE: The Subjective section has a redundant heading ("Mole under chin for evaluation") before listing the details of the mole.
- STRUCTURE: The Assessment & Plan section is overly verbose and contains duplicate referral entries.
- likely cause: rules — The AI struggles to differentiate between clinically relevant history (PMH, FamHx) and non-clinical social chatter, and it incorrectly categorizes information within the SOAP format (e.g., pending tests in Objective).

### 2. perimeno-symp-hip — needs_work 55/100

The note correctly captured subjective symptoms and objective lab values but made significant errors in the Past Medical History and Plan, including listing discussed medications as current and creating redundant, poorly structured plan items.

- similarity 0.464, omission 0.342, 209 words, 4.6s
- MISSING (important): Patient has no history of any cancer, not just breast cancer.
- MISSING (critical): The plan includes prescribing progesterone along with the Estrogel.
- MISSING (minor): The patient's mammogram is due next month.
- WRONG (major): “Current medications: estrogel half pump” — This is a new medication being prescribed in the plan, not a current medication in the patient's history.
- WRONG (major): “Current medications: clonidine” — This medication was mentioned as a non-hormonal option but was never prescribed or taken by the patient.
- WRONG (minor): “Son is 13 years old” — This is irrelevant social history placed incorrectly in the Past Medical History section.
- WRONG (minor): “Referrals: physiotherapy for your hip” — This was a previous discussion point, not a new referral made during this visit. It belongs in the Assessment as context, not as a new plan item.
- EXTRA: “Associated Symptoms - Denies severe hot flashes during the day” — This is redundant information, as 'Daytime hot flashes are mild' is already stated.
- EXTRA: “Menopausal symptoms discussed on March 16th” — Redundant; the note is a follow-up from that date, which is already established.
- EXTRA: “Diagnosis: Mammogram overdue” — Duplicate information; the heading 'Mammogram' is sufficient, and the plan item already states it's overdue.
- EXTRA: “4. Hip pain - Referrals: Physiotherapy for hip” — This entire section is a duplicate of the referral mentioned under the 'Menopausal symptoms' plan.
- EXTRA: “5. Follow-up - Treatment: Rtc: in 3 months” — This is a duplicate of the follow-up instructions already listed under the 'Menopausal symptoms' plan.
- EXTRA: “B curve good” — This is non-clinical jargon from the transcript; the gold standard correctly interprets this as B12.
- STRUCTURE: The Assessment & Plan section is poorly organized, with redundant and fragmented items (e.g., three separate items for follow-up, hip physio, and mammogram which could be consolidated under the primary assessment).
- STRUCTURE: The use of 'Diagnosis:' and 'Treatment:' labels within the plan is unconventional and clutters the note.
- STRUCTURE: Information is placed in the wrong sections (e.g., new prescriptions in PMH, social history in PMH).
- likely cause: cleanup — The AI failed to properly structure the note, consolidate related information, and remove redundancies, leading to a fragmented and repetitive plan.

### 3. aj-2 — needs_work 55/100

The note correctly identified most of the patient's numerous and serious complaints, but was poorly structured, highly repetitive, and contained several factual errors regarding timelines and symptom details.

- similarity 0.290, omission 0.544, 484 words, 10.2s
- MISSING (important): Patient has lost 35 lbs total, going from 220 to 185 lbs.
- MISSING (important): Patient's voice has been deteriorating over the last 5-6 months.
- MISSING (important): Patient has 2-3 bowel movements in the morning, which are 'very broken up'.
- MISSING (important): Patient is pale.
- MISSING (important): The chest pain is described as a dull nagging pain that becomes a sharp stabbing pain.
- MISSING (minor): The plan is to refer the patient to a specific cardiologist, Dr. Patient 303, by patient request.
- MISSING (important): Patient was advised to go to the hospital if symptoms worsen.
- WRONG (major): “denies pain with abdominal palpation” — This is an objective physical exam finding and should be in the Objective section, not Subjective.
- WRONG (major): “Infection of heart membrane 1-2 years ago - resolved” — The transcript states the cardiac workup was many years ago (mentions 2009 and 1986), not 1-2 years ago.
- WRONG (minor): “deterioration over 7 months” — This duration is not supported by the transcript. A friend noted deterioration since seeing him in Oct 2017, which is over 1.5 years prior to the visit.
- WRONG (minor): “denies diarrhea” — This is an oversimplification. The patient describes a significant change in bowel habits with 2-3 'very broken up' stools every morning, which is a clinically relevant detail that is lost.
- WRONG (major): “Referrals: Chest pain: had chest pains 1-2 years ago, referred to cardiologist...” — This is a summary of past medical history, not a current referral plan. It is misplaced in the Assessment & Plan.
- WRONG (major): “Rtc: 2 weeks” — The physician states 'I would do want to see you back in 2019-10-20', which is four months away, not two weeks.
- WRONG (minor): “Blood sugar: 5.4-7.6 (patient reported, taken for 10 years)” — The patient mentions taking the test on a specific date ('2007-08-24'), not that he has been taking it for 10 years.
- EXTRA: “Weakness: feeling weak, no strength, no motivation” — Redundant; 'Weakness and fatigue' was already listed as a primary complaint.
- EXTRA: “Appetite: no appetite, no interest in eating” — Redundant; 'Loss of appetite' is a key complaint already captured in the gold note and should be the primary entry.
- EXTRA: “Dizzy spells: not wild, just a little dizzy before walking down basement stairs” — Redundant; 'Dizzy spells' was already listed. This detail belongs with the primary entry, not as a separate duplicative point.
- EXTRA: “difficulty bending finger” — This detail about a resolved finger infection is low-yield for the current presentation and is given too much prominence.
- EXTRA: “Investigations: Halter” — Duplicate; 'Holter monitor' was already listed in the line above.
- EXTRA: “blood pressure: one thirty-four over seventy-six” — Duplicate; the BP was already listed numerically in the same section.
- EXTRA: “heart rate: one eighteen” — Duplicate; the HR was already listed numerically in the same section.
- EXTRA: “Brother-in-law had good luck with the specialist for heart issues” — Filler; this is conversational context for the referral request, not relevant PMH.
- STRUCTURE: The Subjective section is extremely disorganized and repetitive, listing primary complaints and then repeating them with more detail as separate items.
- STRUCTURE: The Assessment & Plan is excessively long and fragmented, creating a separate problem for every single symptom instead of grouping them into a cohesive assessment (e.g., 'Unintentional weight loss with associated symptoms').
- STRUCTURE: Objective findings (e.g., 'denies pain with abdominal palpation') are incorrectly placed in the Subjective section.
- STRUCTURE: Past medical history (e.g., prior chest pain workup) is incorrectly placed in the Assessment & Plan section.
- STRUCTURE: The note includes conversational filler and irrelevant details (e.g., brother-in-law's experience, living in a house with stairs) that detract from the clinical narrative.
- likely cause: writer — The writer stage failed to synthesize and organize information, instead transcribing and repeating facts without clinical structure, leading to a disorganized and redundant note.

### 4. wt-plateau-zepbound — good 85/100

The AI note correctly identified the patient's request and the plan but included redundant information and misplaced the patient's reported weight in the Objective section.

- similarity 0.288, omission 0.681, 51 words, 5.7s
- MISSING (important): Patient has been on Zepbound 7.5mg for a couple of months, longer than the standard 4 weeks.
- MISSING (minor): Patient states they intentionally titrate their dose slowly.
- WRONG (minor): “Objective...Weight is 252 lbs” — This is a patient-reported weight from a phone call, not an objectively measured vital sign. It belongs in the Subjective section.
- WRONG (minor): “Treatment: Discuss increasing Zepbound to 10 mg” — This is incorrect; the decision was made to increase the dose, not to discuss it. The patient called to request the increase.
- EXTRA: “Past Medical History
- Current medications: Zepbound 7.5 mg” — This is redundant; the current medication is already the central topic of the Subjective/HPI section.
- STRUCTURE: The note is overly fragmented for such a brief, single-issue encounter. A combined Assessment and Plan would be more efficient.
- STRUCTURE: The use of a separate 'Associated Symptoms' sub-header in the Subjective section is unnecessary for a single symptom.
- likely cause: rules — The AI seems to be following a rigid template (e.g., all weight goes in Objective, all plans must have a 'discuss' item) without considering the context of a patient-reported phone call.

### 5. hyponatremia-leg-heaviness — good 80/100

The note accurately captured the main clinical issues, especially the hyponatremia, but had significant structural problems with redundant diagnoses and misplaced information.

- similarity 0.410, omission 0.432, 324 words, 9.2s
- MISSING (important): Patient is followed by Dr. Noor for diabetes.
- MISSING (important): Patient has a 30-year history of diabetes.
- MISSING (minor): Patient has not yet obtained the recommended compression stockings.
- MISSING (minor): Patient felt unwell over the weekend with reduced appetite.
- WRONG (major): “BP 128/84 or 134/x yesterday” — This is a patient-reported home blood pressure reading and should be in the Subjective section, not Objective.
- WRONG (minor): “Diagnosis: Leg sores - pending management” — This is inaccurate; management (compression stockings, massage) was recommended at the previous visit and reiterated here. It is not 'pending'.
- WRONG (minor): “Diagnosis: Fatigue and difficulty sleeping - under investigation” — This was the reason for the prior visit and the bloodwork; it is not an active problem being investigated in this encounter.
- WRONG (minor): “Referrals: Referral for vascular assessment due to leg heaviness and pain” — This is a duplicate of the line above it referring to a vascular specialist.
- EXTRA: “Diagnosis: Kidney function - stable” — This is not a diagnosis; it's a lab finding (eGFR) that should be part of the assessment for other conditions like diabetes or hypertension, not its own problem.
- EXTRA: “Diagnosis: Follow-up for blood test results” — This is the reason for the visit, not a diagnosis in the assessment and plan.
- EXTRA: “Diagnosis: Thyroid disorder - managed with Synthroid” — This is a new problem created from a medication mention. While the patient is on Synthroid, it was not a topic of discussion and should be in the PMH, not the A&P.
- EXTRA: “Diagnosis: Diabetes mellitus - followed by endocrinology” — This is a chronic condition that should be listed in the PMH. The plan only mentions continuing insulin, which could be consolidated under a single 'Chronic Conditions' heading.
- STRUCTURE: The Assessment & Plan is excessively long and fragmented, creating separate diagnoses for lab results (Kidney function), reasons for visit (Follow-up), and incidental medication mentions (Thyroid disorder).
- STRUCTURE: Social history (alcohol/drug/tobacco use) is incorrectly placed under 'Associated Symptoms' in the Subjective section.
- STRUCTURE: The Past Medical History is incomplete, missing key details like the duration of diabetes and the fact that the patient is followed by a specialist for it.
- STRUCTURE: The note creates redundant plan items, such as listing the vascular referral twice.
- likely cause: cleanup — The AI created too many separate, redundant, or inappropriate items in the Assessment & Plan instead of consolidating findings and plans under the primary problems.

### 6. annual-pe-st-inc — unsafe 35/100

The note is unsafe as it includes information from a different patient's encounter, has a poorly structured plan, and misses key clinical details.

- similarity 0.436, omission 0.436, 158 words, 4.1s
- MISSING (important): Patient was seen by Dr. Kalaf in 2017 for stress incontinence and declined recommended sling surgery.
- MISSING (minor): Lungs were auscultated and clear.
- MISSING (minor): The FIT test kit will be mailed to the patient's home.
- MISSING (important): The history of stress incontinence is a chronic problem that should be listed in the assessment, noting it is currently asymptomatic.
- MISSING (important): The plan includes a Pap smear to be performed in December.
- WRONG (critical): “Blood pressure check due to broken home machine” — This chief complaint belongs to a different patient who entered the room at the end of the transcript (16:41). Including it is a major privacy and safety violation.
- WRONG (major): “Investigations: PIT test” — This is listed under the 'Physical examination' plan item, but it should be under 'Colon cancer screening'.
- WRONG (minor): “Physical examination” — This is listed as a subjective complaint/chief complaint, but it is the reason for the visit and should be in the HPI.
- WRONG (minor): “2. Colon cancer screening” — This assessment item is listed with no corresponding plan; the plan was incorrectly placed elsewhere.
- EXTRA: “Investigations: Blood test
   - Investigations: Hormone testing” — Duplicate; hormone testing is a component of the blood test ordered.
- EXTRA: “Diagnosis: Routine physical examination” — Padding; this is redundant as the entire section is about the physical exam.
- EXTRA: “Denies moon sweats” — Filler; this is a non-medical, colloquial term used by the clinician and not a standard ROS item.
- STRUCTURE: The Subjective section incorrectly lists the reason for visit and demographic data as patient complaints.
- STRUCTURE: The Assessment & Plan is poorly organized, using non-standard subheadings like 'Investigations' and 'Treatment'.
- STRUCTURE: The plan for colon cancer screening is disconnected from its corresponding assessment.
- STRUCTURE: The note fails to list and address all active and historical problems in the Assessment & Plan (e.g., stress incontinence).
- likely cause: writer — The model incorrectly merged information from two separate patient encounters into one note, a critical failure in patient identification and data segregation.

### 7. vaccine-catch-up — needs_work 60/100

The note correctly identified the reason for visit and vaccines administered, but it completely omitted the Objective section and included duplicate, conflicting information in the plan.

- similarity 0.394, omission 0.478, 174 words, 5.3s
- MISSING (critical): The entire Objective section is missing.
- MISSING (important): Patient's date of birth (2016).
- MISSING (minor): Patient tolerated the procedure with mild discomfort.
- MISSING (minor): Vaccines were administered one in each arm.
- WRONG (major): “Treatment: Vysela second dose” — This is a duplicate and conflicting entry. The transcript and the line above it identify the vaccine as Berivax (Varicella). Vysela is not mentioned in the transcript.
- WRONG (minor): “Berivax (Varicella)” — The transcript states the vaccine was "Berivax" (17:30), but the gold standard note correctly identifies the brand name as Vaxelis. This is a minor transcription/interpretation error.
- WRONG (minor): “Pravnar (pneumococcal 15 vaccine)” — The transcript states "Pravna shot" (17:18), but the gold standard note correctly identifies the brand name as Vaxneuvance. This is a minor transcription/interpretation error.
- EXTRA: “Patient's mother called health unit to clarify required vaccines” — padding
- EXTRA: “Patient's sister, close in age, has complete vaccination records with no issues” — padding
- EXTRA: “Current medications:” — filler
- STRUCTURE: The Objective section is completely missing, which is a critical structural failure for a SOAP note.
- STRUCTURE: The Assessment & Plan section contains duplicate and conflicting information regarding the administered vaccines.
- STRUCTURE: The Subjective section is overly narrative and could be more concise.
- likely cause: cleanup — The model failed to properly structure the note, omitting the Objective section entirely and creating duplicate, conflicting entries in the plan during the final formatting stage.

### 8. session-154302 — needs_work 55/100

The AI note missed the entire subjective section, failed to mention the referral's urgency, and misplaced information from the history of present illness into the past medical history.

- similarity 0.217, omission 0.786, 42 words, 2.6s
- MISSING (critical): The referral needs to be marked as 'urgent'.
- MISSING (critical): A Subjective/HPI section is completely absent.
- MISSING (important): The referral is to the Hand and Upper Limb Center in [LOCATION].
- MISSING (important): The call was with the patient's mother.
- MISSING (minor): The request for referral came after consulting with Dr. Patient 1269.
- WRONG (major): “Broken hand - not connected to current issue” — This information is in the wrong section. The assessment that the current issue is 'not connected' to the past injury belongs in the Subjective/HPI, not under Past Medical History.
- EXTRA: “Referrals: Referral to Hand and Upper Limb Center in for the patient's hand” — This is a duplicate of the plan already stated in the 'Treatment' line directly above it.
- STRUCTURE: The note is missing a Subjective/HPI section, which is a fundamental component of a SOAP note and should contain the reason for the call.
- likely cause: rules — The model failed to apply the basic SOAP structure, omitting the Subjective section entirely and misplacing HPI details into the PMH.

### 9. meds-refills — good 75/100

The note correctly captured the medication refill plan but included duplicated and misspelled medication lists and slightly misinterpreted the plan for follow-up.

- similarity 0.304, omission 0.691, 97 words, 2.9s
- MISSING (important): Patient is unsure when their last blood test was done.
- MISSING (minor): Patient agreed to schedule an appointment for a physical.
- WRONG (minor): “Investigations: Blood tests” — This is an incorrect interpretation. The doctor asked about past blood tests and recommended a physical; they did not order new blood tests at this time.
- WRONG (minor): “Current medications: Selexa 20 milligrams once a day, Deltiazem 120” — This is a duplicate, incomplete, and misspelled medication list that is redundant with the correct list above it.
- STRUCTURE: The Past Medical History section contains a duplicated and incomplete medication list.
- STRUCTURE: The note lacks an Objective section, which should be present and marked as empty or N/A for a phone consultation.
- likely cause: cleanup — The AI failed to remove a redundant and misspelled list of medications, likely generated from a different part of the transcript processing, leading to duplication.

### 10. wb-2 — needs_work 65/100

The note correctly identifies the main diagnosis and plan but has significant structural issues, misinterprets some information, and incorrectly places non-medical details in the PMH.

- similarity 0.276, omission 0.655, 195 words, 5.1s
- MISSING (important): Symptoms have been ongoing for years but are progressively worsening.
- MISSING (important): Patient is unable to sleep on the right side due to shoulder instability.
- MISSING (important): A previous episode of dizziness in 2017 was evaluated at a hospital where a stroke was ruled out.
- MISSING (minor): The patient takes bisoprolol twice a day.
- MISSING (minor): The patient walks 6,000-7,000 steps daily without a cane.
- WRONG (minor): “Drinks one caffeinated soda every other day” — Unsupported. The transcript mentions "one cough coming" which was likely a misinterpretation of the patient saying "one Coke".
- WRONG (major): “Referrals: Referral to surgeon for BP test” — Incorrect. The patient was being sent for a "dye test" (cardiac catheterization) by his cardiologist, not referred to a surgeon for a "BP test".
- WRONG (minor): “Occupation: walks 6-7 miles daily” — This is a lifestyle factor/functional status, not an occupation. The transcript mentions 6,000-7,000 steps, not miles.
- WRONG (minor): “Relationship: married, 50th anniversary soon” — This is social history, not Past Medical History. It is clinically irrelevant social chatter.
- WRONG (major): “Investigations: positional vertigo exercises” — Exercises are a treatment/plan, not an investigation.
- WRONG (major): “Shoulder pain - Diagnosis: Shoulder arthritis” — This is an incomplete assessment. The plan section should mention the renewal of the CPAP machine prescription, which was discussed in the context of the shoulder.
- EXTRA: “Relationship: married, 50th anniversary soon” — filler
- EXTRA: “Blood pressure - Diagnosis: Blood pressure monitoring” — duplicate
- STRUCTURE: The Subjective section is a bulleted list rather than a narrative HPI, making it difficult to follow the story of the illness.
- STRUCTURE: The primary presenting complaint (dizziness) is not prioritized at the top of the Subjective section.
- STRUCTURE: Past Medical History section contains non-medical information (relationship status) and lifestyle factors (walking).
- STRUCTURE: The Assessment & Plan is fragmented, creating a separate problem for 'Blood pressure' when it's related to the dizziness and medication side effects.
- STRUCTURE: The plan for the CPAP machine is missing from the note entirely.
- likely cause: writer — The AI model struggles to structure the note correctly, mixing sections and failing to create a coherent HPI narrative from the conversational transcript.

### 11. ar-ea-na-shoulder-lv — unsafe 35/100

The note is structurally disorganized and contains multiple critical errors, including misattributing treatment plans to the wrong medical problems, making it clinically unsafe.

- similarity 0.365, omission 0.483, 428 words, 6.4s
- MISSING (important): Patient has been taking pantoprazole daily for 3 months (since mid-February).
- MISSING (important): Physiotherapist advised that the shoulder tear is not expected to resolve on its own.
- MISSING (important): Patient notes more visible and protruding veins on legs.
- MISSING (minor): Previous contralateral shoulder surgery was in 2010.
- MISSING (minor): Patient is running out of pantoprazole in about a week.
- WRONG (critical): “Investigations: compression stockings prescription” — This plan for leg pain is incorrectly placed under the 'Acid Reflux' problem.
- WRONG (critical): “Treatment: Avamis nasal spray one spray in each side once a day” — This plan for nasal allergies is incorrectly placed under the 'Acid Reflux' problem.
- WRONG (critical): “Referrals: Shoulder pain: request for orthopedic surgeon referral” — This is a subjective request from the patient, not a plan, and it is incorrectly placed under the 'Acid Reflux' problem.
- WRONG (major): “Treatment: Relieving factors: pantoprazole 40mg daily” — This incorrectly labels a treatment as a 'Relieving factor' within the plan section.
- WRONG (major): “The Subjective section is a fragmented list of single facts rather than a coherent narrative grouped by complaint.” — This structure is inefficient, repetitive, and hard to read, mixing patient requests with clinical history.
- WRONG (minor): “Travel: going to Europe beginning of June, returning around June 20th” — This is social history/context, not Past Medical History.
- WRONG (minor): “Occupation: prolonged sitting at work and driving” — This is social history, not Past Medical History.
- WRONG (minor): “Associated Symptoms... Denies issues with other shoulder” — This is not an 'associated symptom' of the active problems; it is part of the past medical history for the shoulder.
- EXTRA: “Shoulder pain: request for orthopedic surgeon referral” — This is a subjective patient request, not part of the objective plan. It is redundant as the referral is correctly documented in the plan for shoulder pain.
- EXTRA: “The Subjective section contains numerous repetitive bullet points for the same issue (e.g., four separate points for leg pain).” — Redundant information that should be consolidated into a single narrative for each problem.
- EXTRA: “Follow-up... Rtc: end of June” — This is a duplicate entry; follow-up is already mentioned in the plan for Acid Reflux and Leg Pain.
- STRUCTURE: The Assessment & Plan is severely disorganized, mixing plans for different problems under incorrect headings.
- STRUCTURE: The Subjective section is a fragmented, repetitive bulleted list instead of being organized into narrative paragraphs by complaint.
- STRUCTURE: The note incorrectly categorizes social history (travel, occupation) as Past Medical History.
- STRUCTURE: The use of an 'Associated Symptoms' subsection in the Subjective section is confusing and misplaced.
- likely cause: writer — The AI failed to correctly associate assessment and plan items with their corresponding diagnoses, leading to a chaotic and unsafe note structure.

### 12. osteoporosis-hydrocele-r — good 85/100

The note is clinically sound and captures the main points, but has structural errors, includes unprofessional filler, and misses some specific details from the ultrasound report.

- similarity 0.459, omission 0.434, 179 words, 4.4s
- MISSING (important): Ultrasound finding: head of the right testes was not well visualized, likely related to the surrounding fluid.
- MISSING (minor): Ultrasound finding: Left testicle measures 4.5 x 1.8 cm.
- WRONG (major): “Denies pain” — This is incorrect; the patient explicitly states he has "a little bit of discomfort," which is a form of pain.
- WRONG (minor): “Current medications: Porilia” — This is a misspelling of the drug Prolia and is listed redundantly in the Past Medical History section.
- WRONG (minor): “Swelling is the same as last visit” — This contradicts another statement in the note that the swelling is "getting bigger." The transcript indicates it has been getting bigger over time but is stable since the last visit; the note presents this confusingly.
- EXTRA: “Occupation: wife's job and mom's job” — This was a casual, joking remark from the patient and is unprofessional filler that does not belong in the medical record.
- EXTRA: “Follow-up on right testicular swelling
- Follow-up on osteoporosis
- Follow-up on sleeping pills
- Follow-up on colonoscopy appointment” — This list of 'follow-up' items is redundant with the more detailed points that follow and is not standard SOAP note formatting.
- STRUCTURE: Alcohol history is incorrectly placed under Past Medical History instead of Social History or Subjective.
- STRUCTURE: Current medications are listed twice under Past Medical History, one with a spelling error.
- likely cause: writer — The AI writer included conversational filler, misinterpreted a clinical symptom (discomfort vs. pain), and made structural errors in section placement.

### 13. epigastric-pain-crp-elev — needs_work 65/100

The note captured most key data points but misplaced subjective information into the objective section, used unprofessional language for lab results, and had a disorganized, duplicative plan.

- similarity 0.381, omission 0.489, 273 words, 5.8s
- MISSING (critical): Patient reduced Nexium from twice daily to once daily due to significant flatulence, with resolution of symptoms.
- MISSING (important): Patient has a history of uterine ablation, which is why she has no menstrual cycle to assess for menopause.
- MISSING (important): Patient's current weight is stable at 166 lbs.
- MISSING (minor): Patient previously tried turmeric for inflammation without any effect on her CRP levels.
- MISSING (minor): Patient has a history of leg surgery.
- WRONG (major): “Weight gain of 32 pounds in past 6-8 months” — This is a patient-reported symptom (Subjective), not an objective finding measured during the visit.
- WRONG (major): “Sodium: fine
Potassium: fine
Uric acid: fine
Kidney function: fine
Thyroid function: good” — This is imprecise and unprofessional language for lab results; 'normal' is the correct term.
- WRONG (minor): “Mother used hormone patch for menopause” — This is Family History, not the patient's Past Medical History.
- WRONG (minor): “Unable to lose weight despite healthy eating and exercise” — The transcript mentions healthy eating and intermittent fasting, but not exercise. This is an unsupported assumption.
- EXTRA: “Treatment: Started Nexium 40mg” — Duplicate information. The plan already states to continue Nexium; this implies it was just started, which is incorrect.
- EXTRA: “Differentials: Rheumatoid arthritis” — This differential was already ruled out by a rheumatologist, making its inclusion in the current plan confusing and unnecessary.
- EXTRA: “Follow-up on epigastric pain
- Discuss possible menopausal symptoms
- Discuss elevated inflammatory markers
- Discuss weight gain” — This is a list of discussion topics, not a proper HPI. The subjective section should be a narrative of the patient's story.
- STRUCTURE: The Subjective section is a bulleted list of topics rather than a narrative HPI.
- STRUCTURE: The Assessment & Plan is disorganized, with diagnoses and plans mixed illogically (e.g., weight gain is grouped with menopause).
- STRUCTURE: The plan contains redundant and contradictory information (e.g., 'Continue Nexium' and 'Started Nexium').
- likely cause: writer — The AI struggled to synthesize information into the correct SOAP structure, misplacing subjective data, and failed to create a coherent, non-redundant plan.

### 14. cervical-polyp-routine — needs_work 60/100

The note correctly identified the main finding and plan but misplaced several key facts and omitted important patient history.

- similarity 0.313, omission 0.551, 113 words, 3.9s
- MISSING (important): Patient is menopausal, but specifically denies hot flashes, mood swings, or night sweats.
- MISSING (important): Past Medical History of Hypertension and Hyperlipidemia (inferred from medications).
- MISSING (important): Mammogram is up to date.
- MISSING (important): FIT test (poop test) is due.
- MISSING (minor): Patient has upcoming international travel plans.
- MISSING (important): Prescriptions for current medications were provided.
- MISSING (minor): Last blood test was in 2009-07-04 (per gold note, transcript is garbled).
- WRONG (major): “Denies lumps and bumps in breasts” — This is a physical exam finding from the Objective section, not part of the patient's Subjective history.
- WRONG (major): “Denies pain in breasts” — This is a finding on palpation during the physical exam and belongs in the Objective section.
- WRONG (major): “Mammogram” — This is listed under the Objective section but is a historical data point that belongs in the Subjective section.
- WRONG (major): “Stool test” — This is listed under the Objective section but is a historical data point that belongs in the Subjective section.
- WRONG (minor): “Diagnosis: Routine blood work” — Routine blood work is a plan for health maintenance, not a diagnosis.
- EXTRA: “Preventive care” — This is a redundant section header; the items were already addressed under other plan items or should have been in the subjective section.
- STRUCTURE: The Objective section is poorly organized, mixing vital signs with physical exam findings and historical data.
- STRUCTURE: The note incorrectly places physical exam findings (breast exam) into the Subjective section.
- STRUCTURE: The Assessment & Plan uses 'Diagnosis' incorrectly for a planned lab test.
- likely cause: writer — The AI model failed to correctly categorize information into the standard SOAP sections, mixing subjective history, objective findings, and health maintenance status.

### 15. insomnia-afib-patient-3009 — needs_work 55/100

The note correctly identifies the main issues but contains significant structural errors, unsupported claims, and misplaced information, such as including physician commentary in the patient's medical history.

- similarity 0.269, omission 0.573, 169 words, 4.3s
- MISSING (important): The patient is awaiting surgical drainage for his hydrocele with Dr. Patient 1695.
- MISSING (important): The patient has a follow-up cardiology appointment scheduled.
- MISSING (minor): The name of the sleeping pill is 'cubic fifty'.
- MISSING (minor): The patient's wife's current doctor is Dr. Patient 1692, and she is unhappy with him.
- MISSING (important): The physician recommended Dr. Patient 61 as a new doctor for the patient's wife.
- MISSING (minor): A registration form was provided for the patient's wife.
- MISSING (important): The office will call the patient when more samples arrive.
- WRONG (major): “Inquiry about new doctor for the patient” — The inquiry was for the patient's wife, not the patient himself. This is misattributed and confusing.
- WRONG (major): “Physician has been practicing for 55 years” — This is conversational filler from the physician and does not belong in the patient's Past Medical History.
- WRONG (minor): “Slept 7-8 hours on the medication” — This is an unsupported interpretation of garbled numbers in the transcript; the patient never stated a specific number of hours.
- WRONG (minor): “Current medications: cubic 50mg (sleeping pill, as needed)” — This information belongs in a dedicated medications section or the plan, not Past Medical History. The dose '50mg' is also an assumption from 'cubic fifty'.
- WRONG (major): “the patient to call when more samples arrive for collection” — The transcript states the opposite: the physician's office will call the patient when samples arrive.
- WRONG (major): “the patient is open to seeing the specialist” — This is confusingly worded. The patient's wife is open to seeing this physician, not a specialist.
- WRONG (major): “Rtc: 3 weeks” — This is unsupported by the transcript. The gold note states 3 months, which is also not in the transcript. The AI invented this follow-up interval.
- STRUCTURE: Information is poorly organized; physician's personal comments are placed in the patient's PMH.
- STRUCTURE: Medication details are incorrectly placed in the PMH section instead of the plan or a dedicated medication list.
- STRUCTURE: The Assessment & Plan section uses confusing and unprofessional headings like 'the patient new patient inquiry'.
- STRUCTURE: The note fails to clearly delineate between the patient's issues and the secondary request regarding his wife.
- likely cause: writer — The AI failed to distinguish between patient clinical data and conversational filler, and incorrectly attributed information (e.g., the new patient request).

### 16. r-leg-pain-fall — needs_work 60/100

The note correctly identified most chief complaints and recent events but contained significant structural errors, misplaced information, and a major contradiction regarding which leg was symptomatic.

- similarity 0.459, omission 0.337, 409 words, 9.3s
- MISSING (important): Right leg pain is described as constant, 24/7.
- MISSING (important): The right leg pain has been ongoing for over a year to 1.5 years.
- MISSING (important): Patient has a follow-up appointment with neurologist Dr. Spralis on May 1st.
- MISSING (important): The fall caused pain in the left shoulder and left knee, which was noted in the ER report.
- MISSING (important): Patient experiences pain with heel walking.
- MISSING (minor): Patient is unable to walk on tippy-toes due to poor balance.
- WRONG (critical): “Right leg pain: left leg not working correctly, moves halfway then catches toe, leading to tripping and occasional falls” — This is a direct contradiction. The patient clarified that the right leg is the one not working correctly, causing trips.
- WRONG (major): “always tired, taking 3-4 iron tablets daily” — This information belongs in the Subjective section as a patient-reported symptom and medication use, not as an Objective finding.
- WRONG (major): “EMG study (prior): mild peripheral neuropathy, some neuralgia or neural defect in right leg” — This is a historical finding and part of the Past Medical History, not a new Objective finding for this visit.
- WRONG (minor): “Investigations: X-ray of right knee” — This is part of the plan, not a diagnosis or summary point under the 'Fall' assessment. It is also redundant with other items in the plan.
- WRONG (minor): “Treatment: Prescriptions to Old Town pharmacy” — This is an administrative detail, not a clinical plan item. The doctor ultimately states they are printing the prescription, making the pharmacy irrelevant.
- WRONG (minor): “Fall: right leg would not move, tripped and hit a wall, landed on face” — The transcript states "my one leg wouldn't move"; specifying the right leg is an unsupported assumption.
- EXTRA: “Patient is 64 years old.” — This is patient demographic information, not part of the assessment for a specific problem.
- EXTRA: “Chronic right knee pain with associated neuropathy.” — This is a descriptive sentence that is redundant with the diagnosis line directly above it.
- EXTRA: “Etiology of knee pain needs further investigation.” — This is commentary; the plan to order an X-ray and ultrasound already implies this.
- EXTRA: “Chronic fungal infection in skin folds requiring ongoing treatment.” — This is commentary; the diagnosis and plan to prescribe cream are sufficient.
- EXTRA: “Patient requires updated documentation for travel accommodation due to medical conditions.” — This is commentary that is redundant with the plan to provide the letter.
- EXTRA: “Patient reports chronic tiredness and is taking iron supplements.” — This is commentary; the diagnosis and plan are sufficient.
- EXTRA: “Further evaluation of iron status may be warranted.” — This is commentary; it is not part of the explicit plan discussed.
- STRUCTURE: The Assessment & Plan section is poorly organized, mixing diagnoses, patient demographics, commentary, and redundant plan items under each numbered problem.
- STRUCTURE: Objective section incorrectly includes historical data (EMG results) and subjective patient reports (tiredness, iron use).
- STRUCTURE: The AI created a separate problem (#6) for a minor administrative detail (pharmacy change) that was ultimately dismissed in the conversation.
- STRUCTURE: The plan for imaging (X-ray, ultrasound) is listed under the 'Fall' problem, but it is being ordered for the chronic 'Right knee pain' problem.
- likely cause: writer — The model failed to correctly structure the SOAP note, placing historical and subjective data in the Objective section and adding excessive commentary to the Assessment & Plan.

### 17. shingles-fatigue-bp — needs_work 65/100

The note correctly captured many key details but made a critical error regarding the shingles onset, included several wrong or misplaced claims, and had a fragmented, list-like structure that lacked a clear narrative.

- similarity 0.358, omission 0.529, 584 words, 10.4s
- MISSING (important): Patient experiences a significant energy crash daily around 1:30 PM.
- MISSING (important): Patient's weight increased from a baseline of 195-200 lbs to 215 lbs.
- MISSING (important): Patient's mother has diabetes, which is the patient's primary concern for his fatigue and thirst.
- MISSING (important): Patient has two uncles with colon cancer, not one with colon and one with prostate.
- MISSING (minor): Patient works from 9 PM to 11 PM after getting home from the gym.
- MISSING (important): Patient has increased thirst and dry skin.
- WRONG (critical): “Shingles: started 11-12 days ago” — This is incorrect. The patient started medication 11-12 days ago; the shingles rash started about 2-3 weeks prior to the visit.
- WRONG (major): “Uncle: prostate cancer” — Unsupported. The patient explicitly denies a family history of prostate cancer and states two uncles had colon cancer.
- WRONG (major): “Current medications: Valtrex 1000mg three times a day” — Incorrect dose. The patient was taking two 500mg tablets (1000mg total) TID, but the AI note implies a single 1000mg pill TID.
- WRONG (minor): “Pain relieved by Lyrica and Valtrex” — This is an assessment, not a subjective patient report, and should be in the Assessment & Plan.
- WRONG (minor): “Shingles: unable to sleep due to itching” — This is an inference. The patient's current sleep problem is due to a racing mind, not itching from the resolved shingles.
- WRONG (minor): “Patient is resistant to non-medicinal relaxation techniques.” — Unsupported. The patient stated 'I don't know how to do that,' indicating unfamiliarity, not resistance.
- WRONG (major): “Diagnosis: Hypertension - uncontrolled” — This is an incorrect diagnosis for a single elevated reading in a stressful context. 'Elevated blood pressure' is the appropriate assessment.
- WRONG (major): “Investigations: upper scope” — This investigation is listed under the 'Shingles' plan, which is illogical.
- EXTRA: “Shingles: initial presentation of 11 'spider bites' after visiting cousin's house” — The location (cousin's house) is conversational filler and not clinically relevant to the diagnosis of shingles.
- EXTRA: “Occupation: lawyer, partner for 5-6 years” — This level of detail about his partnership status is conversational filler.
- EXTRA: “Shingles rash and pain have resolved with current medication regimen.” — This is a duplicate statement, already implied by the diagnosis 'Herpes zoster (shingles) - resolved'.
- EXTRA: “Blood tests are needed to investigate potential underlying causes.” — This is commentary; the plan to order specific blood tests makes this sentence redundant.
- STRUCTURE: The Subjective section is a fragmented list of bullet points rather than a coherent HPI narrative, making it difficult to follow the patient's story.
- STRUCTURE: The Past Medical History section incorrectly includes social history items like occupation, marital status, and children.
- STRUCTURE: The Assessment & Plan is poorly organized, with investigations for fatigue incorrectly listed under the 'Shingles' plan.
- STRUCTURE: The note uses duplicative subheadings and conversational phrasing (e.g., 'Shingles: started...').
- likely cause: writer — The AI mis-sequenced events (shingles onset vs. medication start), misinterpreted patient statements (resistance vs. unfamiliarity), and struggled to synthesize information into a coherent narrative, opting for a fragmented list format.

### 18. rosacea-flare-up-rt — good 85/100

The note accurately captures the patient's history and plan but misinterprets the dermatology wait time as a follow-up appointment and has some structural redundancy.

- similarity 0.329, omission 0.633, 121 words, 3.1s
- MISSING (important): Patient has discontinued the facial wash that triggered the flare-up.
- MISSING (minor): The dryness around the lips was also potentially attributed to drooling.
- MISSING (minor): Patient tried a different, unspecified ointment before the Metrogel.
- MISSING (minor): The prescription for the oral antibiotic was printed for the patient.
- WRONG (major): “Treatment: Follow-up: four to six weeks” — This is incorrect. The 4-6 week timeframe is the expected wait time for the dermatology referral, not a scheduled follow-up appointment with this provider.
- EXTRA: “Flare-up of rosacea almost two weeks ago” — duplicate, as the first line already states 'Follow-up for rosacea flare-up'.
- EXTRA: “2. Follow-up
   - Treatment: Rtc: after dermatologist appointment (expected in 4-6 weeks)” — This is a redundant section that repeats information already present in the 'Rosacea' plan, creating structural clutter.
- STRUCTURE: The note incorrectly creates a second problem, 'Follow-up', which is redundant and should be integrated into the plan for the primary problem, 'Rosacea'.
- STRUCTURE: The Subjective section is formatted as a list of bullet points rather than a cohesive HPI narrative.
- likely cause: cleanup — The AI failed to properly structure the plan, creating a redundant 'Follow-up' section and misplacing the referral wait time as a follow-up instruction.

### 19. elevated-lymphs-hypothyroid — unsafe 40/100

The note contains a critical error, directly contradicting the patient's report of symptoms, and has significant structural issues with redundancy and incorrect diagnoses.

- similarity 0.440, omission 0.467, 191 words, 8.0s
- MISSING (critical): Patient was unwell with sniffling, coughing, and congestion at the time of the blood test.
- MISSING (important): LDL cholesterol has improved since the last test, but remains elevated.
- MISSING (important): Patient was taking Advil Cold and Sinus at the time of the blood test.
- MISSING (minor): The lab requisition for the repeat CBC has already been faxed to Windsor Medical Labs.
- WRONG (critical): “Denies sniffling, coughing, or congestion at time of repeat blood test” — This is a direct contradiction of the transcript, where the patient explicitly confirms having these symptoms.
- WRONG (major): “Diagnosis: Prediabetes” — This diagnosis is not stated in the transcript; the physician only describes the glucose as 'borderline'.
- WRONG (major): “Diagnosis: Hyperlipidemia - uncontrolled” — This specific diagnosis is not stated in the transcript; the physician notes the LDL is 'still a little higher'.
- WRONG (minor): “Current medications: Advil cold sinus” — This was taken acutely for an illness, not as a current, ongoing medication. It belongs in the HPI/Subjective section.
- EXTRA: “Patient reports feeling that generic Synthroid is not as effective as brand name” — This is a duplicate of the point 'Discussion about generic Synthroid' listed just above it.
- EXTRA: “iron: fine” — This is a duplicate of the lab results already listed in a more structured format above.
- EXTRA: “TSH: fine” — This is a duplicate of the lab results already listed in a more structured format above.
- EXTRA: “LDL cholesterol: three point (high)” — This is a duplicate of the lab results already listed in a more structured format above.
- EXTRA: “sodium: good” — This is a duplicate of the lab results already listed in a more structured format above.
- EXTRA: “kidneys: good” — This is a duplicate of the lab results already listed in a more structured format above.
- EXTRA: “lymphocytes: more almost sixty” — This is a duplicate of the lab results already listed in a more structured format above.
- EXTRA: “Follow-up” — This is a vague, standalone item in the plan with no associated details.
- STRUCTURE: The Subjective section incorrectly uses an 'Associated Symptoms' sub-header for a single, factually wrong denial.
- STRUCTURE: The Objective section is highly redundant, listing lab results in a structured line and then repeating them again in a disorganized, conversational list.
- STRUCTURE: The Assessment & Plan is overly fragmented, creating separate items for 'Synthroid prescription renewal' and 'FIT test' instead of integrating them under the relevant conditions (Hypothyroidism, Health Maintenance).
- STRUCTURE: The note applies formal diagnoses (e.g., 'Prediabetes', 'Hyperlipidemia - uncontrolled') that were not explicitly made by the physician in the transcript.
- likely cause: writer — The model hallucinated a critical negative finding ('denies symptoms') directly opposite to the source transcript, indicating a failure in basic fact extraction.

### 20. prediabetes-shoulder — good 85/100

The AI note accurately captured most key clinical information but was poorly structured with excessive repetition and included some non-essential details.

- similarity 0.486, omission 0.306, 215 words, 5.9s
- MISSING (important): Kidney function is normal.
- MISSING (important): Previous A1c was 6.1.
- MISSING (minor): Patient's parents do not have diabetes.
- WRONG (major): “Diagnosis: Abdominal pain - pending imaging” — The abdominal ultrasound was not ordered for abdominal pain; the reason is not stated in the transcript. This is an unsupported assumption.
- WRONG (minor): “Tetanus shot: last received, due every 10 years” — This belongs in the Assessment & Plan section as an action item, not in Past Medical History.
- EXTRA: “ate a burger, cane, and banana today.” — This is an overly specific daily food log detail that is not clinically relevant for a summary note.
- EXTRA: “Treatment: Follow-up: 6 months” — This is a duplicate of 'Repeat A1C in six months' in the same section and the final 'Follow-up' section.
- EXTRA: “Treatment: Rtc: in six months” — This is a duplicate of the plan to repeat A1C in six months, creating a redundant 'Follow-up' section.
- EXTRA: “Treatment: Refill cholesterol pill; Refill amlodipine; Refill Prolia; Refill gabapentin; Refill Dexilant.” — This is excessively verbose and repetitive. Listing the medications once under a single 'Refill medications' heading is sufficient.
- EXTRA: “Diagnosis: Bladder symptoms - resolved” — While true, creating a separate problem list item for a resolved acute issue discussed in passing is unnecessary padding.
- EXTRA: “Diagnosis: Hemorrhoids - asymptomatic” — Creating a separate problem list item for a chronic, asymptomatic issue is unnecessary padding for this follow-up note.
- STRUCTURE: The Assessment & Plan is excessively fragmented into 8 items, including resolved or minor issues. It should be consolidated into fewer, more clinically relevant problems.
- STRUCTURE: The use of 'Treatment:' as a prefix for every line in the plan is repetitive and stylistically poor.
- STRUCTURE: The 'Associated Symptoms' section in the Subjective is unnecessary and awkwardly placed.
- likely cause: cleanup — The AI failed to consolidate related information, remove redundancy, and structure the Assessment & Plan logically, leading to a fragmented and repetitive note.

### 21. obesity-rt-hand-pain — good 80/100

The note correctly identifies the main problems and the plan to switch from Wegovy to Mounjaro, but it misses key quantitative details about the patient's weight changes and misplaces some information.

- similarity 0.387, omission 0.518, 230 words, 4.5s
- MISSING (important): Patient's max weight loss was 73.8 lbs, reaching a low of 204.2 lbs before gaining 4 lbs in the last week.
- MISSING (important): The elbow brace fit is poor due to weight loss, with one size being too tight and the next size up being too loose.
- MISSING (minor): Patient's goal is to lose another 20-30 lbs.
- MISSING (important): The scalp treatment was successful, which led to the improvement of the lymph nodes.
- MISSING (minor): The plan for hand pain is observation, with no new treatment planned.
- WRONG (minor): “Occupation: works with special needs, involves constant hands-on activities and personal care” — This is Social History, not Past Medical History.
- WRONG (minor): “FIT test” — This is a minor point from the beginning of the transcript and does not warrant its own problem in the Assessment & Plan.
- EXTRA: “Follow-up on weight loss and hand pain
- Discuss options for weight loss medication
- Follow-up on elbow pain
- Follow-up on scalp treatment and lymph nodes
- Follow-up on inflammatory markers and hand X-rays” — The Subjective section is formatted as an agenda or list of topics rather than a narrative of the patient's story (HPI).
- EXTRA: “Treatment: Follow-up: four weeks” — This is a duplicate; there is a dedicated 'Follow-up' section at the end of the plan with the same information.
- STRUCTURE: The Subjective section is a list of topics rather than a proper HPI narrative, which makes it disjointed.
- STRUCTURE: The note creates a separate, unnecessary problem for the expired FIT test in the Assessment & Plan.
- likely cause: writer — The AI structured the Subjective section as a topic list instead of a narrative HPI and missed some of the quantitative details provided by the patient.

### 22. post-biopsy-bleed — needs_work 65/100

The note correctly identified the main clinical issues but contained several inaccuracies from misinterpreting the transcript and had a poorly structured, redundant HPI.

- similarity 0.324, omission 0.642, 176 words, 3.9s
- MISSING (important): Patient self-initiated Septra from a previous prescription with no improvement.
- MISSING (important): Patient is urinating on his own without a catheter.
- MISSING (important): Patient was advised to go to the ER if unable to urinate, as he may need a catheter.
- MISSING (minor): The stat ultrasound order was sent to 'Clear Image'.
- MISSING (minor): The new prescription for Cipro was sent to 'Shoppers'.
- WRONG (major): “Massive bleeding for 2 days after biopsy” — Unsupported. The transcript states there was 'a lot of bleeding' that 'took two days to slow down', not that it was 'massive' for two days.
- WRONG (major): “Bleeding stopped after 4 hours at ER” — Unsupported. This misinterprets the garbled phrase 'took four hours out to work'. The outcome of the ER visit is not specified in the transcript.
- WRONG (minor): “Past Medical History: Bladder biopsy 10 days ago” — Wrong section. This is the reason for the current visit and belongs in the History of Present Illness (HPI).
- WRONG (minor): “Past Medical History: Current medications: ceflexine (completed), Septra (started Sunday)” — Wrong section. These medications are directly related to the presenting complaint and belong in the HPI.
- WRONG (minor): “urine sample: pending” — Wrong section. This is a planned investigation, not an objective finding. It belongs in the Plan.
- EXTRA: “Associated Symptoms - Denies fever - Denies chills - Denies back pain - Denies hard stool” — Redundant. These facts were already mentioned or implied in the main subjective narrative, creating a clunky and repetitive structure.
- EXTRA: “Painful cleaning” — Padding. While true, it's a less clinically significant detail compared to the pain on urination and can be omitted for conciseness.
- EXTRA: “Diagnosis: Follow-up with specialist” — Commentary. This is not a diagnosis; it is a disposition plan. The note correctly lists the follow-up details under 'Treatment'.
- STRUCTURE: The Subjective section is formatted as a disorganized list rather than a narrative HPI, leading to repetition and poor flow.
- STRUCTURE: Pertinent negatives (fever, chills) are unnecessarily separated into a redundant 'Associated Symptoms' subsection.
- STRUCTURE: The Assessment and Plan are combined, but then further broken down into numbered sections with redundant 'Diagnosis' and 'Treatment' labels, making it difficult to read.
- likely cause: writer — The AI model appears to be extracting facts as a list rather than synthesizing them into a coherent clinical narrative, leading to structural issues and placing information in incorrect sections.

### 23. chest-pain-htn-anemia — good 80/100

The note correctly identified all active problems and plans, but the objective section was cluttered with an excessive list of individual blood pressure readings.

- similarity 0.416, omission 0.460, 279 words, 5.0s
- MISSING (minor): Plan to follow up on scheduling for the endometrial ablation.
- WRONG (major): “Bisoprolol was chosen due to clinician's migraine history, but patient has no history of migraines.” — This misinterprets the transcript. The clinician states they take bisoprolol for their own migraines, not that they prescribed it to the patient for that reason. The note makes it sound like the clinician's personal health influenced the patient's prescription, which is an incorrect and unprofessional-sounding inference.
- WRONG (minor): “BP 84/60 in December” — This reading was explicitly discussed and dismissed as a likely machine error in the transcript, but the note includes it without this crucial context.
- EXTRA: “BP 120s/70s-80s at home
- BP 132/88 in December
- BP 132/87 in December
- BP 133/94 in December
- BP 143/96 in December
- BP 84/60 in December
- BP 108/85 at home
- BP 125/82 at home
- BP 122/81 at home” — This is an excessive, uncurated list of every BP reading mentioned. A summary of home readings and the single in-office reading would be sufficient and more professional.
- EXTRA: “Bleeding issues” — Duplicate entry in Past Medical History, as 'Abnormal uterine bleeding' is also listed.
- STRUCTURE: The Subjective section is a list of topics rather than a narrative HPI.
- STRUCTURE: Placing 'Denies migraine headaches' under a separate 'Associated Symptoms' heading in the Subjective section is awkward; it belongs in the context of the hypertension plan.
- likely cause: writer — The AI extracted information too literally without clinical summarization, leading to excessive detail (BPs) and misinterpretation of conversational nuance (migraine reason).

### 24. nasal-spray-bereavement — needs_work 60/100

The AI correctly identified the two main issues but misplaced key information into the wrong sections and missed important details regarding the patient's social support.

- similarity 0.193, omission 0.731, 40 words, 2.5s
- MISSING (important): Patient has a sister for support.
- MISSING (minor): Reactine is obtained over-the-counter from the store.
- MISSING (minor): Mother lived in Windsor.
- MISSING (minor): There will be no funeral, but a celebration of life is planned for a future date.
- WRONG (major): “Past Medical History
- Mother passed away on Saturday, the ninth, at age 79 from liver cancer complications” — This is family history, not the patient's personal past medical history.
- WRONG (major): “Past Medical History
- Current medications: Evamist, Reactin” — This is a medication list, not past medical history. It belongs in a dedicated 'Medications' section or under the Subjective.
- WRONG (minor): “Allergic rhinitis” — This diagnosis is inferred, not explicitly stated in the transcript. While plausible, the note should reflect what was discussed.
- STRUCTURE: The note incorrectly uses the 'Past Medical History' section for family history and current medications, which is a fundamental structural error.
- STRUCTURE: The Subjective section is too sparse, omitting details of the bereavement that belong there.
- likely cause: writer — The AI model seems to have poor understanding of standard SOAP note structure, incorrectly categorizing family history and medications under Past Medical History.

### 25. chest-pain-l-leg — needs_work 55/100

The note correctly identified the main concerns and plan but contained a critical error regarding the location of swelling and several other inaccuracies, along with significant structural and redundancy issues.

- similarity 0.440, omission 0.402, 325 words, 5.9s
- MISSING (important): Patient believes her neuropathy is a result of her prior cancer treatment (chemo and radiation).
- MISSING (important): Patient reports that pain in her leg worsens after she removes compression stockings.
- MISSING (minor): Patient's oncologist is Dr. Rassi.
- MISSING (minor): Patient's endocrinologist is Dr. Chang.
- WRONG (critical): “Evaluation of right-sided swelling and neuropathy” — This is a critical error; the transcript and gold note clearly state the swelling and associated symptoms are primarily on the LEFT side.
- WRONG (major): “Atorvastatin 20mg once a day” — The transcript mentions 'travastatin' (2:40), which is likely a transcription error for rosuvastatin, as correctly captured in the gold note. Atorvastatin was not mentioned.
- WRONG (minor): “A1C: 7.0 (October)
A1C: 7.3 (most recent)” — These are patient-reported lab values from the conversation and should be in the Subjective/HPI, not the Objective section.
- WRONG (minor): “Breast biopsy: negative (last week of)” — This was a patient report of a recent negative mammogram result, not a biopsy, and belongs in the Subjective section.
- WRONG (minor): “Synjardy refill faxed to Walmart” — The clinician explicitly states Synjardy is from Dr. Chang and does not include it in the list of medications they are refilling.
- WRONG (critical): “Right lower extremity: swelling present, tenderness to palpation over blood vessels/circulation” — The physical exam findings of swelling and tenderness were on the LEFT leg, not the right.
- EXTRA: “Current medications: Ezitrol 10 milligrams once a day, Clandesartan 4 milligrams once a day” — This is a duplicate list of medications already mentioned in the same section.
- EXTRA: “Chest pain aggravated by walking” — This is a duplicate of 'Evaluation of chest pain and heaviness with walking' listed just above it.
- EXTRA: “Associated Symptoms
- Right side: retains water, swollen” — This section is redundant with the chief complaints listed above it and incorrectly identifies the side.
- EXTRA: “Follow-up
   - Treatment: Rtc: after stress echo is completed” — This is a duplicate of the follow-up plan already detailed under the 'Chest pain' assessment.
- EXTRA: “Patient has new onset chest pain and heaviness with walking, with a family history of heart issues and personal history of diabetes.” — This is a verbose, narrative restatement of the diagnosis line directly above it, adding no new information to the plan.
- STRUCTURE: The Subjective section is poorly organized with redundant bullet points and a duplicative 'Associated Symptoms' subsection.
- STRUCTURE: Family history (parents' heart issues) is incorrectly placed in Past Medical History instead of a dedicated Family History section or within the HPI.
- STRUCTURE: Patient-reported lab values (A1c) and imaging results (mammogram) are incorrectly placed in the Objective section.
- STRUCTURE: The Assessment & Plan is overly verbose, with redundant narrative descriptions and a separate, duplicative 'Follow-up' section.
- likely cause: writer — The AI model misinterpreted a key clinical fact (left vs. right) and failed to properly structure the note, creating significant redundancy and placing information in incorrect sections.

### 26. cervical-arthritis-r-cuff-tear — good 80/100

The note accurately captured most key findings but suffered from significant repetition and misplaced information, particularly moving physician advice into the subjective history.

- similarity 0.484, omission 0.356, 323 words, 8.0s
- MISSING (important): Patient has not heard back from the Vein Clinic referral from July 2025, despite visiting them in person.
- MISSING (important): Patient had a previous surgery, which was the suspected cause of the stress-related hair loss.
- MISSING (important): HbA1c was 5.9, which is pre-diabetic and the reason for the dietary advice.
- MISSING (minor): Physician advised against traction for the neck if possible.
- WRONG (major): “Right arm: unable to perform heavy lifting or move furniture alone” — This is physician advice from the Plan section, not a subjective complaint reported by the patient.
- WRONG (minor): “Referrals: Follow-up on varicose veins referral” — This is misplaced under the 'Right shoulder pain' section in the plan; it should be under its own problem or a general section.
- WRONG (minor): “Right arm tingling and weakness since February 2nd” — This was the date of the previous visit when the symptoms were discussed, not the onset date of the symptoms.
- EXTRA: “Follow-up on right arm tingling and weakness
- Follow-up on hair loss
- Review blood test results
- Discuss neck and shoulder imaging results
- Follow-up on red spot on skin” — This is a redundant list of topics; the details that follow make it unnecessary padding.
- EXTRA: “Hair loss improved” — Duplicate information. The note already states 'Hair loss resolved' in the same section.
- EXTRA: “Patient has cervical arthritis.” — Duplicate. This is a restatement of the diagnosis already listed in the same section.
- EXTRA: “Triglycerides are elevated.” — Duplicate. This is a restatement of the diagnosis 'Hypertriglyceridemia' in the same section.
- EXTRA: “Red spot on skin is barely visible.” — This is a restatement of the plan to 'Leave alone' and is redundant.
- STRUCTURE: The Subjective section contains significant repetition and includes physician advice that belongs in the Plan.
- STRUCTURE: The Assessment & Plan uses redundant sentences to restate the diagnosis immediately after listing it (e.g., "Diagnosis: Cervical arthritis. Patient has cervical arthritis.").
- STRUCTURE: The plan for the varicose vein referral is incorrectly nested under the shoulder problem.
- STRUCTURE: The use of 'Current medications' in PMH for a supplement (B12) and a topical treatment (Livderm) is imprecise.
- likely cause: cleanup — The AI included redundant phrases and failed to properly sort information between subjective history and the plan, suggesting poor final editing and structural logic.

### 27. 15yo-checkup-labs — good 78/100

The note correctly captured most key elements of the visit but used an unconventional, problem-based structure for a wellness check and miscategorized several items as 'diagnoses'.

- similarity 0.420, omission 0.512, 106 words, 2.8s
- MISSING (important): Patient reports eating a healthy diet and exercising.
- MISSING (minor): Patient denies weight gain (only weight loss was mentioned).
- MISSING (minor): Patient is doing well in school.
- MISSING (minor): The family history of diabetes is on both sides of the family.
- WRONG (major): “Diagnosis: Immunization status” — This is not a diagnosis; it is a status. A more appropriate diagnosis would be 'Immunization due' or it could be included under the 'Health Maintenance' plan.
- WRONG (major): “Diagnosis: Contraception discussion” — This is not a diagnosis; it is an action or counseling topic. It should be part of the 'Health Maintenance' plan.
- WRONG (minor): “Current medications:” — This field was left blank. It should explicitly state 'None' to avoid ambiguity.
- EXTRA: “Discussion of tetanus booster” — This is a heading in the subjective section that is redundant; the information belongs in the PMH (immunization status) and Plan sections.
- EXTRA: “Discussion of birth control pills” — This is a heading in the subjective section that is redundant; the information belongs in the Plan section.
- STRUCTURE: The Assessment & Plan is inappropriately fragmented into three separate 'problems'. A wellness visit should be consolidated under a single 'Health Maintenance' heading, with immunizations, screening, and counseling as sub-points.
- STRUCTURE: The Subjective section uses verbose headings ('Discussion of...') instead of concise bullet points, which is less efficient to read.
- STRUCTURE: The use of 'Associated Symptoms' as a subheading for a review of systems in a well-child check is unconventional.
- STRUCTURE: Family History is incorrectly placed under the 'Past Medical History' section; it should be its own distinct section.
- likely cause: rules — The AI appears to be following a rule to create a separate A&P entry for every topic discussed, which is inappropriate for a consolidated wellness visit note.

### 28. skin-issue-hydromorphone-refill — good 80/100

The AI note accurately captured the patient's history and plan for an oral antibiotic, which the gold standard note missed, but it duplicated information and included misspelled medication names from the transcript.

- similarity 0.357, omission 0.531, 166 words, 5.3s
- MISSING (minor): Patient sees Dr. Amez for lungs.
- MISSING (minor): Patient does not use a sleep apnea machine.
- MISSING (minor): Patient is also on Tylenol.
- MISSING (minor): Patient receives Vitamin D injections every 6 months.
- WRONG (major): “Lantan 100mg twice a day” — This is a transcribed misspelling of an unknown medication; it should be omitted or flagged as unclear.
- WRONG (minor): “Arbatric for bladder” — This is a transcribed misspelling of Mirabegron.
- WRONG (minor): “Pantoloc for stomach” — This is a transcribed misspelling of Pantoprazole.
- WRONG (minor): “Spreba inhalers” — This is a transcribed misspelling of Spiriva.
- WRONG (minor): “Diagnosis: Infected finger lesion” — The physician did not explicitly diagnose an infection, only prescribed an antibiotic for a skin issue. A more appropriate diagnosis would be 'cellulitis' or 'dermatitis'.
- EXTRA: “Current medications: arabatric, pantaloq, Spreba inhalers” — This is a duplicate list of medications already mentioned (with misspellings) in the line above it.
- EXTRA: “Preventive care: Urine test showed no infection” — This is a lab result, not preventive care. It belongs in the Objective section.
- EXTRA: “Follow-up” — This is a standalone, empty heading with no associated information, adding no value.
- EXTRA: “Constipation medication” — This is not a primary or secondary reason for the visit and should be integrated into the main medication plan, not listed as a separate problem.
- STRUCTURE: The Past Medical History section is disorganized, mixing diagnoses, specialists, medications, and lab results under incorrect subheadings like 'Preventive care'.
- STRUCTURE: Medications are listed with transcribed misspellings instead of corrected generic or brand names.
- STRUCTURE: The Assessment & Plan section incorrectly elevates a medication continuation (Docusate) to a primary problem.
- likely cause: rules — The AI appears to be transcribing medication names verbatim without correcting common misspellings and is not properly structuring the PMH section according to standard medical conventions.

### 29. yeast-inf-breast — needs_work 65/100

The note captured key medical history and exam findings but misplaced important information, missed relevant patient context, and included confusingly duplicated entries.

- similarity 0.349, omission 0.560, 206 words, 5.0s
- MISSING (important): Patient is not currently trying to conceive but plans to in the future.
- MISSING (important): Patient felt faint during the examination and had not eaten much for breakfast or lunch.
- MISSING (important): The breast lump from January is no longer present.
- MISSING (important): Patient started sertraline post-pregnancy in January 2022.
- MISSING (minor): Patient's tetanus shot was in May 2023.
- MISSING (minor): Patient's salpingectomy was in May 2023.
- MISSING (minor): Patient's C-section was in March 2022.
- WRONG (major): “Breast ultrasound: January (right breast, 9 to 11 o'clock position, fibroglandular tissue, glandular breast, benign fibrocystic tissue)” — This is a historical finding reported by the patient and confirmed by reviewing a prior report; it belongs in the Subjective/HPI, not the Objective section which is for the current exam's findings.
- WRONG (major): “Ears: some olive oil” — This is incorrect. The physician noted cerumen and recommended olive oil; the finding was not 'some olive oil'.
- WRONG (minor): “Tetanus shot” — This is listed in the PMH without the date (May 2023), making it incomplete and less useful.
- WRONG (minor): “Diagnosis: Routine Pap smear” — A Pap smear is a procedure/screening test, not a diagnosis. The diagnosis should be 'Cervical cancer screening'.
- EXTRA: “Breast ultrasound: (right side)” — This is a vague and confusing duplicate of the more detailed ultrasound finding listed just above it in the same section.
- EXTRA: “Diagnosis: History of breast lump, benign” — This is redundant as the plan section already details the history and findings of the previous ultrasounds.
- EXTRA: “Patient is requesting repeat ultrasound for peace of mind.” — This is commentary. The plan should state the clinical rationale (e.g., surveillance) rather than patient motivation.
- STRUCTURE: The Subjective section is formatted as a list of topics rather than a narrative HPI, which is less standard.
- STRUCTURE: The Assessment & Plan section incorrectly lists procedures (e.g., 'Pap smear performed') and patient requests as diagnoses.
- STRUCTURE: Historical ultrasound results are incorrectly placed in the Objective section instead of the Subjective/HPI.
- likely cause: writer — The model struggles to differentiate between historical data reported by the patient (Subjective) and findings from the current physical exam (Objective), and it has difficulty structuring the A&P correctly.

### 30. viral-illness-cough-3 — needs_work 65/100

The note correctly captured most subjective details and the plan, but it incorrectly stated the patient had a fever and misplaced several key pieces of information.

- similarity 0.380, omission 0.531, 112 words, 3.8s
- MISSING (critical): Patient denies having a measured fever, although they did have chills.
- MISSING (important): The illness has been ongoing for an extended period, with only a few good days.
- WRONG (major): “Started with fever” — This is incorrect; the patient explicitly states they did not measure a fever and 'don't think so' when asked about it.
- WRONG (major): “Objective: No infection noted” — This is a clinician's assessment, not an objective physical exam finding, and belongs in the Assessment section.
- WRONG (minor): “Past Medical History: Current medications: Advil Cold and Sinus” — Home medications should be listed under the Subjective section, not as Past Medical History.
- WRONG (minor): “Follow-up: two weeks” — This misinterprets the instruction to use the inhaler for two weeks as a scheduled follow-up appointment.
- EXTRA: “Evaluation of ongoing illness with productive cough and voice loss” — This is a title or reason for visit, not a subjective patient statement.
- STRUCTURE: The 'Objective' section is misused for an assessment statement, and the 'Past Medical History' section is incorrectly used for home medications.
- STRUCTURE: The 'Associated Symptoms' sub-header is good, but it would be better to integrate these pertinent negatives into the main HPI narrative.
- STRUCTURE: The Assessment heading 'Acute illness' is too generic; 'Viral Illness' or 'Acute Viral URI' would be more specific.
- likely cause: writer — The AI model misinterpreted a direct question about fever as a confirmed symptom and failed to correctly categorize information into the standard SOAP sections (Objective vs. Assessment, PMH vs. HPI).

### 31. foot-cramps-back-pain — unsafe 25/100

The note is structurally chaotic, contains nonsensical filler text, and incorrectly attributes the patient's primary complaint of foot cramping to her back surgery instead of her recent pregnancy, which is a critical error in the history of present illness.

- similarity 0.335, omission 0.468, 455 words, 16.7s
- MISSING (critical): Patient's foot cramping began after having her baby.
- MISSING (important): The foot pain is located in the sole of the feet.
- MISSING (important): Patient has a follow-up scheduled with her back surgeon, Dr. Shamiza.
- MISSING (important): Patient has no known drug allergies.
- MISSING (minor): Patient has an older child who is almost 4 years old.
- MISSING (critical): The Hib vaccine was also administered (Lot UK361AA, expiry 2025-06-22).
- MISSING (important): Patient was advised that the next set of shots are due at 1 year of age.
- MISSING (minor): Patient was advised to use LifeLab for bloodwork as the other local lab is out-of-network.
- WRONG (critical): “Constant on and off foot cramping feeling since back surgery” — This is factually incorrect and clinically misleading. The transcript clearly states the cramping started after she had her baby.
- WRONG (major): “Infant daughter the patient or the patient or the patient or the patient or the patient” — This is nonsensical, auto-generated filler text that makes the note unprofessional and unreadable.
- WRONG (major): “Prolonged menstrual bleeding managed with continuous birth control pills since [date] prescribed by the specialist scheduled for [date] or [date]” — This incorrectly links the specialist for her back pain to the prescription for birth control, which was given by a different doctor (Dr. Rollins).
- WRONG (critical): “Completed infant immunizations on [date]: Quadricel vaccine” — This is incomplete and therefore unsafe. It omits the Hib vaccine that was also administered during the visit.
- WRONG (major): “the patient starting with an eye and taken back-to-back with sugar pills, following and the shot for one cycle after period wouldn't stop for [date] straight” — This is a garbled, ungrammatical sentence placed incorrectly in the Objective section. It belongs in the Subjective/HPI.
- WRONG (minor): “Recent MRI for lower lumbar spine reviewed showing stable mass along the right aspect...” — This information is duplicated, appearing in both the Objective and Past Medical History sections.
- WRONG (minor): “Infant second child present with mother and relative or companion” — Unsupported by the transcript, which does not mention a relative or companion being present.
- STRUCTURE: The Subjective section is a single, unreadable run-on sentence containing nonsensical filler.
- STRUCTURE: The Objective section incorrectly contains large amounts of subjective information (medication history, child's development) and duplicates findings from the PMH (MRI results).
- STRUCTURE: Information is scattered illogically across sections, making it difficult to follow the clinical narrative (e.g., child's development is in Objective, not Subjective).
- STRUCTURE: The Assessment & Plan is incomplete, omitting the ankle tightness and the plan for back pain follow-up.
- STRUCTURE: The note fails to separate the mother's and child's presentations into distinct, clear sections.
- likely cause: writer — The AI writer failed to structure the narrative coherently, mixed subjective and objective data, and introduced nonsensical filler text, indicating a fundamental breakdown in note generation.

### 32. dm-l-shoulder-ozempic — needs_work 55/100

The note correctly identified most key medical issues and plan items but was poorly structured, with misplaced subjective and objective data, and contained redundant information.

- similarity 0.435, omission 0.410, 316 words, 5.3s
- MISSING (important): Patient became more sick after increasing Ozempic to 0.75 mg.
- MISSING (important): Patient's current weight is 257 lbs, down from 273 lbs.
- MISSING (minor): Patient was previously followed for ferritin levels by Dr. Ahmad but has been signed off.
- MISSING (minor): Patient's A1C was 7.0 in Dec 2024, which prompted starting Ozempic.
- WRONG (major): “believes 24 pounds of weight loss was muscle” — This is a subjective patient belief and belongs in the Subjective/HPI section, not Objective.
- WRONG (minor): “well controlled, A1C 5.8 a few days ago” — This is an objective finding but is misplaced in the Objective section as a floating, unlabeled phrase instead of under a 'Labs' or similar heading.
- WRONG (minor): “Left shoulder: pain since ultrasound on February 2nd” — Unsupported. The ultrasound was performed on that date; the transcript does not state the pain began on that date.
- WRONG (minor): “Referrals: Referral to Dr. Tan for melanoma” — This is misplaced under the 'Diabetes management' plan. The referral was already sent and is a separate issue.
- WRONG (minor): “Patient declined pneumonia vaccination today.” — Incorrect. The physician states the patient's shots are up to date from 2024 and does not offer one today.
- EXTRA: “The Subjective section lists multiple redundant points about diabetes (muscle loss, knee pain, difficulty climbing) and the left shoulder.” — duplicate
- EXTRA: “Living situation: on a farm” — padding, redundant with 'Occupation: farmer'
- EXTRA: “Patient is active farmer and cannot stop work.” — padding, this is context for the decision-making but not a core part of the plan itself.
- EXTRA: “Patient does not have physiotherapy coverage.” — padding, this is context but not a direct plan item.
- STRUCTURE: The Subjective section is a disorganized list of bullet points rather than a narrative HPI.
- STRUCTURE: The Objective section is nearly empty and contains subjective information.
- STRUCTURE: Key objective data (A1C, weight) is missing from the Objective section.
- STRUCTURE: The Assessment & Plan mixes diagnoses, patient statements, and plan items without clear separation.
- STRUCTURE: Redundant problem lists are created for issues like Melanoma and Pneumonia vaccination, which are follow-up/status updates rather than active problems addressed in the plan.
- likely cause: writer — The model failed to correctly apply the SOAP structure, misplacing subjective and objective data and creating a fragmented, non-narrative HPI.

### 33. viral-illness-fever — needs_work 65/100

The note captured most subjective symptoms but misplaced the medications, omitted key details about intake, and was missing an entire Objective section.

- similarity 0.399, omission 0.562, 91 words, 2.9s
- MISSING (critical): An Objective section is completely missing, which should at least note the patient's general appearance.
- MISSING (important): Patient has not eaten anything since yesterday evening, not just breakfast.
- MISSING (important): Patient has only consumed water today, refusing other liquids.
- MISSING (important): The specific timing of the medication (Tylenol/Motrin taken yesterday) is not mentioned in the HPI.
- MISSING (minor): The physician's specific impression was 'a virus... a sort of a my flu', which is more specific than just 'Viral illness'.
- WRONG (major): “Past Medical History - Current medications: Tylenol, Motrin” — This is the wrong section. These medications were taken for the current acute illness and belong in the HPI/Subjective section.
- WRONG (minor): “Treatment: Follow-up: 7 days” — This is confusing formatting. The follow-up instructions are part of the plan, not a separate 'treatment'.
- EXTRA: “2. Follow-up - Treatment: Rtc: if no improvement in 7 days” — This is a duplicate of the follow-up advice already listed under the first assessment point, creating a redundant section.
- EXTRA: “Sick visit” — This is a visit type, not a subjective patient complaint. It's filler and doesn't belong in the HPI.
- STRUCTURE: The note is missing an Objective section, which is a standard component of a SOAP note.
- STRUCTURE: The Assessment & Plan is poorly organized, with a redundant, separate 'Follow-up' item.
- STRUCTURE: Using a 'Past Medical History' section for acute medications is incorrect; these should be in the HPI.
- STRUCTURE: Splitting the HPI into a main list and an 'Associated Symptoms' list is unconventional and makes the narrative less cohesive.
- likely cause: writer — The AI failed to adhere to the standard SOAP format, omitting an entire section (Objective) and miscategorizing information (medications).

### 34. hmb-pallor-t-nail — needs_work 65/100

The note correctly captured most key details but made a significant error in documenting the patient's diet and included excessive repetition, which cluttered the subjective section.

- similarity 0.468, omission 0.380, 282 words, 5.0s
- MISSING (critical): Menstrual flow is heavy enough to soak through the thickest pad and pajamas.
- MISSING (important): Periods are regular and occur monthly.
- MISSING (important): Patient has good energy levels despite her mother's concerns about her appearance.
- WRONG (major): “Does not eat much spinach, kale, broccoli, or salads” — This is an incorrect inference; the transcript states the patient eats cucumbers and salads, but does not explicitly deny eating the other vegetables mentioned.
- WRONG (minor): “Nails appear colored” — This is a misinterpretation. The clinician noted the patient's fingernails were colored (likely with polish), which obscured a proper assessment, not that they were a sign of a medical condition.
- WRONG (minor): “Current medications: Teen girl multivitamin (for 1.5 months)” — Vitamins are typically listed under a separate 'Supplements' or 'Medications/Supplements' heading, not mixed with PMH. Also, the PMH section is the wrong place for current medications.
- EXTRA: “Patient has heavy periods” — duplicate
- EXTRA: “Patient is a 13-year-old female” — duplicate
- EXTRA: “Diagnosis: Heavy menstrual bleeding with suspected iron deficiency” — padding, this is a restatement of the section header
- EXTRA: “Diagnosis: Traumatic toenail” — padding, this is a restatement of the section header
- EXTRA: “Treatment: Rtc: after blood test results are available” — duplicate, the plan to follow up was already stated
- EXTRA: “Grade 8 student” — filler, not clinically relevant for the PMH section
- EXTRA: “Plays travel soccer / In school band / In school play” — duplicate, this social history was already correctly placed in the Subjective section
- STRUCTURE: The Subjective section is formatted as a choppy, repetitive list rather than a concise narrative.
- STRUCTURE: The Past Medical History section incorrectly includes current medications, social history (activities), and future preventive care recommendations.
- STRUCTURE: The Assessment & Plan section is verbose, restating the diagnosis from the heading and duplicating the follow-up plan.
- likely cause: writer — The AI writer seems to be extracting facts without synthesizing them into a coherent narrative, leading to repetition and misinterpretation of conversational nuances.

### 35. mk-5 — needs_work 55/100

The note correctly identified the main issues but was poorly structured, contained repetitive information, and misplaced several key clinical facts.

- similarity 0.284, omission 0.634, 235 words, 4.6s
- MISSING (important): Previous colonoscopy in 2021 showed mild diverticular colitis.
- MISSING (important): Physical exam of the left foot showed inflammation and loss of arches.
- MISSING (important): Patient has numbness and foot drop in the right foot, post-hip surgery.
- MISSING (important): Patient previously used orthotics which were initially effective but no longer provide relief.
- MISSING (minor): The left foot pain was worsened by a fall from a stool.
- MISSING (minor): Blood glucose is well controlled.
- WRONG (major): “Associated Symptoms - Left foot pain: denies blood in stool, denies black stools” — These are associated symptoms for the positive FIT test, not the left foot pain.
- WRONG (major): “Associated Symptoms - Left foot pain: denies numbness” — This is incorrect. The patient has numbness in the *right* foot, not the left.
- WRONG (major): “Hemorrhoids: ... cannot cut the lawn without pain” — The inability to cut the lawn is due to foot pain, not hemorrhoids.
- WRONG (minor): “Past Medical History - Exercise: cuts the lawn” — This is an aggravating factor for the foot pain (HPI), not a PMH item.
- EXTRA: “Left foot pain: started since [date]” — The note lists 'Left foot pain' details multiple times in the Subjective section, causing redundancy.
- EXTRA: “Stool test: original test not received” — This is conversational filler and not clinically relevant to the current positive result.
- STRUCTURE: The Subjective section is extremely fragmented and repetitive, with the same complaint (Left foot pain) detailed in two separate places.
- STRUCTURE: The 'Associated Symptoms' subsection incorrectly links symptoms to the wrong chief complaint.
- STRUCTURE: The note failed to include a physical exam section, instead placing an exam finding (X-ray) in the Objective section.
- STRUCTURE: The note is filled with unpopulated '[date]' placeholders, making it incomplete.
- likely cause: writer — The AI writer failed to synthesize information, leading to a fragmented, repetitive note with incorrectly associated symptoms and misplaced information.

### 36. session-189395 — unsafe 25/100

The note contains a critical diagnostic error, incorrectly lists medications the patient has stopped, and omits the patient's new, concerning GI symptoms entirely.

- similarity 0.243, omission 0.697, 174 words, 5.6s
- MISSING (critical): New GI symptoms over the past few months: increased flatulence, softer/skinny stools, more frequent bowel movements.
- MISSING (important): The patient is followed by a specialist for heavy periods.
- MISSING (important): The specific medications for heavy periods are tranexamic acid and mefenamic acid.
- MISSING (minor): The patient was eating 2-3 eggs per day, which she stopped due to high cholesterol.
- MISSING (important): The patient is taking amlodipine for blood pressure.
- MISSING (minor): The patient is not yet in menopause but was previously told her hormone levels indicated she was in a pre-menopausal state.
- WRONG (critical): “Left breast mass - benign fibroadenoma” — This is the wrong diagnosis; the transcript and gold note clearly state it is a benign phyllodes tumor.
- WRONG (critical): “Treatment: Renew prescription for Reactine; Renew prescription for Vitamin D” — The patient explicitly stated she is no longer taking these medications and they should be removed from her list, not renewed.
- WRONG (major): “Current medications: Reactine, amlodipine, mefenamic acid, Vitamin D” — This list is incorrect; the patient is not taking Reactine or Vitamin D (Patient 545).
- WRONG (major): “Current medications: methonamic acid, the patient, the patient” — This is garbled, nonsensical text that appears to be a failed attempt to list medications.
- WRONG (major): “LDL: three point eight” — This was the patient's old LDL value, not the current one. The current value is 3.27.
- WRONG (minor): “Referrals: Doctor.” — This is vague and unhelpful; it should specify the colonoscopy referral to Dr. Mizra.
- WRONG (minor): “Cholesterol was 3.8 in January, now 3.27.” — The transcript states the old value was from 1995-08-06, not January.
- EXTRA: “Ferritin is decreasing” — This is an assessment/finding, not a subjective complaint from the patient.
- EXTRA: “Treatment: reactant (stopped)” — This is confusingly placed under 'Treatment'. It should be noted in the plan to remove it from the medication list.
- STRUCTURE: The Assessment & Plan is poorly organized, mixing diagnoses, treatments, and referrals under a single heading ('Breast health and heavy periods').
- STRUCTURE: The Subjective section is a list of topics rather than a narrative of the patient's story and symptoms.
- STRUCTURE: The Objective section contains a mix of current and past lab values without clear distinction.
- STRUCTURE: The Past Medical History section incorrectly lists medications the patient has stopped as 'current'.
- STRUCTURE: The note completely omits the entire GI portion of the consultation, which was a key reason for the visit.
- likely cause: writer — The AI failed to synthesize information correctly, made a critical diagnostic error, hallucinated medication renewals against patient statements, and omitted a chief complaint.

### 37. testo-supp-cyst — needs_work 60/100

The note correctly captures the reason for visit and plan, but misplaces several key facts into the wrong sections and includes redundant information.

- similarity 0.354, omission 0.505, 187 words, 5.4s
- MISSING (important): Patient's height is 6'1".
- MISSING (important): Patient's starting weight was 280 lbs and current weight is approximately 230 lbs.
- MISSING (important): The main motivation for testosterone is for energy and to combat mental fatigue, especially when dieting.
- MISSING (minor): The coach's recommendation was to get full blood work including testosterone, estrogen, and DHEA.
- WRONG (major): “Associated Symptoms - Denies need for specialist appointment” — This is not an associated symptom. It is a historical fact from a previous visit and is placed out of context.
- WRONG (major): “Treatment: Diet: 190mg of carbs daily when cutting, mostly rice” — This is part of the patient's history (HPI/Subjective), not a treatment or plan prescribed by the physician.
- WRONG (minor): “Past Medical History - Preventive care: Blood test reviewed previously with good results” — This is a summary of a recent encounter, not a past medical history item. It belongs in the HPI/Subjective.
- WRONG (minor): “Diagnosis: Request for testosterone and hormone evaluation” — This is the reason for the visit, not a medical diagnosis. It should be the title of the assessment item.
- WRONG (minor): “Referrals: Endocrinologist referral discussed if levels are normal and patient still desires supplementation” — The transcript states the referral would be considered, but doesn't specify the condition of normal levels. The physician says "I can ask the endocrinologist to see you, see if he can help us out with that."
- EXTRA: “Investigations: hormones” — This is a duplicate, as the specific hormone tests are listed on the line directly above it.
- STRUCTURE: The note incorrectly uses an 'Associated Symptoms' sub-header for a historical fact.
- STRUCTURE: Subjective patient history (diet details) is incorrectly placed in the Assessment & Plan section under 'Treatment'.
- STRUCTURE: The Past Medical History section is misused to summarize a recent visit's events rather than chronic conditions.
- STRUCTURE: The Assessment & Plan section uses a 'Diagnosis' field for what is actually the chief complaint.
- likely cause: checklist — The AI seems to be filling a template without understanding the clinical context, leading it to misclassify information (e.g., putting diet history in the plan, and a past event as a current symptom).

### 38. cb — needs_work 55/100

The note correctly identified the main clinical issues but contained a significant fabricated claim, structural errors, and was highly redundant.

- similarity 0.442, omission 0.359, 269 words, 5.3s
- MISSING (important): Patient does not want compression stockings, prefers water pill.
- MISSING (important): Psychiatrist (Dr. Patient 123) advised to continue current medications.
- MISSING (important): Patient is also diagnosed with paranoia.
- MISSING (minor): The specific name of the water pill (Furosemide) is not mentioned in the transcript, only the dose.
- MISSING (minor): Patient's potassium was normal on last blood test.
- WRONG (critical): “Finished water pill 3 days ago” — This is a complete fabrication. The transcript contains nonsensical dates for the last dose, but '3 days ago' is not mentioned and is factually incorrect.
- WRONG (major): “Mild arthritis in both hips, left greater than right” — This is an objective finding from an X-ray result and is incorrectly placed in the Past Medical History section.
- WRONG (major): “Referrals: Doctor the patient” — This is a nonsensical, garbled entry under the Leg Swelling plan, likely a transcription error that was copied verbatim without interpretation.
- WRONG (major): “Patient has appointment with cardiologist on 24th of October” — The transcript states the appointment with Dr. Patient 124 (vascular) is on the 24th. The cardiology appointment is on a different date.
- WRONG (major): “Patient has appointment with vascular specialist on 2nd of October” — The transcript states the appointment with the cardiologist (Dr. DG) is on the 2nd. The AI has swapped the dates for the cardiology and vascular appointments.
- WRONG (minor): “Current medications: CiproMex for depression and anxiety...” — The medication name is Cipralex, not CiproMex. This is a transcription error that was not corrected.
- EXTRA: “Swelling has come down a lot” — duplicate, already stated as 'Leg swelling much better'
- EXTRA: “Pain is less frequent, now once a day instead of a couple times a day” — duplicate, already stated as 'Taking Tylenol once a day... previously a couple times a day'
- EXTRA: “X-ray hips: mild arthritis in both hips, left greater than right” — duplicate, this finding is listed in both the PMH and Objective sections
- EXTRA: “Referrals: Referral to Dr. DG for cardiac assessment” — duplicate, this is listed under its own 'Cardiac assessment' heading and does not need to be a separate item
- EXTRA: “Referrals: Referral to the specialist for vascular assessment” — duplicate, this is listed under its own 'Vascular assessment' heading and does not need to be a separate item
- STRUCTURE: The Subjective section is highly redundant, repeating the same facts in different ways.
- STRUCTURE: Objective findings (X-ray results) are incorrectly placed in the Past Medical History.
- STRUCTURE: The Assessment & Plan is poorly organized, breaking out referrals into separate, redundant problems instead of integrating them into the plan for the primary problem (leg swelling).
- STRUCTURE: The note uses informal language like 'fine' for the echocardiogram result.
- likely cause: writer — The AI failed to synthesize information, leading to high redundancy, and hallucinated a key fact ('3 days ago') instead of flagging the nonsensical dates in the source data.

### 39. cyst-cerv-art-dm — needs_work 60/100

The note correctly identifies the main clinical issues but contains a significant medication error and misplaces objective findings in the subjective section.

- similarity 0.357, omission 0.557, 160 words, 6.6s
- MISSING (critical): Patient is on insulin for diabetes.
- MISSING (important): Patient has only one or two perindopril tablets remaining.
- MISSING (important): The infected cyst is on the right side.
- MISSING (important): Patient was advised to take B12 supplements for a low level.
- MISSING (important): HbA1c is 8.3, which is elevated.
- MISSING (important): Plan to dispense perindopril to the patient directly from the clinic.
- MISSING (minor): Plan to follow up with Dr. Patient 409 for diabetes management.
- WRONG (critical): “Blood pressure medication: running out of perindopril and amlodipine” — The transcript only mentions perindopril. Amlodipine was not mentioned and appears to be an incorrect inference or invention.
- WRONG (major): “Neck: severe arthritis noted on X-ray” — This is an objective finding from an imaging report and should be in the Objective section, not the Subjective.
- WRONG (major): “Neck: disc space narrowing at C4-C5 and C5-C6” — This is an objective finding from an imaging report and should be in the Objective section, not the Subjective.
- WRONG (major): “Neck: osteophyte formation at C4-C5 and C5-C6” — This is an objective finding from an imaging report and should be in the Objective section, not the Subjective.
- WRONG (major): “Investigations: CT scan” — The transcript mentions a CT scan was supposed to be done in the past, but the plan in this visit is to refer to the Pain Clinic, not order a new CT scan.
- WRONG (minor): “Preventive care: B12 supplements” — This is a treatment for a diagnosed deficiency (low B12), not preventive care. It should be in the Assessment & Plan.
- EXTRA: “sugar: eight point three” — This is a duplicate of 'Blood test: sugar 8.3' listed just above it in the Objective section.
- EXTRA: “Tetanus shot due, patient not worried about it” — This was a tangential comment dismissed by the physician in the transcript and is not a core part of the patient's current medical history or plan.
- EXTRA: “Cyst: bandage removed” — This is a minor, conversational detail that adds little clinical value to the note.
- STRUCTURE: Objective findings (X-ray results) are incorrectly placed in the Subjective section.
- STRUCTURE: The Assessment & Plan is underdeveloped, lacking specific diagnoses (e.g., Hypertension), lab values (HbA1c), and key actions (dispensing medication, B12 advice).
- STRUCTURE: The Subjective section is formatted as a list of facts rather than a narrative of the patient's story, mixing chief complaints with specific details.
- STRUCTURE: The Past Medical History section incorrectly includes a planned action (B12 supplements).
- likely cause: writer — The model incorrectly inferred a medication (amlodipine) and struggled to correctly structure the SOAP note, mixing subjective and objective information.

### 40. 1990-08-30 — needs_work 60/100

The note correctly captured some key subjective points and objective findings but misplaced important history, duplicated medication information, and incorrectly assigned treatments to diagnoses in the plan.

- similarity 0.277, omission 0.640, 133 words, 3.3s
- MISSING (important): Patient has labored breathing and a barking/"packy" cough.
- MISSING (important): Patient was initially coughing so hard she was vomiting.
- MISSING (critical): Plan includes a course of oral antibiotics, 1 tsp three times a day.
- MISSING (minor): Plan includes encouraging lots of fluids.
- MISSING (minor): Prescriptions were faxed to the pharmacy.
- WRONG (major): “Current medications: blue inhaler two or three every four to six hours” — This is part of the new plan, not a medication the patient was taking upon arrival.
- WRONG (critical): “Treatment: fluvant once one spray twice a day” — This is listed as a treatment for the ear infection, but it is for the bronchospasm.
- WRONG (major): “Treatment: inhaler one inhalation twice a day” — This is a duplicate of the Flovent/Fluvent instruction and is incorrectly listed under the ear infection diagnosis.
- WRONG (minor): “Rtc: in 7 days” — The transcript states follow-up in '2024-03-13', which is a placeholder for one week, but the AI note incorrectly lists this under a separate 'Follow-up' heading instead of integrating it into the overall plan.
- EXTRA: “coughing so hard, she was throwing up from it” — This is a good detail, but it's already implied in the HPI. It could be integrated better rather than being a standalone bullet point.
- EXTRA: “Follow-up” — This is an unnecessary subheading in the plan; the RTC instruction should be part of the overall plan.
- STRUCTURE: Family history (mother's asthma) and social history (daycare) are incorrectly placed in the Past Medical History section instead of the Subjective/HPI.
- STRUCTURE: The plan incorrectly separates diagnoses from their corresponding treatments, leading to confusion (e.g., assigning an inhaler to an ear infection).
- STRUCTURE: The AI note creates a separate 'Follow-up' section in the plan, which is unconventional; follow-up instructions should be part of the main plan.
- likely cause: writer — The AI model failed to correctly associate treatments with diagnoses and misplaced key historical information into the wrong sections of the note.

### 41. hypercholesterolemia-ezetrol-rx — needs_work 50/100

The note incorrectly diagnoses 'uncontrolled' hyperlipidemia, uses a medication refill as a diagnosis, and has poor structural organization.

- similarity 0.309, omission 0.686, 41 words, 2.6s
- MISSING (important): The prescription for Ezetrol was faxed to a pharmacy in Essex.
- MISSING (minor): Patient was advised to get the blood work done whenever she has time.
- WRONG (major): “Diagnosis: Hyperlipidemia - uncontrolled” — This is an unsupported clinical judgment; the transcript states there are no recent lab results, so control status is unknown.
- WRONG (major): “Ezetrol refill” — This is listed as a second problem in the Assessment/Plan, but it is the treatment for the primary problem (Hyperlipidemia), not a separate diagnosis.
- WRONG (major): “Diagnosis: Ezetrol - needed refill” — A medication refill request is not a medical diagnosis.
- WRONG (minor): “Treatment: Prescription faxed to Gladysin” — The transcript is ambiguous ('Fax to hold on to Gladysin'), and it is unclear if this is a person or a pharmacy. The gold standard correctly identifies it as 'pharmacy in Essex'.
- WRONG (minor): “Treatment: Lab requisition faxed to Guardian in Essex” — This is an investigation, not a treatment. It is misplaced under the 'Treatment' subheading.
- EXTRA: “Cholesterol check” — This is a topic of conversation, not a subjective complaint from the patient. The patient's request was for a refill.
- STRUCTURE: The Assessment and Plan is poorly organized, incorrectly splitting the plan for a single problem into two separate diagnoses.
- STRUCTURE: Using a medication refill request as a 'diagnosis' is incorrect formatting for a medical note.
- STRUCTURE: The Subjective section is a list of topics rather than a concise patient-centered summary.
- likely cause: writer — The AI model made an unsupported clinical inference ('uncontrolled') and failed to correctly structure the assessment and plan, treating a medication as a separate diagnosis.

### 42. l-bc-abd-swelling — needs_work 55/100

The AI note correctly identified the main complaints but contained a major error regarding the mammogram date and misinterpreted a key part of the past medical history.

- similarity 0.275, omission 0.639, 113 words, 3.1s
- MISSING (important): Patient reports swelling has been present for approximately 3 weeks.
- MISSING (important): Patient is performing regular breast self-examinations and has not noted any lumps or bumps.
- MISSING (minor): Patient sees a rheumatologist for her high risk of osteoporosis.
- MISSING (minor): Patient ran out of her letrozole supply from her specialist.
- WRONG (major): “last mammogram May 2020” — The transcript states the next mammogram is due May 2026 (the year of the visit); this is a significant dating error.
- WRONG (major): “High-risk scope” — This is a nonsensical phrase transcribed from a garbled part of the conversation; the clinical context indicates 'high risk for osteoporosis'.
- WRONG (major): “Patient has been on letrozole for 10 years, started January 2017, with recommended duration until January 2027.” — This is contradictory. If started in 2017, she has been on it for ~9 years, not 10. The note should state the plan is for a total of 10 years.
- WRONG (major): “Investigations: abdomen and pelvic ultrasound” — This investigation is for the abdominal swelling, but it is incorrectly placed under the 'Letrozole refill' plan.
- WRONG (minor): “Treatment: Follow-up: Six months” — This follow-up was mentioned in the context of the specialist's note being read aloud, not as a plan from this specific visit.
- EXTRA: “Current medications: letrozole 2.5mg daily” — This is a duplicate entry in the Past Medical History section.
- STRUCTURE: The Assessment & Plan section is poorly organized, mixing investigations for one problem into the plan for another.
- STRUCTURE: The note uses a non-standard 'Associated Symptoms' sub-header in the Subjective section.
- STRUCTURE: The Past Medical History section has duplicate 'Current medications' headers.
- likely cause: writer — The AI failed to synthesize information correctly, misinterpreted garbled audio, and misplaced information within the note structure.

### 43. routine-prediabetes-weight — needs_work 65/100

The note correctly captured the main discussion points but was poorly structured, contained misplaced information, and missed several key clinical details.

- similarity 0.376, omission 0.415, 309 words, 5.9s
- MISSING (critical): Prediabetes (A1C 6.1) is not listed as a diagnosis in the PMH or Assessment.
- MISSING (important): The plan to recheck A1C with the ordered bloodwork is not mentioned.
- MISSING (important): The patient's BMI of 27 is not documented.
- MISSING (important): The date of the last FIT test (June 2023) and when it is next due (June 2025) is missing, noted only as 'done, next one due'.
- MISSING (important): The patient's chief complaint of difficulty with nighttime eating/snacking is not mentioned in the assessment for weight management.
- MISSING (minor): The date of the last Pap smear and when it is due (June 2026) is not fully specified.
- MISSING (minor): The date of the last colonoscopy (2015) is missing.
- WRONG (minor): “A1C: 6.1 (January, last year)” — The transcript does not state the A1C was from 'last year'; this is an unsupported assumption.
- WRONG (minor): “Occupation: works at a pharmacy” — This is social history and is incorrectly placed in the Past Medical History section.
- WRONG (minor): “History of oral herpes (cold sore) on upper lip” — This was a recent acute issue discussed by the patient, not a chronic condition for the Past Medical History section.
- WRONG (minor): “Patient has good insurance coverage for weight loss medications.” — This is background information and does not belong in the Assessment & Plan.
- WRONG (minor): “Treatment: Follow-up: in a month” — This is a duplicate of the item under the 'Follow-up' heading.
- WRONG (minor): “Diagnosis: Need for orthotics” — This is not a medical diagnosis; it should be framed as a plan to provide a requested prescription.
- EXTRA: “breakfast: bacon, egg on 45-calorie bread - lunch: zucchini lasagna, sandwich on 45-calorie bread (ham, cheese, mustard), yogurt, cucumbers, vegetables” — Excessive, non-essential detail for the subjective section; a summary of diet efforts would suffice.
- EXTRA: “Mammogram: passed, everything good (last year)” — This is a result and belongs in the Subjective section as part of the interval history, not Objective.
- EXTRA: “Sleep study: no sleep apnea (last year)” — This is a result and belongs in the Subjective section as part of the interval history, not Objective.
- EXTRA: “Colonoscopy: no polyps” — This is a result and belongs in the Subjective section as part of the interval history, not Objective.
- STRUCTURE: The note is poorly organized, with information scattered across incorrect sections (e.g., patient-reported history in Objective, social history in PMH).
- STRUCTURE: The Assessment & Plan is fragmented and contains redundant information (e.g., two separate follow-up plans).
- STRUCTURE: The use of subheadings within the Subjective section (e.g., 'Diet', 'Weight') is unconventional and makes the note harder to read.
- STRUCTURE: The Assessment section lacks a clear, consolidated list of diagnoses being addressed.
- likely cause: rules — The model struggles with the fundamental rules of SOAP note structure, consistently misplacing information into the wrong sections.

### 44. med-refills-skin — unsafe 35/100

The note contains a critically unsafe medication dosage error and misplaces subjective information into the wrong sections, though it does capture most of the key medical problems.

- similarity 0.469, omission 0.411, 226 words, 8.1s
- MISSING (important): Patient is followed by Dr. Mishra every 4-6 months for PBC.
- MISSING (important): Patient is followed by Dr. Fain for macular degeneration.
- MISSING (important): An echocardiogram was ordered by cardiology for aortic stenosis.
- MISSING (important): Patient receives Prolia injections every 6 months.
- MISSING (important): Alkaline phosphatase was not tested on recent bloodwork and needs to be reordered.
- MISSING (important): Patient tried cannabis gummies for sleep, had a bad experience with flashbacks, and will not try them again.
- WRONG (critical): “Synthroid 1000mcg” — This is a critically incorrect and dangerous dose, likely a transcription error for 100mcg. The AI should not have documented such an extreme, non-standard dose without flagging it.
- WRONG (major): “Discussion of vaccinations” — This is an action performed by the physician (part of the Plan), not a subjective complaint from the patient.
- WRONG (major): “Evaluation of skin lesion” — This is an action performed by the physician (part of the Assessment/Plan), not a subjective complaint from the patient.
- WRONG (minor): “Echocardiogram” — This is listed under the Objective section, but it is a planned investigation, not a result that was reviewed. It belongs in the Plan.
- WRONG (minor): “A1C: five” — This is a duplicate of the blood test results already listed in the same section.
- EXTRA: “Current medications: blood pressure pill half a pill every day” — This is a duplicate entry, as the medication list above it already includes 'blood pressure medication (half a pill daily)'.
- EXTRA: “Age: 77 years” — This is demographic data, not a past medical history diagnosis.
- EXTRA: “Still working” — This is social history, not a past medical history diagnosis.
- STRUCTURE: The Subjective section is missing the HPI for the patient's insomnia (how she takes her zopiclone, her experience with gummies) and instead contains items that belong in the Assessment and Plan.
- STRUCTURE: The Past Medical History section is cluttered with demographic data, social history, and a redundant medication list.
- STRUCTURE: The Assessment & Plan is missing diagnoses for aortic stenosis and PBC, which were discussed and have ongoing plans.
- likely cause: writer — The model failed to correctly categorize information into the appropriate SOAP sections and transcribed a critically incorrect medication dose from a flawed transcript without any apparent clinical judgment.

### 45. meds-refills-furosemide — needs_work 55/100

The note correctly identified most medications for refill but included a significant dosage error for a key blood pressure medication and had structural issues with duplicate sections.

- similarity 0.342, omission 0.488, 86 words, 2.7s
- MISSING (important): Seneca pot (Senokot) refill was requested.
- MISSING (important): The plan is to monitor with blood work 'as needed' or 'periodically' for the furosemide.
- MISSING (minor): The patient's representative requested the refills on the patient's behalf.
- MISSING (minor): Nifedipine is taken as half of a 60 mg tablet.
- WRONG (critical): “candesartan 16mg once daily” — This is a critical dosage error. While 16mg was mentioned, the physician's final clarifying question was 'candy cartin 60 milligrams, yes?' to which the caller agreed. The gold note also confirms 60mg.
- WRONG (major): “Zoloft” — Unsupported. The caller said 'cancer Zoloft' which was likely a misstatement for Candesartan. Zoloft (sertraline) was never confirmed or discussed as a medication for this patient.
- WRONG (minor): “Diagnosis: Need for diuresis - pending assessment” — This is an invented diagnosis and status. The reason for starting furosemide was a recommendation from another physician (Dr. Kular), not a pending assessment by this clinician.
- EXTRA: “Current medications: Vantolin” — duplicate, as Ventolin is already listed in the preceding medication list.
- EXTRA: “Refill Zoloft” — This is incorrect and unsupported, as Zoloft was not a confirmed medication.
- EXTRA: “Attica” — This is a duplicate of Candesartan, which is the generic name for Atacand.
- STRUCTURE: The Past Medical History section has two separate, duplicative 'Current medications' lists, which is confusing and poorly formatted.
- STRUCTURE: The Assessment & Plan section lists medications individually for refill, which is verbose. A summary statement would be more concise.
- STRUCTURE: The note lists brand (Attica) and generic (candesartan) names as if they are separate medications.
- likely cause: writer — The AI failed to synthesize conflicting information, picking an earlier, incorrect dose for Candesartan and misinterpreting a misspoken drug name ('cancer Zoloft') as a real medication.

### 46. l-wrist-pap-growth — good 80/100

The note accurately captured the main clinical facts and plan but was poorly structured with redundant sections and some minor inaccuracies.

- similarity 0.479, omission 0.426, 186 words, 4.9s
- MISSING (important): Patient has not seen a dermatologist in approximately 50 years.
- MISSING (important): Patient reports recent nephrology follow-up was good, with recommendation for 1-year follow-up.
- MISSING (minor): Patient reports good blood pressure and blood sugar.
- MISSING (minor): The steroid cream used was originally prescribed for a foot callus.
- WRONG (minor): “Previous wart on hand” — The transcript and gold note specify the previous wart was on the wrist, not the hand.
- WRONG (minor): “Treatment: Follow-up: 2 to 3 weeks” — This is not a treatment. This is the timeframe for the patient to call if they haven't heard about their dermatology appointment, and it belongs in the patient instructions part of the plan.
- WRONG (minor): “Referrals: Dr. Yousuf” — This is a duplicate entry, as 'Referrals: Dermatology for biopsy' is listed right above it.
- WRONG (minor): “Prescriptions to be printed for patient to pick up in a couple of weeks” — The patient said they could wait a couple of weeks to pick them up, not that the prescriptions should be printed in a couple of weeks. They were printed at the visit.
- EXTRA: “Lump is not growing at a fast pace
- appears to be the same size” — duplicate
- EXTRA: “Associated Symptoms” — padding, this section is unnecessary and its contents should be integrated into the HPI.
- EXTRA: “Follow-up” — padding, this is an empty, unnecessary section header.
- STRUCTURE: The Subjective section is fragmented and repetitive, using two separate bulleted lists where one would suffice.
- STRUCTURE: Information is misplaced; patient's nephrology follow-up and BP/sugar status are in the 'Medication refills' plan section instead of the Subjective/PMH.
- STRUCTURE: The Assessment & Plan section has redundant subheadings (e.g., two 'Referrals' lines) and miscategorized information (e.g., follow-up instructions listed as 'Treatment').
- likely cause: cleanup — The model extracted facts correctly but failed to organize them logically, creating redundant sections, duplicating information, and misplacing clinical data.

### 47. l-tinnitus-nasal-cong — needs_work 60/100

The note captured most key details but was poorly structured and contained two significant factual errors regarding the patient's health maintenance status.

- similarity 0.406, omission 0.445, 356 words, 5.9s
- MISSING (important): Patient consumes 1-2 beers per week.
- MISSING (important): Patient has a history of addiction to Otrivin nasal spray about 15 years ago.
- MISSING (minor): Patient has no prostate issues.
- WRONG (major): “colonoscopy up to date” — This is incorrect; the transcript explicitly states the patient's colonoscopy is not up to date (0:28).
- WRONG (major): “PSA blood test - normal” — This is misleading. The last PSA was long ago and the patient is currently due for a new one, which is why it was ordered. This implies current status is normal.
- WRONG (minor): “Treatment: treated with cefalexin 500mg QID for 7 days starting January 8th, finished January 15th” — This information belongs in the Subjective/HPI section as it is part of the history of the presenting illness, not part of the current plan.
- WRONG (minor): “Diagnosis: Hypertension - uncontrolled” — This is a premature diagnosis. The elevated reading was acknowledged as likely due to recent caffeine intake, and the plan is to monitor, not to diagnose and treat uncontrolled hypertension at this stage.
- EXTRA: “Follow-up for infection
- left ear tinnitus
- slow wound healing
- blood pressure check
- PSA blood test
- flu shot
- COVID vaccine” — This is a redundant list of topics/agenda items at the start of the subjective section, which is not standard SOAP format.
- EXTRA: “plans to travel to Mexico in March” — This is conversational filler and not clinically relevant to the medical history.
- EXTRA: “Current medications: coffee” — Coffee is a dietary/social history item, not a medication.
- STRUCTURE: The Subjective section is poorly formatted, starting with a non-standard agenda list before detailing the HPI.
- STRUCTURE: The note creates too many separate problem-based assessments (6 total), which could be consolidated under 'Tinnitus' and 'Health Maintenance'.
- STRUCTURE: Information is misplaced, such as past antibiotic treatment appearing in the current plan and dietary habits listed as medications.
- likely cause: writer — The AI failed to synthesize information into a standard SOAP format, miscategorized information, and made factual errors on checklist-style questions.

### 48. diverticulitis-fatigue-r-t-e — needs_work 65/100

The note correctly identified most key issues but was poorly structured, with redundant information, misplaced facts, and several incorrect claims in the plan.

- similarity 0.300, omission 0.552, 240 words, 4.8s
- MISSING (important): Pain started centrally, then moved lower.
- MISSING (important): Patient has an existing appointment for a colonoscopy on 1972-05-25.
- MISSING (important): Patient has a history of a thyroid condition and was previously followed by an endocrinologist.
- MISSING (minor): Patient consumes 1-2 coffees in the morning.
- MISSING (minor): Patient was advised where to obtain the brace (Kinetic Connections or Bioped).
- WRONG (major): “Investigations: massage therapy script” — A massage script is a treatment, not an investigation. This is in the wrong section and miscategorized.
- WRONG (major): “Treatment: Received Flagyl 500mg three times a day from ER” — This is a historical fact (HPI), not a new treatment action in the plan.
- WRONG (major): “ER ultrasound of pelvic area and ovaries: no findings” — This is a historical finding and belongs in the Subjective/HPI section, not Objective.
- WRONG (minor): “Current medications: Meclonidazole five hundred milligrams” — This is a duplicate entry; 'Meclonidazole' is a misspelling of Metronidazole, which is already listed by its brand name, Flagyl.
- WRONG (minor): “Denies blood in stool” — This is an oversimplification; the patient stated 'maybe a little spot', indicating some uncertainty.
- WRONG (minor): “Rtc: the patient and the patient will call with appointment” — This is vague and nonsensical. The physician stated they would call the patient with appointments.
- EXTRA: “Pain improved with dietary changes” — Duplicate of 'Pain is resolving' and 'Patient is careful with diet'.
- EXTRA: “Patient requires massage therapy” — Redundant commentary; the plan should state the action (script provided), not the justification.
- EXTRA: “Patient requires gastroenterology consultation for diverticulitis and colonoscopy” — Redundant commentary; the plan should state the action (referral made), not the justification.
- EXTRA: “Patient has right-sided tennis elbow” — Redundant; this is a diagnosis, not a plan item. The plan should just state the action (brace prescribed).
- STRUCTURE: The Subjective section is a list of bullet points rather than a coherent HPI narrative.
- STRUCTURE: The Assessment & Plan is disorganized, mixing diagnoses, historical facts, investigations, and treatments incorrectly under numbered problems.
- STRUCTURE: Multiple redundant problem headings were created (e.g., 'Diverticulitis' and 'Gastroenterology referral') for the same issue.
- STRUCTURE: Objective section contains information that belongs in the HPI (ER ultrasound results).
- STRUCTURE: Past Medical History section contains social history (alcohol, smoking, diet) and current medications, which should be in their own sections.
- likely cause: writer — The AI writer failed to structure the information into a standard SOAP format, mixing sections and creating redundant, poorly organized plan items.

### 49. f-u-gen-osteopenia — needs_work 60/100

The note captured most key facts but was poorly structured with significant redundancy, misplaced information, and a critical typo regarding a future procedure date.

- similarity 0.427, omission 0.474, 249 words, 5.8s
- MISSING (important): Patient is seeing Dr. Dean for an eye lesion that tends to fall off and come back, with an appointment in April.
- MISSING (important): Patient is undergoing physiotherapy for the right hip, which is the reason for the improvement.
- MISSING (minor): The FIT test was done in July of last year (2025 in the gold note is a typo, transcript says 'July of last year').
- MISSING (minor): Last blood tests were in June of the previous year.
- WRONG (critical): “Colonoscopy last one 2019, next one 1929” — The date for the next colonoscopy is nonsensical and transcribed a slip of the tongue from the audio without correction. The correct year is 2029.
- WRONG (major): “Treatment: hydrovalcream (stopped)” — This is misplaced under the 'Right hip pain' section in the plan. Hydroval cream was for atopic dermatitis.
- WRONG (minor): “Left eye retinal artery occlusion since 2014” — This is a diagnosis and belongs in the Past Medical History section, not the Subjective section.
- WRONG (minor): “Eye fluid not a concern as long as patient can read” — This is a detail of the specialist's management plan, not a subjective complaint from the patient. It belongs in the Assessment & Plan or PMH.
- WRONG (minor): “Mammogram: normal, February 13th” — This information is duplicated in the Objective section after already being listed under Past Medical History.
- WRONG (minor): “Bone density scan: improved, 2025” — This is duplicated in the Objective section after being listed in the Past Medical History.
- EXTRA: “Right hip pain improving” — Duplicate; the Subjective section already states 'Right hip pain much better'.
- EXTRA: “Associated Symptoms” — Unnecessary sub-header in the Subjective section for a single pertinent negative.
- EXTRA: “Diagnosis: Cardiovascular health” — This is not a diagnosis; it's a category. The plan items are for routine follow-up.
- STRUCTURE: Information is poorly segregated; diagnoses, preventive care, and medications are mixed into the Subjective, PMH, and Objective sections inappropriately.
- STRUCTURE: The Assessment & Plan is structured as a problem list but is overly fragmented, creating separate plan items for medications and follow-ups that should be consolidated under their respective diagnoses.
- STRUCTURE: Redundant information is present across multiple sections (e.g., mammogram results).
- STRUCTURE: The use of sub-headers like 'Associated Symptoms' in the Subjective section is unconventional and fragments the narrative.
- likely cause: writer — The AI writer failed to properly structure the note according to SOAP conventions, mixing information across sections and creating a fragmented, redundant output.

### 50. low-b12-iron-2 — good 75/100

The note correctly identified all major clinical issues and plans but was poorly structured with significant redundancy in the subjective and objective sections.

- similarity 0.405, omission 0.486, 148 words, 6.7s
- MISSING (important): Calcium, magnesium, and phosphorus levels were normal.
- MISSING (important): The plan is to repeat the inflammatory marker around 2000-05-17.
- MISSING (important): The follow-up appointment is scheduled for 1997-03-30.
- WRONG (major): “Rtc: [date] for blood test and follow-up” — This is a placeholder and fails to capture the specific follow-up date (1997-03-30) mentioned in the transcript.
- EXTRA: “Associated Symptoms
- Cramping in feet
- Swelling in one leg/ankle” — This entire section is a duplicate of information already listed in the main subjective section.
- EXTRA: “- hemoglobin: fine
- urine: fine
- sodium: fine
- potassium: fine
- calcium: fine
- liver: fine
- sugars: fine
- cholesterol: higher side” — This is a redundant list of findings already summarized in the first bullet point of the Objective section.
- STRUCTURE: The Objective section is poorly formatted, presenting results first in a long run-on sentence and then repeating them as a disorganized list.
- STRUCTURE: The Subjective section unnecessarily creates a separate 'Associated Symptoms' heading to repeat information.
- STRUCTURE: The Assessment & Plan section uses inconsistent formatting, with some items having a 'Diagnosis' line and others not.
- likely cause: cleanup — The AI failed to de-duplicate information, leading to redundant lists in the Subjective and Objective sections.
