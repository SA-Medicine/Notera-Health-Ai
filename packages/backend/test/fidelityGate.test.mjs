import test from 'node:test';
import assert from 'node:assert/strict';
import { drugSaid, unsaidDrugs, impossibleValues, yearSaid, claimLines, parseClaims, fidelityGate } from '../src/orchestrator/fidelityGate.js';
import { buildLexicon } from '../src/orchestrator/drugCheck.js';

const LEX = buildLexicon(['Cardizem', 'Tylenol', 'Venlafaxine', 'Jardiance', 'Metformin', 'Amlodipine', 'Ketoderm', 'Hydrocortisone', 'Prednisone']);

// real cases from the 2026-11-13 audit of 35 notes
const LR4LP = 'Stop your Avapro. Okay. But the card is plus. Okay. That 10 plus. I take the amlodipine before I go to bed. Percocet as needed for severe pain.';
const NOTE = `### Subjective
- Takes Tylenol for severe pain

### Assessment & Plan
1. **Hypertension**
   - Start Cardizem CD 10 mg
   - Change Amlodipine to 2.5 mg, taking half of the 5 mg pill before bed
   - Medications: amlodipine 5 mg, Tylenol as needed`;

test('drugSaid: said, mis-heard by a letter, built on a said word, brand/generic pair; "card is plus" does not vouch for Cardizem', () => {
  assert.equal(drugSaid('Amlodipine', LR4LP), true);
  assert.equal(drugSaid('Amlodipin', 'I take amlodipine daily'), true);
  assert.equal(drugSaid('Hydrocortisone', 'and what is the cortisol thing? I mean the H is well.'), true);
  assert.equal(drugSaid('Rosuvastatin', 'you are on Crestor 40 mg'), true);   // brand said, generic written
  assert.equal(drugSaid('Cardizem', LR4LP), false);
  assert.equal(drugSaid('Tylenol', LR4LP), false);
  assert.equal(drugSaid('Venlafaxine', 'the Effexor made me dizzy'), true);   // brand said, generic written
  assert.equal(drugSaid('Pill', 'x'), true);   // too short to judge
  assert.equal(drugSaid('Glyburide', 'x', { patientMeds: ['Glyburide 5 mg'] }), true);   // on the patient's own list
});

test('unsaidDrugs finds a drug after a prescribing verb, in a medicines list, and leaves said drugs alone', () => {
  const found = unsaidDrugs(NOTE, LR4LP, { lexicon: LEX }).map((d) => d.term).sort();
  assert.deepEqual(found, ['Cardizem', 'Tylenol']);
});

test('fidelityGate removes only the unsaid drug from a list and keeps the rest', async () => {
  const g = await fidelityGate({ md: NOTE, transcript: LR4LP, lexicon: LEX, clean: true });
  assert.ok(!/Cardizem/.test(g.md) && !/Tylenol/.test(g.md));
  assert.match(g.md, /Medications: amlodipine 5 mg$/m);
  assert.match(g.md, /Change Amlodipine to 2\.5 mg/);
  assert.match(g.md, /^   - Change/m, 'sub-bullet indentation is kept');
  assert.equal(g.flags.length, 0, 'clean-note accounts get no flags');
  assert.deepEqual(g.meta.drugs.map((d) => d.drug).sort(), ['Cardizem', 'Tylenol']);
});

test('fidelityGate flags (as well as removes) for other accounts', async () => {
  const g = await fidelityGate({ md: NOTE, transcript: LR4LP, lexicon: LEX, clean: false });
  assert.equal(g.flags.length, 2); assert.ok(g.flags.every((f) => f.type === 'drug_not_said'));
});

test('impossibleValues: A1C 2.9 is cut, real values are not', () => {
  assert.equal(impossibleValues('A1C is 2.9, target less than 2').length, 1);
  assert.equal(impossibleValues('A1C 6.9').length, 0);
  assert.equal(impossibleValues('Triglycerides 2.9, elevated').length, 0);
  assert.equal(impossibleValues('BP 300/20').length, 1);
  assert.equal(impossibleValues('BP 128/82').length, 0);
  assert.equal(impossibleValues('Pulse 400').length, 1);
});

