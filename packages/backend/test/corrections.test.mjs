import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEvents, diffLines, mergeFeedback, resolvedMessages, MAX_EVENTS_STORED } from '../src/library/corrections.js';

test('events are cleaned: unknown actions dropped, strings cut, time kept or defaulted', () => {
  const r = cleanEvents([{ action: 'removed', flagType: 'check_against_recording', flagMessage: 'x'.repeat(900), before: 'Stable', at: '2026-10-22T10:00:00Z' }, { action: 'hack' }, null, { action: 'kept', at: 'not a date' }]);
  assert.equal(r.length, 2); assert.equal(r[0].flagMessage.length, 400); assert.equal(r[0].at, '2026-10-22T10:00:00.000Z'); assert.equal(r[1].action, 'kept'); assert.ok(Date.parse(r[1].at));
  assert.deepEqual(cleanEvents('nope'), []);
});
test('the diff lists lines removed and added, ignoring bullets, bold and headings', () => {
  const gen = '### Subjective\n- Acid reflux\n- Non-smoker\n### Assessment & Plan\n1. **Reflux**\n   - Treatment planned: PPI';
  const fin = '### Subjective\n- Acid reflux\n### Assessment & Plan\n1. **Reflux**\n   - Treatment planned: pantoprazole 40 mg';
  const d = diffLines(gen, fin); assert.deepEqual(d.removed, ['Non-smoker', 'Treatment planned: PPI']); assert.deepEqual(d.added, ['Treatment planned: pantoprazole 40 mg']); assert.ok(d.editRate > 0);
  assert.equal(diffLines(gen, gen).editRate, 0);
});
test('feedback keeps the older events, appends the new ones and caps the total', () => {
  const m = mergeFeedback({ events: [{ action: 'kept' }] }, [{ action: 'removed' }], { removed: [] }); assert.equal(m.events.length, 2);
  const big = mergeFeedback({ events: Array.from({ length: MAX_EVENTS_STORED }, () => ({ action: 'kept' })) }, [{ action: 'removed' }], {}); assert.equal(big.events.length, MAX_EVENTS_STORED); assert.equal(big.events.at(-1).action, 'removed');
});
test('a flag the clinician resolved stays resolved until they undo it', () => {
  const s = resolvedMessages([{ flagMessage: 'A', action: 'kept' }, { flagMessage: 'B', action: 'removed' }, { flagMessage: 'B', action: 'undone' }]);
  assert.ok(s.has('A')); assert.ok(!s.has('B'));
});
