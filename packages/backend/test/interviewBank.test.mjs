import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, allQuestions, cleanAnswer, partInfo } from '../studio/interviewBank.js';
import { SPEC } from '../studio/conformance.js';
import { profileMarkdown } from '../studio/interview.js';

test('the interview has three detailed parts and every question is well formed', () => {
  const b = bank(); assert.equal(b.length, 3);
  assert.ok(b[0].questions.length >= 25 && b[1].questions.length >= 40 && b[2].questions.length >= 35, 'each part is long');
  const ids = allQuestions().map((q) => q.id); assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const q of allQuestions()) {
    assert.ok(['single', 'multi', 'scale', 'text', 'rank', 'compare'].includes(q.type), q.id);
    assert.ok(q.prompt && q.prompt.length > 8, q.id); assert.ok(q.group, `${q.id} has a group`);
    if (['single', 'multi', 'rank', 'compare'].includes(q.type)) { assert.ok(q.options.length >= 2, `${q.id} options`); assert.equal(new Set(q.options.map((o) => o.id)).size, q.options.length, `${q.id} option ids`); }
    if (q.type === 'compare') for (const o of q.options) assert.ok(o.example, `${q.id} shows examples`);
    if (q.type === 'scale') assert.equal(q.labels.length, 2, q.id);
  }
});
test('the defining part reviews every rule of the approved Style Spec one by one', () => {
  const ids = new Set(partInfo(3).questions.map((q) => q.id));
  for (const r of SPEC.rules) assert.ok(ids.has(`p3.spec.${r.id}`), `rule ${r.id} is reviewed`);
  assert.ok(partInfo(3).questions.some((q) => /Always|Never/.test(q.prompt)), 'hard rules are asked');
  assert.ok(partInfo(3).questions.some((q) => q.type === 'rank'), 'priorities are ranked');
});
test('answers are validated per type', () => {
  const q = (type, extra = {}) => ({ id: 'x', type, prompt: 'p', ...extra });
  const opts = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
  assert.equal(cleanAnswer(q('scale'), 4).value, 4); assert.equal(cleanAnswer(q('scale'), 9).ok, false); assert.equal(cleanAnswer(q('scale'), 'x').ok, false);
  assert.equal(cleanAnswer(q('single', { options: opts }), 'b').value, 'b'); assert.equal(cleanAnswer(q('single', { options: opts }), 'z').ok, false);
  assert.deepEqual(cleanAnswer(q('single', { options: opts }), { choice: 'a', note: 'because' }).value, { choice: 'a', note: 'because' });
  assert.deepEqual(cleanAnswer(q('multi', { options: opts }), ['a', 'z', 'c']).value, ['a', 'c']); assert.equal(cleanAnswer(q('multi', { options: opts, required: true }), ['z']).ok, false);
  assert.deepEqual(cleanAnswer(q('rank', { options: opts }), ['c', 'a', 'b']).value, ['c', 'a', 'b']); assert.equal(cleanAnswer(q('rank', { options: opts }), ['c', 'a']).ok, false);
  assert.equal(cleanAnswer(q('text'), '  hello ').value, '  hello '); assert.equal(cleanAnswer(q('text', { required: true }), '').ok, false); assert.equal(cleanAnswer(q('text'), '').value, null);
  assert.equal(cleanAnswer(q('text'), 'x'.repeat(9000)).value.length, 6000);
});
test('the profile renders to readable markdown', () => {
  const md = profileMarkdown({ summary: 'A family doctor.', priorities: ['Nothing made up', 'Short'], sections: { subjective: [{ id: 'r1', text: 'Topic headings with short bullets.', confidence: 'low' }] }, hard_rules: ['Never write addresses'], terminology: { abbreviations_ok: ['HTN'], avoid: ['QD'] }, spec_v1_feedback: [{ rule: 'S2', verdict: 'change', change: 'longer bullets' }], contradictions: [], open_questions: ['Allergies placement'] });
  for (const s of ['# Style profile', '1. Nothing made up', '## Subjective', '(low confidence)', '## Hard rules', 'Never write addresses', 'S2: change — longer bullets', 'Allergies placement']) assert.ok(md.includes(s), s);
});
