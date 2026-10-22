import test from 'node:test';
import assert from 'node:assert/strict';
import { collectItems, askAttribution, applyAttribution, parseMoves, ATTR_SYS } from '../src/orchestrator/planAttribution.js';
import { dropThirdParty, thirdPartyLine } from '../src/orchestrator/qualityGuards.js';

const TX = 'We will book an ultrasound of your kidneys for the blood in the urine. Your B12 is low so start the supplement. The urologist Dr McLeod will do the scope.';
const mk = () => ({ assessment_and_plan: [
  { issue: 'Low B12', assessment: 'Low', investigations_planned: 'Ultrasound of the kidneys', treatment_planned: 'Start B12 supplement', referrals: 'Dr. McLeod for scope' },
  { issue: 'Haematuria', assessment: '', investigations_planned: 'Urine culture', treatment_planned: '', referrals: '' }] });

test('plan items are numbered with their kind and the problem they sit under', () => {
  const it = collectItems(mk()); assert.equal(it.length, 4); assert.deepEqual(it[0], { n: 1, pi: 0, field: 'investigations_planned', kind: 'Investigation', text: 'Ultrasound of the kidneys', });
  assert.equal(it[3].pi, 1);
});
test('a quoted move to an existing problem is applied; the text of the item is unchanged', async () => {
  const note = mk(); const llm = { generateContent: async () => JSON.stringify({ moves: [{ part: 1, to: 2, quote: 'ultrasound of your kidneys for the blood in the urine' }, { part: 3, to: 2, quote: 'Dr McLeod will do the scope' }] }) };
  const ans = await askAttribution(llm, note, TX); const r = applyAttribution(note, ans, TX);
  assert.equal(r.moved.length, 2); assert.equal(note.assessment_and_plan[0].investigations_planned, ''); assert.equal(note.assessment_and_plan[1].investigations_planned, 'Urine culture\nUltrasound of the kidneys');
  assert.equal(note.assessment_and_plan[0].treatment_planned, 'Start B12 supplement', 'the B12 treatment stays');
});
test('a move without a real quote, to a missing problem, or for an item that changed is refused', async () => {
  const note = mk(); const llm = { generateContent: async () => JSON.stringify({ moves: [{ part: 1, to: 2, quote: 'words that were never said in this visit at all' }, { part: 2, to: 9, quote: 'start the supplement' }] }) };
  const r = applyAttribution(note, await askAttribution(llm, note, TX), TX); assert.equal(r.moved.length, 0); assert.deepEqual(r.dropped.map((d) => d.why), ['quote not in the transcript', 'no such problem']);
  const n2 = mk(); const ans = await askAttribution({ generateContent: async () => JSON.stringify({ moves: [{ part: 1, to: 2, quote: 'ultrasound of your kidneys for the blood in the urine' }] }) }, n2, TX);
  n2.assessment_and_plan[0].investigations_planned = 'Something else'; assert.equal(applyAttribution(n2, ans, TX).dropped[0].why, 'item changed meanwhile');
});
test('one problem, bad model output, or a failed call never changes the note', async () => {
  const one = { assessment_and_plan: [{ issue: 'A', investigations_planned: 'X' }] }; assert.equal((await askAttribution({ generateContent: async () => { throw new Error('no'); } }, one, TX)).skipped, true);
  const note = mk(); const before = JSON.stringify(note); assert.equal(applyAttribution(note, { raw: 'nope', items: collectItems(note) }, TX).moved.length, 0);
  assert.equal(applyAttribution(note, await askAttribution({ generateContent: async () => { throw new Error('429'); } }, note, TX), TX).error, '429'); assert.equal(JSON.stringify(note), before);
  assert.deepEqual(parseMoves('{"moves":[]}'), []); assert.ok(ATTR_SYS.length > 100);
});
test('other people are removed from Past Medical History; the patient\'s own clauses, social line and family history stay', () => {
  assert.equal(thirdPartyLine('Boyfriend is 52, has hernia surgery coming up'), true);
  assert.equal(thirdPartyLine("Partner's ex-wife is moving to Toronto with her boyfriend and not seeing children regularly"), true);
  assert.equal(thirdPartyLine('Lives with wife; participating in Geriatric Assessment Program; house flooded'), false, 'the patient\'s own social line stays');
  assert.equal(thirdPartyLine('Lives with partner'), false); assert.equal(thirdPartyLine('Married, works as a teacher'), false); assert.equal(thirdPartyLine('Cousin had cancer'), false); assert.equal(thirdPartyLine('Mother had breast cancer'), false);
  const note = { past_medical_history: { social: ['Lives with partner', 'Patient in therapy for a long time; partner in therapy for 6 months for childhood trauma', 'Boyfriend is 52'].join('\n'), family: 'Cousin had cancer' } };
  const r = dropThirdParty(note); assert.equal(r.length, 2); assert.equal(note.past_medical_history.social, ['Lives with partner', 'Patient in therapy for a long time'].join('\n')); assert.equal(note.past_medical_history.family, 'Cousin had cancer');
});
