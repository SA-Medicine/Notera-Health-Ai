# Audio end-to-end — real recordings through the deployed pipeline

9 recordings from the simulated patient–physician interview dataset (mp3, ~3–4 min each) → ffmpeg decode → Google Speech-to-Text → v2 note pipeline, run inside the production backend container on the Google VM. Nothing was saved to the database.

**Success** 9/9 · **ASR WER** mean 0.22 · **ASR time** mean 31.28s · **note time** mean 4.95s · **audit score** mean 70.56/100

| Recording | Audio | ASR s | Note s | WER | Audit | Score | Missing | Wrong | Cause |
|---|---|---|---|---|---|---|---|---|---|
| CAR0001 | 626s | 32.1 | 6.0 | 0.19 | needs_work | 65 | 7 | 3 | writer |
| CAR0002 | 530s | 26.7 | 4.7 | 0.17 | unsafe | 45 | 3 | 3 | writer |
| DER0001 | 646s | 34.4 | 5.4 | 0.22 | needs_work | 65 | 7 | 3 | writer |
| GAS0001 | 571s | 26.1 | 6.4 | 0.23 | needs_work | 65 | 6 | 0 | rules |
| GAS0002 | 585s | 27.1 | 3.2 | 0.17 | good | 80 | 6 | 1 | writer |
| MSK0001 | 530s | 28.6 | 3.8 | 0.23 | good | 80 | 4 | 0 | writer |
| RES0001 | 799s | 39.5 | 6.6 | 0.22 | good | 85 | 6 | 6 | writer |
| RES0002 | 656s | 33.3 | 3.7 | 0.30 | needs_work | 65 | 6 | 5 | writer |
| RES0003 | 660s | 33.6 | 4.8 | 0.24 | good | 85 | 6 | 6 | rules |

## Per recording

### CAR0001 — needs_work 65/100

The note captured most of the HPI but contained a critical error in the patient's occupation and a significant contradiction regarding a key cardiac symptom, while also misplacing social and family history.

- MISSING (critical): Patient is a 39-year-old male.
- MISSING (critical): Pain started last night and has been present for about 8 hours.
- MISSING (critical): Pain is located on the left side of the chest.
- MISSING (critical): Patient smokes 1 pack of cigarettes per day for 10-15 years.
- MISSING (important): Patient uses cannabis, about 5mg per week.
- MISSING (important): Father had his heart attack at age 45.
- MISSING (important): Patient denies radiation of pain.
- WRONG (critical): “Denies racing heart” — This is a direct contradiction; the patient affirmed experiencing 'a little bit' of a racing heart.
- WRONG (major): “Works as a programmer” — This is factually incorrect; the patient stated he is an accountant.
- WRONG (minor): “Denies noisy breathing” — This is an oversimplification; the patient stated he has noisy breathing when he is 'really having trouble breathing'.
- WER vs human transcript: 0.19 (1003 ASR words vs 1041 reference)
- pipeline: [v2:verify] ✂ "Smokes cigarettes: 1 pack per day for 20 years" — The transcript cuts off the duration of smoking ('how long have you been smoking for? [cut off]') and does not mention 20 years. | [v2:verify] ✂ "Smokes cannabis: 500mg per week" — The patient says 'I've milligrams. Not that much.' but did not specify 500mg per week (the transcript cut off or was unclear about '500').

### CAR0002 — unsafe 45/100

The note is unsafe due to a critical medication error and misses several key clinical facts from the HPI, including the exertional onset and a recent chest trauma.

- MISSING (critical): Pain started 30 minutes ago while shoveling the driveway.
- MISSING (critical): Patient was tackled playing rugby yesterday.
- MISSING (important): No known drug allergies.
- WRONG (critical): “Current medications: atorvastatin” — The patient stated they take rosuvastatin, not atorvastatin. This is a medication error.
- WRONG (major): “Denies fevers” — This is incorrect; the patient reported feeling hot and having a measured temperature of 38°C.
- WRONG (minor): “Denies runny nose” — The patient stated they had a runny nose a few weeks ago that resolved; this claim is an oversimplification.
- EXTRA: “Pain has gotten worse since it started” — This is a duplicate of 'Pain has worsened since onset' listed just a few lines above.
- WER vs human transcript: 0.17 (1034 ASR words vs 1064 reference)
- pipeline: [v2:verify] ✂ "Denies recent chest injury" — The patient mentioned being tackled by another player yesterday while playing rugby, so denying a recent chest injury is incorrect.

