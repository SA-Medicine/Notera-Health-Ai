import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureUsage, currentUsage, withUsage } from '../src/services/LLMService.js';
import { usageSummary } from '../src/orchestrator/generateNoteV2.js';

test('usageSummary counts calls, tokens and thinking per model', () => {
  const u = usageSummary([{ model: 'a', agent: 'x', prompt: 10, output: 2, thoughts: 5 }, { model: 'a', agent: 'y', prompt: 1, output: 1, thoughts: 0 }, { model: 'b', agent: 'z', prompt: 7, output: 3 }]);
  assert.equal(u.calls, 3); assert.equal(u.prompt, 18); assert.equal(u.output, 6); assert.equal(u.thoughts, 5);
  assert.deepEqual(u.byModel.a, { calls: 2, prompt: 11, output: 3, thoughts: 5 }); assert.equal(u.byModel.b.calls, 1);
});
test('ensureUsage joins an existing usage context instead of opening a new one', async () => {
  const { calls } = await withUsage(async () => { await ensureUsage(async () => { currentUsage().push({ model: 'm', agent: 'a', prompt: 1, output: 1, thoughts: 0 }); }); });
  assert.equal(calls.length, 1, 'the call made inside ensureUsage lands in the outer context');
  let inner; await ensureUsage(async () => { inner = currentUsage(); });
  assert.ok(Array.isArray(inner), 'a new context is opened when there is none');
  assert.deepEqual(currentUsage(), [], 'outside any context there is nothing to count');
});
