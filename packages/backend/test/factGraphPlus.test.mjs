import test from 'node:test';
import assert from 'node:assert/strict';
import { addNewFacts } from '../src/orchestrator/factGraphPlus.js';
const f = (id, type, text, quote) => ({ id, type, text, quote });
test('a second reading adds only facts the first graph lacks, numbered after it', () => {
  const base = [f('F001', 'order', 'cholesterol panel', 'I am printing the paper for the blood work'), f('F002', 'medication', 'statin', 'just the statin')];
  const extra = [f('F001', 'order', 'cholesterol panel', 'I am printing the paper for the blood work'), f('F002', 'plan', 'calcium and vitamin D', 'and your calcium and vitamin D. Yes'), f('F003', 'medication', 'Statin', 'just the statin')];
  const add = addNewFacts(base, extra);
  assert.deepEqual(add.map((x) => x.id), ['F003']); assert.equal(add[0].text, 'calcium and vitamin D'); assert.equal(add[0].second, true);
});
test('nothing new gives an empty list', () => assert.deepEqual(addNewFacts([f('F001', 'a', 'x', 'q q q')], [f('F009', 'a', 'x', 'q q q')]), []));