### DER0001 — needs_work 65/100

The note correctly identified the likely diagnosis but invented a key symptom, misattributed family history, and had significant structural problems by mixing social and family history into the past medical history section.

- MISSING (critical): Patient is 45 years old.
- MISSING (critical): Last A1c was around 9.
- MISSING (important): Patient has noticed decreased sensation in his feet over the years (neuropathy).
- MISSING (important): Family history of diabetes, high blood pressure, and high cholesterol on mother's side.
- MISSING (important): The rash has been looking strange for about a week.
- MISSING (important): Patient is not on insulin.
- MISSING (minor): Patient takes Tylenol/Advil for back pain.
- WRONG (critical): “Increased urination” — This symptom was not mentioned in the transcript and appears to be an invented finding, likely inferred from the patient's diabetes.
- WRONG (major): “Maternal side: one aunt with lung cancer (smoker)” — The transcript states this was on the father's side of the family, not the mother's.
- WRONG (minor): “sitagliptin” — This is an assumption. The patient said "sidassomething" and could not remember the name. The note should reflect this uncertainty (e.g., 'a sitagliptin-like medication' or 'medication name sounds like...').
- WER vs human transcript: 0.22 (1432 ASR words vs 1489 reference)
- pipeline: [v2:verify] ✂ "Poorly controlled diabetes with recent elevated blood sugar (9.0 mmol/L) and symptoms of h" — Transcript says blood sugar was 'nine something' but does not specify units like mmol/L.

### GAS0001 — needs_work 65/100

The note correctly captured most key subjective facts but failed to organize them into standard SOAP sections, mixing social, family, and medication history into the Past Medical History section.

- MISSING (important): Patient has been vomiting once or twice on 'a lot of days' over the past 1-2 weeks.
- MISSING (important): Patient reports her periods are usually regular and going 6 weeks without one is not normal for her.
- MISSING (important): Patient has been drinking more water because she feels dehydrated from vomiting.
- MISSING (minor): Patient is sexually active with one partner (boyfriend).
- MISSING (minor): Ginger chews were not helpful for her nausea.
- MISSING (minor): Patient denies any past medical conditions.
- WER vs human transcript: 0.23 (974 ASR words vs 1014 reference)
- pipeline: [v2:merge] checklist added 1 grounded item(s) the writer omitted | [v2:verify] ✂ "Vomiting 1-2 times per day" — Patient stated vomiting once or twice over the past days/weeks, not 1-2 times per day.

### GAS0002 — good 80/100

The note is accurate and captures most key details, but it misses the critical fact that the pain is postprandial and fails to properly structure the PMH, SH, FH, and Medications sections.

- MISSING (critical): Pain started 3 days ago, about 30-60 minutes after lunch.
- MISSING (critical): Patient has no known drug allergies.
- MISSING (important): Patient has no prior surgeries.
- MISSING (important): Appetite is worst today.
- MISSING (minor): Patient denies recent travel.
- MISSING (minor): Patient denies recent weight changes.
- WRONG (minor): “Occupation: Bank employee” — The patient specified they work as a 'consultant' at the bank, which is more specific.
- WER vs human transcript: 0.17 (1096 ASR words vs 1124 reference)
- pipeline: no removals

### MSK0001 — good 80/100

The note accurately captured most clinical details but missed the critical inciting event and had a poorly organized structure, mixing multiple distinct sections together.

- MISSING (critical): The pain started yesterday while unloading groceries from a pickup truck.
- MISSING (important): Patient denies any specific past trauma to the back.
- MISSING (minor): Patient has a normal appetite.
- MISSING (minor): Patient reports regular bowel movements.
- WER vs human transcript: 0.23 (954 ASR words vs 1040 reference)
- pipeline: no removals

### RES0001 — good 85/100

The note is well-structured and captures most key clinical information, but it misses the crucial finding of left leg swelling and miscategorizes some social and family history.

