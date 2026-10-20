// The Notera Style Interview — three parts, each long and detailed; Part 3 is the DEFINING part (priorities, trade-offs, non-negotiables and a
// rule-by-rule review of the approved Style Spec). The answers are stored per account and synthesised into a Style Profile that the owner
// can use to restructure the system LATER. Answering never changes how Notera writes notes today: the Style Spec v1 is locked.
//
// Question types: single | multi | scale (1-5) | text | rank (order the items) | compare (pick one of several example renderings).
'use strict';

import { SPEC } from './conformance.js';

const opt = (arr) => arr.map((x, i) => (typeof x === 'string' ? { id: String.fromCharCode(97 + i), label: x } : x));
let _n = 0;
const mk = (part, type) => (prompt, o = {}) => ({ id: o.id || `p${part}.q${++_n}`, type, prompt, ...o, ...(o.options ? { options: opt(o.options) } : {}) });
const builders = (part) => ({
  single: mk(part, 'single'), multi: mk(part, 'multi'), scale: mk(part, 'scale'), text: mk(part, 'text'), rank: mk(part, 'rank'), compare: mk(part, 'compare'),
});

function part1() {
  _n = 0; const { single, multi, scale, text, rank } = builders(1); const g = (group, q) => ({ ...q, group });
  return [
    g('Your practice', text('What is your specialty and the setting you work in (clinic, hospital, virtual, mixed)?', { required: true, placeholder: 'e.g. family medicine, community clinic, 15-minute visits' })),
    g('Your practice', single('Roughly how many patients do you see on a typical day?', { required: true, options: ['Fewer than 10', '10 to 20', '20 to 30', 'More than 30'] })),
    g('Your practice', multi('Which kinds of visits do you document most often?', { required: true, options: ['New problem', 'Follow-up of a known problem', 'Chronic disease review', 'Annual physical / check-up', 'Prescription renewal', 'Mental health', 'Paediatric', 'Women’s health / prenatal', 'Procedure or minor surgery', 'Forms, letters, paperwork', 'Telephone / virtual visit'] })),
    g('Your practice', text('Do you document different visit types differently (for example a renewal versus a new problem)? Describe how.', { placeholder: 'Short for renewals, long for new problems…' })),
    g('Your practice', single('Which spelling, units and date conventions do you want in notes?', { required: true, options: ['Canadian (metric, DD/MM or written months)', 'US (imperial where used, MM/DD)', 'UK (metric, DD/MM)', 'Other — I will explain below'] })),
    g('Your practice', text('Which electronic record (EMR) do you paste notes into, and does it impose a format?', { placeholder: 'Name of the EMR, and any required headings or fields' })),
    g('Readers and purpose', multi('Who reads your notes?', { required: true, options: ['Only me', 'Colleagues in my clinic', 'Specialists I refer to', 'Allied health (nurses, physio, pharmacists)', 'The patient (portal / copy)', 'Insurers or employers', 'Lawyers or regulators if there is a complaint', 'Billing / coding staff'] })),
    g('Readers and purpose', rank('Rank what a note is MOST for (top = most important).', { required: true, options: ['A memory aid for my next visit', 'Hand-over to another clinician', 'Medico-legal record', 'Billing / coding support', 'Communication with the patient', 'Quality or audit records'] })),
    g('Readers and purpose', single('How soon after the visit do you finish and sign the note?', { required: true, options: ['Before the next patient', 'End of the clinic session', 'Same day, after hours', 'Within a few days'] })),
    g('Readers and purpose', single('How much time do you spend on one note today (writing or editing)?', { options: ['Under 2 minutes', '2 to 5 minutes', '5 to 10 minutes', 'More than 10 minutes'] })),
    g('Readers and purpose', text('When someone else reads your note, what must they understand within ten seconds?', { required: true, placeholder: 'Why the patient came, what is going on, what happens next…' })),
    g('What you edit today', multi('When you edit an AI-written note, what do you change most often?', { required: true, options: ['Remove padding or repeated facts', 'Add things that were left out', 'Fix wrong facts, doses or sides', 'Reword to my style', 'Move facts to the right section', 'Shorten long sentences', 'Change the plan wording', 'Fix drug or diagnosis names', 'Fix headings and layout'] })),
    g('What you edit today', text('What frustrates you most about notes written by AI scribes you have tried?', { placeholder: 'Be as blunt as you like' })),
    g('What you edit today', text('Describe the last note that was close to perfect for you, and what made it good.', { placeholder: 'Describe or paste (no patient details)' })),
    g('What you edit today', text('Describe the worst AI note you have seen. What was wrong with it?', { placeholder: 'No patient details' })),
    g('Detail and length', scale('How long should a typical note be?', { required: true, labels: ['As short as possible', 'Very thorough'] })),
    g('Detail and length', scale('How comfortable are you with abbreviations in notes (HTN, T2DM, RTC, SOB)?', { required: true, labels: ['Spell everything out', 'Abbreviate freely'] })),
    g('Detail and length', scale('How telegraphic should the writing be?', { required: true, labels: ['Full sentences', 'Clipped clinical shorthand'] })),
    g('Detail and length', single('How much of the patient’s own words should appear?', { options: ['None — clinical wording only', 'Only short quotes when they are clinically meaningful', 'Quite a lot — keep the patient’s voice'] })),
    g('Trust and safety', rank('Rank these note failures from WORST (top) to least bad.', { required: true, options: ['A wrong drug, dose or side', 'Something important left out', 'A fact that was never said (made up)', 'A denial turned into a finding', 'A plan item under the wrong problem', 'Too long and repetitive', 'Wrong wording or style'] })),
    g('Trust and safety', multi('What would let you sign a note without reading every line?', { required: true, options: ['Every line linked to the exact words in the transcript', 'Uncertain items clearly flagged', 'A check that every number and drug matches what was said', 'Many weeks of accurate notes', 'A short list of "please verify" items', 'Nothing — I always read everything'] })),
    g('Trust and safety', single('When the audio is unclear or a drug name sounds odd, what should the note do?', { required: true, options: ['Write what was heard and flag it for me', 'Leave it out and flag that something was unclear', 'Make the best clinical guess', 'Ask me before writing the note'] })),
    g('Trust and safety', single('Should the note ever contain information the clinician did not say (for example a likely diagnosis)?', { required: true, options: ['Never', 'Only as a flagged suggestion, clearly separate from the note', 'Yes, if it is clinically obvious'] })),
    g('Trust and safety', text('What must NEVER appear in a note?', { required: true, placeholder: 'e.g. patient names, addresses, small talk, speculation…' })),
    g('Your style', single('Should every doctor in your clinic get the same note format, or should each doctor have a personal style?', { options: ['One shared clinic format', 'Shared sections, personal wording', 'Fully personal'] })),
    g('Your style', text('Do you use any template or macro today? Paste or describe its headings.', { placeholder: 'Headings in order, or a short description' })),
    g('Your style', text('Is there anything about how you document that a scribe would never guess?', { placeholder: 'Habits, rules of thumb, local conventions' })),
  ];
}