test('years: kept when said in digits or words, current year kept, others cut', async () => {
  assert.equal(yearSaid(2019, 'since twenty nineteen'), true);
  assert.equal(yearSaid(2019, 'since 2019'), true);
  assert.equal(yearSaid(2008, 'back in two thousand and eight'), true);
  assert.equal(yearSaid(2017, 'about five years ago'), false);
  const md = '### Past Medical History\n- Hypertension since 2017\n- Knee surgery in 2019\n   - Sub point here';
  const g = await fidelityGate({ md, transcript: 'I had my knee done in twenty nineteen and the blood pressure started about five years ago', clean: true });
  assert.match(g.md, /Hypertension$/m); assert.match(g.md, /Knee surgery in 2019/); assert.match(g.md, /^   - Sub point here$/m);
  assert.deepEqual(g.meta.years, ['2017']);
});

test('claimLines takes only plan actions written as done, not plans, requests or conditions', () => {
  const md = `### Objective\n- Exam normal\n\n### Assessment & Plan\n1. **Cough**\n   - Prescriptions printed\n   - Clinic to notify patient once the appointment is booked\n   - Patient needs a form printed\n   - Referral provided\n   - Follow up in two weeks`;
  assert.deepEqual(claimLines(md).map((c) => c.text), ['Prescriptions printed', 'Referral provided']);
});

const TR = 'We need a prescription for that. Like I know you gave us one last year. Do we need another? I will print the prescription now.';
const CANDS = [{ idx: 3, text: 'Prescription for sensor provided', kind: 'action' }, { idx: 4, text: 'Prescriptions printed', kind: 'action' }];
const ans = (checks) => JSON.stringify({ checks });

test('parseClaims acts on only_discussed only with a real quote that shows doubt and is about the line', () => {
  const a = parseClaims(ans([{ n: 1, verdict: 'only_discussed', quote: 'We need a prescription for that. Like I know you gave us one last year. Do we need another?' }]), CANDS, TR);
  assert.equal(a.length, 1);
  assert.equal(parseClaims(ans([{ n: 1, verdict: 'only_discussed', quote: 'we invented this quote entirely, never said' }]), CANDS, TR).length, 0, 'quote must be in the transcript');
  assert.equal(parseClaims(ans([{ n: 2, verdict: 'only_discussed', quote: 'I will print the prescription now' }]), CANDS, TR).length, 0, '"I will print it" shows no doubt');
  assert.equal(parseClaims('not json', CANDS, TR).length, 0);
  assert.equal(parseClaims(ans([{ n: 1, verdict: 'ok' }]), CANDS, TR).length, 0);
});

test('claims are shadow-only by default: the note is untouched and the verdict is recorded', async () => {
  const md = '### Assessment & Plan\n1. **Libre**\n   - Prescription for sensor provided';
  const llm = { generateContent: async () => ans([{ n: 1, verdict: 'only_discussed', quote: 'We need a prescription for that. Like I know you gave us one last year. Do we need another?' }]) };
  const g = await fidelityGate({ md, transcript: TR, clean: true, getLlm: async () => llm });
  assert.equal(g.md, md); assert.equal(g.meta.claims.shadow.length, 1);
  const act = await fidelityGate({ md, transcript: TR, clean: true, claimMode: 'act', getLlm: async () => llm });
  assert.ok(!/sensor provided/.test(act.md)); assert.equal(act.meta.claims.removed.length, 1);
});

test('a model that fails or answers nonsense leaves the note unchanged', async () => {
  const md = '### Assessment & Plan\n1. **Cough**\n   - Prescriptions printed';
  for (const getLlm of [async () => { throw new Error('down'); }, async () => ({ generateContent: async () => '###' })]) {
    const g = await fidelityGate({ md, transcript: TR, clean: true, claimMode: 'act', getLlm });
    assert.equal(g.md, md);
  }
});