- MISSING (critical): Patient confirms left leg swelling after initially denying it.
- MISSING (important): Pain episodes last 15-20 minutes.
- MISSING (important): Patient's shortness of breath is a 7-8/10 on exertion.
- MISSING (important): Patient can only walk about 100 meters before needing to rest.
- MISSING (important): Patient has been less mobile since her recent hysterectomy.
- MISSING (minor): Hysterectomy was a day procedure.
- WRONG (critical): “Denies calf swelling” — This is incorrect; the patient initially denied it but then corrected herself and confirmed there is swelling in her left leg.
- WRONG (minor): “Occupation: Administrator at a bank” — This is social history and should not be in the Past Medical History section.
- WRONG (minor): “Smoking: 0.5 pack per day since teenage years, previously 1 pack per day, trying to quit” — This is social history and should not be in the Past Medical History section.
- WRONG (minor): “Alcohol: 1 glass of wine on weekends” — This is social history and should not be in the Past Medical History section.
- WRONG (minor): “Mother had heart attack at 56” — This is family history and should not be in the Past Medical History section.
- WRONG (minor): “Mother may have had blood clots” — This is family history and should not be in the Past Medical History section.
- EXTRA: “Denies history of COPD” — This was not asked in the transcript.
- WER vs human transcript: 0.22 (1429 ASR words vs 1515 reference)
- pipeline: no removals

### RES0002 — needs_work 65/100

The note correctly captured most of the HPI and plan but contained a critical error regarding patient age, a major contradiction in medications, and had significant structural issues with information placed in the wrong sections.

- MISSING (critical): Patient has had fewer wet diapers than usual.
- MISSING (important): The patient's grandmother recently traveled to Mexico and saw the patient last week.
- MISSING (important): The cough is productive of yellow sputum.
- MISSING (important): The previous diagnosis was potentially bronchiolitis or an upper viral infection.
- MISSING (minor): The patient is the mother's first child.
- MISSING (minor): Both parents are the primary caregivers.
- WRONG (critical): “Cough, fever, and fast breathing in 2.5-month-old infant” — The transcript states the patient is 2 and a half months old, not 2.5 years old. This is a critical error that significantly changes the differential diagnosis and management plan.
- WRONG (major): “Current medications: puffers” — This contradicts the line 'Current medications: none' in the same section. The puffers were from a previous illness a month ago, not current.
- WRONG (major): “Traveled to Mexico last week” — This is listed under the patient's Past Medical History, but the transcript states the patient's grandmother traveled, not the patient.
- WRONG (minor): “Mother is primary caregiver” — The transcript states both parents are the primary caregivers.
- WRONG (minor): “Sister has asthma” — This is ambiguous. The transcript clarifies it is the patient's maternal aunt (mother's sister) who has asthma.
- EXTRA: “Goldfish as pet” — padding
- EXTRA: “Parents drink a glass of wine once a week” — padding
- WER vs human transcript: 0.30 (1008 ASR words vs 1166 reference)
- pipeline: [v2:merge] checklist added 1 grounded item(s) the writer omitted

### RES0003 — good 85/100

The note is well-structured and captures most key clinical details, but it misplaces several history items and omits important context about the illness.

- MISSING (critical): Patient is 3 years old.
- MISSING (important): Sore throat has been present for 3 days.
- MISSING (important): Tylenol was given, which temporarily reduced the fever, but it returned.
- MISSING (important): Patient has had sore throats before, but this episode is more severe.
- MISSING (minor): Patient has been in daycare for 6 months.
- MISSING (minor): Mother had diet-controlled gestational diabetes during pregnancy.
- WRONG (major): “Posterior pharynx appears red” — This is a finding reported by the mother, not an objective finding from the clinician's exam. It belongs in the HPI.
- WRONG (minor): “Lives with father, mother, and sister” — This is Social History, not Past Medical History.
- WRONG (minor): “Supportive home environment” — This is Social History, not Past Medical History.
- WRONG (minor): “No one smokes at home” — This is Social History, not Past Medical History.
- WRONG (minor): “Few area rugs at home” — This is Social History, not Past Medical History.
- WRONG (minor): “Sister had colds” — This is an exposure/HPI detail, not Past Medical History.
- WER vs human transcript: 0.24 (1163 ASR words vs 1246 reference)
- pipeline: no removals
