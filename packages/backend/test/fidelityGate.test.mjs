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
  const g = await fidelityGate({ md, transcript: 'I had my knee done in twenty nineteen and the pressure about five years ago', clean: true });
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