function part2() {
  _n = 0; const { single, multi, scale, text, rank, compare } = builders(2); const g = (group, q) => ({ ...q, group });
  const subjA = 'Abdominal Pain:\n- Sharp right-sided pain radiating to back, present for at least 1 year\n- Episodes last 5 to 10 minutes\n- Worse after eating\n- No nausea or fever';
  const subjB = 'Sharp right-sided abdominal pain radiating to the back for at least a year, in episodes of 5 to 10 minutes, worse after eating. No nausea or fever.';
  const subjC = 'Abdominal pain - right-sided, sharp, radiating to back, > 1 yr, episodic 5-10 min, worse post-prandial, no N/V/fever';
  const medA = 'Medications: perindopril plus 1 daily, metoprolol twice daily, baby aspirin daily';
  const medB = 'Medications: perindopril/indapamide 4/1.25 mg 1 tab PO daily; metoprolol 50 mg PO BID; ASA 81 mg PO daily';
  const medC = 'Medications: perindopril/indapamide, metoprolol, ASA';
  const objA = 'Bloods (Apr 2025): Hb 139; LDL 4 (high); TSH high; sodium, potassium, renal function, B12, iron normal';
  const objB = 'Hb 139\nLDL 4 (high)\nTSH high\nSodium normal\nPotassium normal\nRenal function normal\nB12 normal\nIron normal';
  const apA = '1. Hypothyroidism\n- Diagnosis: Hypothyroidism\n- Investigations planned: repeat TSH today\n- Treatment planned: restart levothyroxine 88 mcg daily; Rtc January';
  const apB = '1. Hypothyroidism - off levothyroxine x1 year, TSH high. Repeat TSH today, restart levothyroxine 88 mcg daily, recheck January.';
  return [
    // ── Subjective ──
    g('Subjective', compare('Which layout do you prefer for the history of a symptom?', { required: true, options: [{ id: 'a', label: 'Topic heading with short bullets', example: subjA }, { id: 'b', label: 'A short paragraph', example: subjB }, { id: 'c', label: 'Compact shorthand line', example: subjC }] })),
    g('Subjective', multi('Which topic headings do you want to see (when relevant)?', { options: ['Presenting Complaint', 'History of Presenting Illness (one heading per problem)', 'Location and Quality', 'Aggravating and Relieving Factors', 'Associated Symptoms', 'Previous Episodes', 'Impact on Function', 'Medication Adherence', 'Review of Systems', 'Mood / Mental Health', 'Pertinent Negatives'] })),
    g('Subjective', text('Write the headings you would use for a typical new-problem visit, in your order.', { placeholder: 'e.g. Presenting Complaint, History, Associated Symptoms, Impact' })),
    g('Subjective', single('How many bullets under one topic is too many?', { options: ['3', '5', '8', 'No limit if each is useful'] })),
    g('Subjective', scale('How long should one bullet be?', { required: true, labels: ['3 to 6 words', 'A full sentence'] })),
    g('Subjective', single('Where should the reasons for the visit go?', { required: true, options: ['A short bullet list at the top ("Presenting Complaint")', 'One sentence at the top', 'Inside the history, no separate list'] })),
    g('Subjective', single('How should several problems in one visit be ordered?', { required: true, options: ['Most important first', 'In the order the patient raised them', 'Acute before chronic', 'Same order as the Assessment & Plan'] })),
    g('Subjective', multi('Which negatives must ALWAYS be written down when they were asked?', { options: ['Fever', 'Weight loss', 'Chest pain', 'Shortness of breath', 'Nausea / vomiting', 'Bleeding', 'Red-flag symptoms for the complaint', 'Suicidal thoughts (mental health visits)', 'All negatives that were asked', 'Only the ones that change management'] })),
    g('Subjective', single('Where do the denials go?', { required: true, options: ['Under the symptom they belong to', 'One "Pertinent Negatives" topic', 'Whichever the doctor said first'] })),
    g('Subjective', single('How should timing and duration be written?', { options: ['"for 3 weeks"', '"since 12 Sept"', 'Both when known', 'Only what was said'] })),
    g('Subjective', single('Should the patient’s own explanation of the cause be recorded?', { options: ['No', 'Yes, labelled as the patient’s belief', 'Only if it influences the plan'] })),
    g('Subjective', multi('Which background items belong in the Subjective rather than Past Medical History?', { options: ['None — keep Subjective to the current problem', 'What the patient has already tried', 'Medication adherence problems', 'Recent hospital or ER visits', 'Recent tests the patient mentions', 'Family concerns'] })),
    g('Subjective', text('What does a perfect Subjective look like for you? One short example (no patient details).', { placeholder: 'Write it the way you would want to read it' })),
    // ── Past medical history ──
    g('Past Medical History', multi('What belongs in Past Medical History?', { required: true, options: ['Chronic conditions with status', 'Past surgeries with year', 'Allergies and reactions', 'Current medications', 'Immunisations', 'Screening / preventive care', 'Family history', 'Social history (smoking, alcohol, drugs)', 'Occupation', 'Who the patient lives with', 'Exposures (travel, work, pets)', 'Pregnancy history'] })),
    g('Past Medical History', compare('How should medications be listed?', { required: true, options: [{ id: 'a', label: 'Names with simple dosing words', example: medA }, { id: 'b', label: 'Full prescribing detail', example: medB }, { id: 'c', label: 'Names only', example: medC }] })),
    g('Past Medical History', single('Where do allergies go?', { required: true, options: ['A separate "Allergies:" line in Past Medical History', 'Top of the note, highlighted', 'Only when relevant to the visit', 'Not recorded by the scribe'] })),
    g('Past Medical History', single('How many bullets should Past Medical History have?', { options: ['3 to 4', 'About 6', 'As many as needed', 'Only what matters today'] })),
    g('Past Medical History', single('How should conditions be written?', { options: ['Name only ("Hypertension")', 'Name with status ("Hypertension, on perindopril")', 'Name with year ("Hypertension 2015")'] })),
    g('Past Medical History', single('Should resolved or historical problems be listed?', { options: ['Yes, all', 'Only if relevant to the visit', 'No'] })),
    g('Past Medical History', single('How much family history?', { options: ['Only first-degree relatives and relevant conditions', 'Everything mentioned', 'Only if I ask for it'] })),
    g('Past Medical History', single('Social history format', { options: ['One bullet ("Widowed, ex-smoker, no alcohol")', 'Separate bullets per item', 'Only relevant items'] })),
    g('Past Medical History', text('Anything in Past Medical History you never want (for example addresses, names of relatives)?', { placeholder: 'List it' })),
    // ── Objective ──
    g('Objective', compare('How should lab results be laid out?', { required: true, options: [{ id: 'a', label: 'Grouped by panel, abnormal first', example: objA }, { id: 'b', label: 'One line per test', example: objB }] })),
    g('Objective', single('How should vital signs appear?', { required: true, options: ['Own line: BP 128/80, HR 72, Temp 36.8, SpO2 98%', 'Inside the exam findings', 'Only abnormal vitals'] })),
    g('Objective', single('How should a normal examination be written?', { required: true, options: ['"Normal" per system', 'List the normal findings', 'Only abnormal findings plus "otherwise unremarkable"'] })),
    g('Objective', single('Should the exam be grouped by system with headings?', { options: ['Yes, always', 'Only for long exams', 'No, one list'] })),
    g('Objective', single('Which old results should appear in Objective?', { options: ['Everything mentioned in the visit', 'Only results from the last 12 months', 'Only results that matter for today’s problems'] })),
    g('Objective', single('Where do home readings (for example home blood pressure) go?', { required: true, options: ['Objective, labelled "at home"', 'Subjective', 'Both'] })),
    g('Objective', single('How should imaging be written?', { options: ['Study, date: key finding', 'Full report wording', 'Impression only'] })),
    g('Objective', single('How should abnormal results be marked?', { options: ['"(high)" / "(low)" after the value', 'Bold', 'Not marked'] })),
    g('Objective', text('Anything specific about how you record the examination?', { placeholder: 'e.g. laterality rules, ROM wording, pain scores' })),
    // ── Assessment & Plan ──
    g('Assessment & Plan', compare('Which plan layout do you prefer?', { required: true, options: [{ id: 'a', label: 'Numbered problems with labelled lines', example: apA }, { id: 'b', label: 'One compact line per problem', example: apB }] })),
    g('Assessment & Plan', single('How should problems be ordered?', { required: true, options: ['Most important first', 'Order discussed in the visit', 'Acute before chronic', 'Same as the Subjective topics'] })),
    g('Assessment & Plan', single('What should a problem title be?', { required: true, options: ['The diagnosis if stated, otherwise the symptom', 'Always the symptom or problem as discussed', 'Always a diagnosis (best clinical judgement)'] })),
    g('Assessment & Plan', single('When should differential diagnoses appear?', { required: true, options: ['Only if I listed them', 'Whenever the note has a symptom without a diagnosis', 'Never'] })),
    g('Assessment & Plan', single('When should an assessment line appear?', { required: true, options: ['Only if I stated a conclusion', 'Always one short status line per problem', 'Never — only diagnosis and plan'] })),
    g('Assessment & Plan', multi('Which plan items must be written for medications?', { options: ['Drug name', 'Dose', 'Route', 'Frequency', 'Duration', 'Quantity / refills', 'Pharmacy', 'Reason / indication', 'New / continue / stop / change'] })),
    g('Assessment & Plan', single('How should follow-up be written?', { options: ['"Rtc: 4 weeks"', '"Follow up in 4 weeks"', '"Review in 4 weeks with TSH"'] })),
    g('Assessment & Plan', single('Where should refills and renewals be written?', { required: true, options: ['Under the condition the drug treats', 'In one "Medication refills" problem', 'Both'] })),
    g('Assessment & Plan', single('How should referrals be written?', { options: ['Service and reason ("Physiotherapy for knee")', 'Service only', 'Specialist name, service and reason'] })),
    g('Assessment & Plan', multi('Which of these belong in the plan when they were said?', { options: ['Safety-net advice ("go to ER if…")', 'Counselling and education given', 'Patient’s decision or refusal', 'Shared decision-making notes', 'Time spent', 'Forms or letters completed', 'Return precautions'] })),
    g('Assessment & Plan', single('Forms, permits and letters', { options: ['One "Administrative" problem', 'Inside the plan of the related problem', 'Not in the note'] })),
    g('Assessment & Plan', text('Write the plan you would want for a simple example: a patient with high blood pressure who needs a refill and a blood test.', { placeholder: 'Write it exactly as you would like to see it' })),
    // ── Language and layout ──
    g('Language', multi('Which abbreviations are fine in your notes?', { options: ['HTN', 'T2DM', 'SOB', 'RTC', 'BID / TID / PRN', 'CXR / MRI / CT', 'ROS', 'N/V', 'DM', 'URTI', 'Other — I will list them'] })),
    g('Language', text('Which abbreviations or words should NEVER be used?', { placeholder: 'e.g. QD, "patient states", "complains of"' })),
    g('Language', single('Tense and voice', { options: ['Present for current problems, past for history', 'Past tense throughout', 'Telegraphic, no tense'] })),
    g('Language', single('How should numbers be written?', { options: ['Numerals always (3 weeks)', 'Words for one to ten', 'Whatever was said'] })),
    g('Language', single('How should the patient be referred to?', { options: ['"The patient" / no subject', '"Pt"', 'By pronoun when the sex is known', 'By first name'] })),
    g('Language', single('Headings style', { options: ['Bold headings with colons', 'Plain headings', 'Numbered sections'] })),
  ];
}

