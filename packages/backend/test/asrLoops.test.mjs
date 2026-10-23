import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseLoops } from '../src/asr/loops.js';

test('a run of the same word thousands of times is cut to two copies; the real speech around it is kept', () => {
  const text = 'So you saw him in August. ' + 'Yeah. '.repeat(7995) + 'And then the colonoscopy next month.';
  const r = collapseLoops(text);
  assert.equal(r.text, 'So you saw him in August. Yeah. Yeah. And then the colonoscopy next month.'); assert.deepEqual(r.collapsed, [{ unit: 'Yeah.', reps: 7995 }]);
});
test('a loop of a short phrase is found; ordinary repetition in speech is left alone', () => {
  const r = collapseLoops('ok ' + 'yes it is, '.repeat(12) + 'fine'); assert.equal(r.collapsed.length, 1); assert.equal(r.collapsed[0].reps, 12); assert.equal(r.text, 'ok yes it is, yes it is, fine');
  const speech = 'No no no no, I never take that. Yeah yeah yeah. Take one, take one, take one tablet.'; const s = collapseLoops(speech); assert.equal(s.text, speech); assert.equal(s.collapsed.length, 0);
});
test('empty and short input are safe', () => { assert.equal(collapseLoops('').text, ''); assert.equal(collapseLoops(null).collapsed.length, 0); assert.equal(collapseLoops('hello').text, 'hello'); });
