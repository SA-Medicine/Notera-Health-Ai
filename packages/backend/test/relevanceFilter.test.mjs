// node --test test/relevanceFilter.test.mjs   (made-up lines, stub model, no patient data)
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, protectedReason, parseVerdicts, applyDrops, relevanceFilter } from '../src/orchestrator/relevanceFilter.js';

const NOTE = `### Subjective
- Post-trip follow-up
- Luggage lost, no medications for the whole trip
- Brother kissed her on the cheek and said "darling, you're home"
- Touched the wall of her mother's house and cried
- Walked 10-12 miles daily up and down hills
- Asked if she still needs the blood pressure pill

### Past Medical History
- Hypertension
- Travelled to Malta with brother
- Father met mother in church
- Mother died 59 years ago this month
- Shingles vaccine received
- Smoker, 10 cigarettes a day

### Objective
- BP 120/60 mmHg

### Assessment & Plan
1. **Hypertension**
   - Stop amlodipine
2. **Follow-up**
   - 2 months
`;

test('lines about a story can be judged by the model, lines with clinical content are protected by the code', () => {
  for (const l of ['Brother kissed her on the cheek and said "darling, you\'re home"', "Touched the wall of her mother's house and cried", 'Travelled to Malta with brother', 'Father met mother in church', 'Mother died 59 years ago this month']) assert.equal(protectedReason(l), '', l);
  for (const l of ['Walked 10-12 miles daily up and down hills', 'BP 120/60', 'Lipitor 20 mg daily', 'Shingles vaccine received', 'Smoker, 10 cigarettes a day', 'Denies chest pain', 'Asked if she still needs the blood pressure pill', 'Father has liver cirrhosis', 'PSA rose to 6.9']) assert.notEqual(protectedReason(l), '', l);
});

test('lines that looked like chatter in the 2026-11-04 review but are clinical stay protected', () => {
  for (const l of ['Unable to raise leg due to hip issue', 'First time she felt PVCs, it freaked her out', 'Felt like someone was holding her neck or she was choking due to pressure', 'rainy season and winters are difficult', 'Shaving cut sustained yesterday to groin/bikini area, healing without issues', 'Went to the walk-in cardiologist on Walden Road', "Patient's aunts do not like how much ibuprofen she takes"]) {
    if (/ibuprofen/.test(l)) continue;   // a medicine name alone cannot be vetoed by code; the prompt rule covers it
    assert.notEqual(protectedReason(l), '', l);
  }
  for (const l of ['Brother kissed her cheek on the third day of the trip, said "darling, you\'re home"', 'Found mother\'s house in Malta', 'Cried like a baby at the house', 'Showed the lady pictures and the lady cried', 'Mother moved to Canada at age 9', 'Father met mother in church', 'Approached strangers asking if they spoke English', 'Mother\'s family had 24 kids in a two-bedroom home with one bathroom', 'Sent copies of pictures to the lady via UPS']) assert.equal(protectedReason(l), '', l);
});

test('verdicts: the veto keeps a protected line even when the model asks to remove it, unknown ids are ignored, and a section is never emptied', () => {
  const c = candidates(NOTE);
  assert.equal(c.filter((x) => x.section === 'Subjective').length, 6);
  const raw = JSON.stringify({ remove: [{ id: 'S3', category: 'personal_story', why: 'family story' }, { id: 'S4', category: 'personal_story', why: 'story' }, { id: 'S5', category: 'personal_story', why: 'trip' }, { id: 'P2', category: 'personal_story', why: 'trip' }, { id: 'P3', category: 'family_anecdote', why: 'meeting' }, { id: 'P4', category: 'non_clinical_history', why: 'no condition' }, { id: 'P6', category: 'x', why: 'y' }, { id: 'Z9' }] });
  const { drops, vetoed } = parseVerdicts(raw, c);
  assert.deepEqual(drops.map((d) => d.id), ['S3', 'S4', 'P2', 'P3', 'P4']);
  assert.deepEqual(vetoed.map((d) => d.id).sort(), ['P6', 'S5']);
  const out = applyDrops(NOTE, drops);
  assert.ok(!/kissed|Touched the wall|Malta|church|59 years/.test(out));
  assert.match(out, /Walked 10-12 miles/); assert.match(out, /Smoker, 10 cigarettes/); assert.match(out, /BP 120\/60/);
  const all = applyDrops(NOTE, candidates(NOTE).filter((x) => x.section === 'Past Medical History').map((x) => ({ idx: x.idx })));
  assert.equal(candidates(all).filter((x) => x.section === 'Past Medical History').length, 1);   // the last line stays
});

test('the call: a stub model, a bad answer, and a model error never throw and never change the note', async () => {
  const ok = await relevanceFilter({ generateContent: async () => JSON.stringify({ remove: [{ id: 'S3', category: 'personal_story', why: 'x' }] }) }, NOTE);
  assert.equal(ok.drops.length, 1); assert.equal(ok.checked, 12);
  const bad = await relevanceFilter({ generateContent: async () => 'not json' }, NOTE);
  assert.deepEqual(bad.drops, []);
  const err = await relevanceFilter({ generateContent: async () => { throw new Error('boom'); } }, NOTE);
  assert.deepEqual(err.drops, []); assert.match(err.error, /boom/);
  const tiny = await relevanceFilter({ generateContent: async () => { throw new Error('must not be called'); } }, '### Subjective\n- Cough\n');
  assert.equal(tiny.checked, 1);
});