// ── 2026-11-13, Seema's note km7o4: Dysglycemia from "your sugar is better", Hb 128 and 158, "Arrange Provide" ─────────────────────────────────────────────────────
import { unsupportedDiagnoses, labConflicts, fixDoubleVerb } from '../src/orchestrator/fidelityGate.js';
const KM_T = "Yeah, the hemoglobin is 158. I don't know. what I do. I like to work and see the big craft in the um um in question. before I took my first shot it was 128 my blood and today it's 128 with that uh iron I take. Blood pressure is good. You get a chocolate. Your sugar is better too. I take the Valsartan. And uric acid went down. 644 to 581 581 and then all new prescriptions for wig. It's arthritis.";
const KM_MD = `### Past Medical History
- Hypertension
- Elevated uric acid, now improved from 644 to 581.
- Dysglycemia
- Osteoarthritis
- Medications: iron every day, Valsartan

### Objective
- Bloods: Hb 128; uric acid decreased from 644 to 581
- Hemoglobin: 158; currently taking iron supplement daily, last year hemoglobin was 128 prior to first shot and is 128 today with iron

### Assessment & Plan
6. **Administrative**
   - Arrange Provide new prescriptions for wigs for tax purposes`;

test('unsupportedDiagnoses: a sugar remark does not make "Dysglycemia"; a treated, mentioned or named condition stays', () => {
  const bad = unsupportedDiagnoses(KM_MD, KM_T).map((d) => d.text);
  assert.deepEqual(bad, ['Dysglycemia']);   // Hypertension (blood pressure + Valsartan), uric acid (said), Osteoarthritis (arthritis said), Medications line: all kept
  assert.deepEqual(unsupportedDiagnoses('### Past Medical History\n- History of depression', 'we talked about your knee').map((d) => d.text), ['History of depression']);
  assert.equal(unsupportedDiagnoses('### Past Medical History\n- Type 2 diabetes', 'you take metformin twice a day').length, 0);
  assert.equal(unsupportedDiagnoses('### Subjective\n- Dysglycemia', KM_T).length, 0, 'only Past Medical History is judged');
});

test('labConflicts: 158 (said once, in filler) loses to 128 (said twice); a real change 644 -> 581 is untouched', () => {
  const c = labConflicts(KM_MD, KM_T);
  assert.equal(c.length, 1); assert.equal(c[0].lab, 'hemoglobin'); assert.equal(c[0].drop, '158'); assert.deepEqual(c[0].keep, ['128']);
  assert.equal(labConflicts('- Uric acid 644; uric acid 581', 'uric acid went down. 644 to 581').length, 0, 'both said once: no winner, nothing dropped');
  assert.equal(labConflicts('- Hb 128', KM_T).length, 0);
  // a value in a segment that carries a time or trend word is never dropped
  assert.equal(labConflicts('- Hemoglobin was 158 last year; Hb 128 today', "the hemoglobin is 158 I don't know um uh. it was 128 and it's 128").length, 0);
});

test('fixDoubleVerb keeps the verb next to its object and leaves real wording alone', () => {
  assert.equal(fixDoubleVerb('   - Arrange Provide new prescriptions for wigs'), '   - Provide new prescriptions for wigs');
  assert.equal(fixDoubleVerb('- Request Send referral to cardiology; Continue Metformin'), '- Send referral to cardiology; Continue Metformin');
  assert.equal(fixDoubleVerb('- Request Refill of metformin'), '- Request Refill of metformin');
  assert.equal(fixDoubleVerb('- Continue Metformin 1000 mg'), '- Continue Metformin 1000 mg');
  assert.equal(fixDoubleVerb('Arrange Provide x'), 'Arrange Provide x', 'only bullet lines');
});