function part3() {
  _n = 0; const { single, multi, scale, text, rank, compare } = builders(3); const g = (group, q) => ({ ...q, group });
  const qs = [
    g('What matters most', rank('Rank these qualities of a note, top = what you would never give up.', { required: true, options: ['Nothing important left out', 'Nothing made up', 'Short and scannable', 'Written in my own style', 'Right facts in the right place', 'Reads as a clear story', 'Consistent every time', 'Fast to produce'] })),
    g('What matters most', single('If a note must choose, which is better?', { required: true, options: ['Complete but long — I will trim', 'Short but may miss something — I will add', 'Complete and short only if flagged items are left for me to decide'] })),
    g('What matters most', single('When Notera is unsure whether something was said, it should…', { required: true, options: ['Leave it out', 'Include it with a visible flag', 'Include it only if the transcript clearly supports it'] })),
    g('What matters most', single('If a drug name sounds wrong, it should…', { required: true, options: ['Keep it exactly as heard and flag it', 'Correct it to the most likely drug and flag it', 'Leave it out and flag'] })),
    g('What matters most', single('How strict should the format be?', { required: true, options: ['Identical structure every note', 'Same sections, free wording inside', 'Adapt the structure to the visit'] })),
    g('What matters most', single('Should a one-problem visit be written differently from a five-problem visit?', { options: ['Same format, shorter', 'Simplified format', 'Same format, same detail'] })),
    g('Deal-breakers', multi('Which errors would make you stop using a scribe?', { required: true, options: ['A wrong drug or dose', 'A wrong side (left/right)', 'An invented finding', 'A flipped negative', 'A plan item missing', 'A diagnosis I did not make', 'A privacy slip (name, address)', 'Repeated errors in the same place'] })),
    g('Deal-breakers', single('How many corrections per note would you accept?', { required: true, options: ['None', 'One or two small ones', 'Up to five if they are quick', 'It does not matter if the time saved is large'] })),
    g('Deal-breakers', text('Write up to ten hard rules for your notes: each starting with "Always" or "Never".', { required: true, placeholder: 'Always…\nNever…', long: true })),
    g('Deal-breakers', text('What do you want Notera to do for you that no tool does today?', { placeholder: 'Dream big' })),
    g('Your perfect note', text('Describe your perfect note for a common visit in your own words (sections, order, level of detail).', { required: true, long: true, placeholder: 'Walk through the note from top to bottom' })),
    g('Your perfect note', text('Paste or write one real example of your best note, with all patient details removed.', { long: true, placeholder: 'Optional but very valuable' })),
    g('Your perfect note', text('What is different about how YOU write compared with most doctors?', { placeholder: 'Your signature habits' })),
    g('Your perfect note', multi('Which special situations need different handling?', { options: ['Paediatrics', 'Pregnancy and prenatal', 'Mental health', 'Palliative care', 'Chronic pain', 'Procedures', 'Telephone visits', 'Interpreter-assisted visits', 'Medico-legal or workplace cases'] })),
    g('Your perfect note', text('For the situations you ticked, what must be different?', { placeholder: 'One line per situation' })),
    g('Working with Notera', single('How should Notera learn from you?', { options: ['From my edits automatically', 'From short interviews like this one', 'From both', 'Only when I tell it'] })),
    g('Working with Notera', single('How often would you answer short "teach Notera" questions about a note?', { options: ['After every note', 'A few times a week', 'Once a week', 'Rarely'] })),
    g('Working with Notera', single('Should the style rules you teach apply to…', { options: ['Only me', 'My whole clinic', 'All Notera users who agree'] })),
    g('Working with Notera', text('What would make you recommend Notera to a colleague?', { placeholder: '' })),
    g('Working with Notera', text('What would make you stop using it?', { placeholder: '' })),
    g('Last words', text('What did we not ask that we should have?', { long: true })),
    g('Last words', text('What would you tell a brand-new scribe on their first day about writing notes for you?', { required: true, long: true })),
  ];
  // The approved Style Spec v1, rule by rule: keep, change or drop.
  for (const r of SPEC.rules) qs.push(g('Review of the approved format', single(`Rule ${r.id} (${r.section}): "${r.text}"`, { id: `p3.spec.${r.id}`, required: true, options: [{ id: 'keep', label: 'Keep as it is' }, { id: 'change', label: 'Change it — I will explain' }, { id: 'drop', label: 'Drop it' }], followup: { when: ['change', 'drop'], prompt: 'What should it be instead, or why drop it?' } })));
  return qs;
}

