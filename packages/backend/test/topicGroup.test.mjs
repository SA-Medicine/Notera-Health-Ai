import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrouped, groupSubjective } from '../src/orchestrator/topicGroup.js';
import { acceptAdditions } from '../src/orchestrator/planSweep.js';

const L = ['Hacking cough for 2 weeks', 'Worse at night', 'Heartburn controlled with famotidine', 'Takes famotidine sometimes', 'Hair loss for 3 months'];

test('lines are grouped under headings, every line exactly once, none reworded', () => {
  const t = buildGrouped(L, [{ heading: 'Cough', lines: [1, 2] }, { heading: 'Heartburn', lines: [3, 4] }, { heading: 'Hair Loss', lines: [5] }]);
  assert.equal(t, 'Cough:\nHacking cough for 2 weeks\nWorse at night\nHeartburn:\nHeartburn controlled with famotidine\nTakes famotidine sometimes\nHair Loss:\nHair loss for 3 months');
});
test('a line the model forgot is kept, a repeated or unknown line number is ignored', () => {
  const t = buildGrouped(L, [{ heading: 'Cough', lines: [1, 2, 2, 9] }, { heading: 'Heartburn', lines: [3] }]);
  assert.ok(t.includes('Takes famotidine sometimes') && t.includes('Hair loss for 3 months')); assert.equal(t.split('\n').filter((x) => !x.endsWith(':')).length, 5);
});
test('bad headings or empty groups give nothing', () => { assert.equal(buildGrouped(L, [{ heading: '1234', lines: [1] }, { heading: 'Cough', lines: [] }]), null); assert.equal(buildGrouped(L, null), null); });
test('the stage uses the model answer and refuses short Subjectives', async () => {
  const llm = { generateContent: async () => JSON.stringify({ groups: [{ heading: 'Cough', lines: [1, 2] }, { heading: 'Heartburn', lines: [3, 4, 5] }] }) };
  const out = await groupSubjective(llm, { hpi_details: L.join('\n') }); assert.match(out, /^Cough:\nHacking cough/);
  assert.equal(await groupSubjective(llm, { hpi_details: 'one\ntwo' }), null);
  assert.equal(await groupSubjective({ generateContent: async () => 'not json' }, { hpi_details: L.join('\n') }), null);
});
test('the plan sweep ignores events from an earlier visit', () => {
  const tx = 'And we gave you the tetanus shot at the last visit, so that is done.';
  const r = acceptAdditions([{ title: 'Tetanus vaccination', treatment_planned: 'Tetanus shot given', evidence: 'we gave you the tetanus shot at the last visit' }], [], tx);
  assert.equal(r.keep.length, 0); assert.match(r.dropped[0].why, /earlier visit/);
});

import { groupSubjectiveFields } from '../src/orchestrator/topicGroup.js';
test('the fallback also groups history that sits in the other Subjective fields', async () => {
  const sub = { reason_for_visit: 'Eye redness', hpi_details: 'Left eye red since Monday', symptom_progression: 'Itching worse in the sun\nUsing Visine twice daily', functional_impact: 'Cannot wear contact lenses' };
  const llm = { generateContent: async () => JSON.stringify({ groups: [{ heading: 'Eye Redness', lines: [1, 2, 3] }, { heading: 'Impact on Function', lines: [4] }] }) };
  const g = await groupSubjectiveFields(llm, sub); assert.match(g.text, /^Eye Redness:\nLeft eye red since Monday\nItching worse in the sun\nUsing Visine twice daily\nImpact on Function:\nCannot wear contact lenses$/);
  assert.deepEqual(g.moved.sort(), ['functional_impact', 'symptom_progression']);
  assert.equal(await groupSubjectiveFields(llm, { hpi_details: 'one\ntwo' }), null);
});

test('a group called Presenting Complaint is renamed, never a second one', () => {
  const t = buildGrouped(['Cough', 'Fever', 'Sore throat'], [{ heading: 'Presenting Complaint', lines: [1, 2] }, { heading: 'Throat', lines: [3] }]);
  assert.ok(!/Presenting Complaint/i.test(t)); assert.match(t, /^History:\nCough\nFever\nThroat:\nSore throat$/);
});