test('fidelityGate on the real note: clean account loses the three problems; others keep PMH with a flag', async () => {
  const g = await fidelityGate({ md: KM_MD, transcript: KM_T, clean: true });
  assert.ok(!/Dysglycemia/.test(g.md)); assert.ok(!/158/.test(g.md)); assert.ok(!/Arrange Provide/.test(g.md));
  assert.match(g.md, /- Currently taking iron supplement daily, last year hemoglobin was 128/); assert.match(g.md, /- Bloods: Hb 128; uric acid decreased from 644 to 581/); assert.match(g.md, /^   - Provide new prescriptions/m);
  assert.equal(g.flags.length, 0);
  const o = await fidelityGate({ md: KM_MD, transcript: KM_T, clean: false });
  assert.match(o.md, /Dysglycemia/, 'not removed for accounts that see flags');
  assert.deepEqual(o.flags.map((f) => f.type).sort(), ['lab_conflict', 'pmh_unsupported']);
  assert.ok(!/158/.test(o.md) && !/Arrange Provide/.test(o.md));
});

// ── repeated lines, from Seema's note 4x15c ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
import { repeatedLines, lineTokens } from '../src/orchestrator/fidelityGate.js';
const REP_MD = `### Subjective
- Follow-up axillary ultrasound results
- Follow-up ultrasound recommended in 6 weeks, booked for December 3rd

- Hair thinning
- Clumps of hair coming out daily

### Objective
- Ultrasound bilateral axillae (14th): mild cortical thickening of bilateral axillary lymph nodes, benign/reactive/inflammatory appearance
- Follow-up ultrasound recommended in 6 weeks
- Bloods: hemoglobin normal; thyroid normal
- B12 low-normal
- Inflammatory markers mildly elevated
- B12: lower side of normal
- Thyroid: fine
- Ultrasound on the 14th showed mild cortical thickening of lymph nodes bilaterally, described as reactive or inflamed

### Assessment & Plan
2. **Hair thinning**
   - B12 on lower end of normal, thyroid normal`;

test('repeatedLines merges the four repeats of the real note and keeps everything else', () => {
  const r = repeatedLines(REP_MD).map((x) => x.text).sort();
  assert.deepEqual(r, ['B12 low-normal', 'Follow-up ultrasound recommended in 6 weeks', 'Thyroid: fine', 'Ultrasound on the 14th showed mild cortical thickening of lymph nodes bilaterally, described as reactive or inflamed'].sort());
});

test('repeatedLines never drops a group title, never mixes a negated line with a positive one, never ignores a number or a side', () => {
  const title = '### Subjective\n- Rash across stomach\n- Onset in March\n\n### Objective\n- Abdomen: rash across stomach and upper torso';
  assert.equal(repeatedLines(title).length, 0, 'the first line of a group is its title');
  assert.equal(repeatedLines('### Objective\n- Chest pain radiating to arm\n- No chest pain or shortness of breath').length, 0);
  assert.equal(repeatedLines('### Objective\n- BP 128/82\n- Pulse regular\n- Pulse regular 72 bpm').length, 1, 'the shorter pulse line goes');
  assert.equal(repeatedLines('### Objective\n- Pain in left knee\n- Pain in right knee, swollen').length, 0, 'left and right are different');
  assert.equal(repeatedLines('### Objective\n- A1C 6.9\n- A1C 6.1 and cholesterol normal').length, 0, 'different numbers');
});

test('repeatedLines: equal lines keep the longer text and never both go; Assessment & Plan is not touched', () => {
  const md = '### Objective\n- Blood pressure\n- Weight 200 lbs\n- Weight: 200 lbs\n\n### Assessment & Plan\n1. **Weight**\n   - Weight 200 lbs';
  const r = repeatedLines(md); assert.equal(r.length, 1); assert.equal(r[0].text, 'Weight 200 lbs');
  assert.ok(lineTokens('Thyroid: fine').has('norma'));
});

test('fidelityGate applies the merge, collapses the gap and records it', async () => {
  const g = await fidelityGate({ md: REP_MD, transcript: 'x'.repeat(10), clean: true });
  assert.equal(g.meta.repeats.length, 4);
  assert.ok(!/Thyroid: fine/.test(g.md) && !/B12 low-normal/.test(g.md));
  assert.match(g.md, /Bloods: hemoglobin normal; thyroid normal/); assert.match(g.md, /B12: lower side of normal/); assert.match(g.md, /\n   - B12 on lower end of normal, thyroid normal/);
  assert.ok(!/\n\n\n/.test(g.md));
});
