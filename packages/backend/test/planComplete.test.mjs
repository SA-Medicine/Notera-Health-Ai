import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptItems, applyComplete, isBare, parseItems, completePlan } from '../src/orchestrator/planComplete.js';
import { splitAdviceLines } from '../src/orchestrator/adviceLines.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';

const TX = 'Every time you come here, have the girls weigh you. All right, I am going to put you on something for the poop. I am going to give you the liquid lactulose. You will take 15 cc. Do it for two weeks and let me know how it goes. He gave you a pill for the large prostate. Flomax. The oxy, you do not take that, it will bind you up. Last week I saw him for the prostate.';
const problems = () => [
  { issue: 'Constipation', diagnosis: '', assessment: '', investigations_planned: '', treatment_planned: 'Liquid lactulose 15 cc', referrals: '', differential_diagnoses: [] },
  { issue: 'Weight loss', diagnosis: '', assessment: '', investigations_planned: '', treatment_planned: '', referrals: '', differential_diagnoses: [] },
  { issue: 'Benign prostatic hyperplasia', diagnosis: '', assessment: '', investigations_planned: '', treatment_planned: '', referrals: '', differential_diagnoses: [] },
];
const item = (o) => ({ n: 2, field: 'advice', text: 'weight check at every clinic visit', evidence: 'Every time you come here, have the girls weigh you', ...o });

test('a problem with nothing under its heading is bare; a differential or any line makes it not bare', () => {
  assert.equal(isBare(problems()[1]), true); assert.equal(isBare(problems()[0]), false);
  assert.equal(isBare({ issue: 'x', differential_diagnoses: ['a'] }), false);
});
test('a quoted decision is added; advice and follow-up become parts of the treatment line the splitter shows on their own lines', () => {
  const ps = problems(); const r = acceptItems([item(), item({ n: 1, field: 'follow_up', text: 'in two weeks, report back on the lactulose', evidence: 'Do it for two weeks and let me know how it goes' })], ps, TX);
  assert.equal(r.keep.length, 2); assert.equal(r.keep[0].part, 'Advised weight check at every clinic visit'); assert.match(r.keep[1].part, /^Follow-up in two weeks/);
  const note = { assessment_and_plan: ps, metadata: {} }; applyComplete(note, { raw: JSON.stringify({ items: [item(), item({ n: 1, field: 'follow_up', text: 'in two weeks, report back on the lactulose', evidence: 'Do it for two weeks and let me know how it goes' })] }) }, TX);
  const md = splitAdviceLines('### Assessment & Plan\n1. **Constipation**\n   - Treatment planned: ' + ps[0].treatment_planned + '\n2. **Weight loss**\n   - Treatment planned: ' + ps[1].treatment_planned);
  assert.match(md, /- Advice: Weight check at every clinic visit/); assert.match(md, /- Follow-up: In two weeks, report back on the lactulose/);
});
test('an item without a real quote, history, a stopped medicine and a repeat are dropped; no diagnosis is ever created', () => {
  const ps = problems();
  const why = (o, p = ps) => acceptItems([o], p, TX).dropped[0]?.why;
  assert.match(why(item({ evidence: 'we agreed he needs a gastric bypass operation soon' })), /quote/);
  assert.match(why(item({ n: 3, field: 'treatment', text: 'Flomax', evidence: 'Last week I saw him for the prostate' })), /history/);
  assert.match(why(item({ n: 3, field: 'treatment', text: 'oxy (stopped)', evidence: 'The oxy, you do not take that, it will bind you up' })), /stopped/);
  assert.match(why(item({ n: 1, field: 'treatment', text: 'liquid lactulose 15 cc', evidence: 'I am going to give you the liquid lactulose' })), /already/);
  assert.match(why(item({ n: 1, field: 'assessment', text: 'constipation', evidence: 'put you on something for the poop' })), /bare/);
  assert.match(why(item({ field: 'diagnosis' })), /unknown/); assert.match(why(item({ n: 9 })), /no such/);
});
test('a bare problem the model could fill is filled; one it cannot fill is removed; flagged instead when the model could not be asked', () => {
  const note = { assessment_and_plan: problems(), metadata: {} };
  const out = applyComplete(note, { raw: JSON.stringify({ items: [item()] }) }, TX);
  assert.deepEqual(note.assessment_and_plan.map((p) => p.issue), ['Constipation', 'Weight loss'], 'BPH had nothing said for it and its bare heading is gone');
  assert.deepEqual(out.removed, ['Benign prostatic hyperplasia']); assert.equal(out.added.length, 1);
  const n2 = { assessment_and_plan: problems(), metadata: {} };
  const o2 = applyComplete(n2, { raw: null, error: 'timeout' }, TX);
  assert.equal(n2.assessment_and_plan.length, 3, 'nothing is removed when the model was not asked'); assert.equal(o2.flagged.length, 2);
  assert.ok(n2.metadata.flags.every((f) => f.type === 'empty_plan' && f.severity === 'warning'));
  const n3 = { assessment_and_plan: problems().slice(1), metadata: {} };
  applyComplete(n3, { raw: '{"items":[]}' }, TX); assert.equal(n3.assessment_and_plan.length, 2, 'if every problem is bare they all stay');
  assert.deepEqual(parseItems('not json'), []);
});
test('completePlan asks once with the transcript and the numbered lines, and a rendered note has no bare problem left', async () => {
  const asked = []; const llm = { generateContent: async (sys, user) => { asked.push(user); return JSON.stringify({ items: [item(), item({ n: 3, field: 'treatment', text: 'continue Flomax', evidence: 'He gave you a pill for the large prostate. Flomax' })] }); } };
  const note = { assessment_and_plan: problems(), metadata: {} };
  const r = await completePlan(llm, note, TX);
  assert.equal(asked.length, 1); assert.match(asked[0], /2\. Weight loss\n\(no lines\)/); assert.equal(r.removed.length, 0);
  assert.ok(note.assessment_and_plan.every((p) => !isBare(p)));
  assert.equal(note.assessment_and_plan[2].treatment_planned, 'Continue Flomax');
});
