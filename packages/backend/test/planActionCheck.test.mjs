import test from 'node:test';
import assert from 'node:assert/strict';
import { planItems, evidenceFor, planActionCheck } from '../src/orchestrator/planActionCheck.js';
import { passages } from '../src/orchestrator/negationGuard.js';

const MD = '### Subjective\n- Cough\n### Assessment & Plan\n1. **Knee pain**\n   - Treatment planned:\n     - Started: Injection\n     - Continued: Ibuprofen 400 mg twice daily\n   - Referrals: Referral to Dr. Kokotswa\n   - Advice: Rest\n   - Follow-up: 2 weeks';
const TX = 'Doctor: There is a cartilage regeneration injection you could research, no decision today. Doctor: Keep taking the ibuprofen four hundred milligrams twice a day. Doctor: I will refer you to Dr. Kokotswa. Come back in two weeks.';
test('plan items that state a decision are picked out; advice is not', () => {
  const it = planItems(MD); assert.deepEqual(it.map((x) => x.label), ['Started', 'Continued', 'Referrals', 'Follow-up']);
});
test('each item gets only the passages that mention its own words', () => {
  const ps = passages(TX); const ev = evidenceFor({ text: 'Injection' }, ps); assert.ok(ev.length && /injection/i.test(ev[0]));
  assert.deepEqual(evidenceFor({ text: 'Warfarin dosing' }, ps), []);
});
test('an "option" verdict is only flagged when its quote is really in the recording; "done" is never flagged', async () => {
  const llm = { generateContent: async () => JSON.stringify({ items: [{ i: 1, verdict: 'option', quote: 'cartilage regeneration injection you could research', why: 'only an option' }, { i: 2, verdict: 'done' }, { i: 3, verdict: 'option', quote: 'words nobody said at all', why: 'made up' }] }) };
  const r = await planActionCheck(llm, MD, TX); assert.equal(r.checked, 4); assert.equal(r.flags.length, 1); assert.match(r.flags[0].message, /Injection.*only discussed/s);
});