export const INTERVIEW_VERSION = '1.0';
export function bank() {
  const P = [part1(), part2(), part3()];
  return [
    { part: 1, title: 'You and your notes', minutes: 25, intro: 'How you practise, who reads your notes, what you edit today and what you can and cannot trust. There are no wrong answers; blunt is best.', questions: P[0] },
    { part: 2, title: 'Section by section', minutes: 35, intro: 'The note one section at a time: Subjective, Past Medical History, Objective, Assessment & Plan, and the language you want. Short examples show the choices.', questions: P[1] },
    { part: 3, title: 'The defining part', minutes: 30, intro: 'Your priorities, deal-breakers and hard rules, your perfect note, and a rule-by-rule review of the format that is approved today. This part defines how Notera should write for you.', questions: P[2] },
  ];
}
export const partInfo = (n) => bank().find((p) => p.part === n);
export const allQuestions = () => bank().flatMap((p) => p.questions.map((q) => ({ ...q, part: p.part })));

/** Validate one answer against its question. Returns { ok, value } with a cleaned value, or { ok:false, why }. */
export function cleanAnswer(q, raw) {
  const empty = raw == null || raw === '' || (Array.isArray(raw) && !raw.length) || (typeof raw === 'object' && !Array.isArray(raw) && !Object.keys(raw).length);
  if (empty) return q.required ? { ok: false, why: 'required' } : { ok: true, value: null };
  const ids = (q.options || []).map((o) => o.id);
  const txt = (v, n = 6000) => String(v ?? '').slice(0, n);
  if (q.type === 'text') return { ok: true, value: txt(raw) };
  if (q.type === 'scale') { const v = Number(raw); return v >= 1 && v <= 5 ? { ok: true, value: Math.round(v) } : { ok: false, why: 'scale 1-5' }; }
  if (q.type === 'single' || q.type === 'compare') { const v = typeof raw === 'object' ? raw.choice : raw; const note = typeof raw === 'object' ? txt(raw.note, 2000) : ''; return ids.includes(v) ? { ok: true, value: note ? { choice: v, note } : v } : { ok: false, why: 'unknown option' }; }
  if (q.type === 'multi') { const arr = (Array.isArray(raw) ? raw : raw.choices || []).filter((x) => ids.includes(x)); return arr.length ? { ok: true, value: raw.note ? { choices: arr, note: txt(raw.note, 2000) } : arr } : (q.required ? { ok: false, why: 'pick at least one' } : { ok: true, value: null }); }
  if (q.type === 'rank') { const arr = (Array.isArray(raw) ? raw : []).filter((x) => ids.includes(x)); return new Set(arr).size === ids.length ? { ok: true, value: arr } : { ok: false, why: 'rank every item' }; }
  return { ok: false, why: 'unsupported' };
}
