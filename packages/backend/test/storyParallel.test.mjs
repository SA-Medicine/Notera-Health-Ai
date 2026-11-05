import test from 'node:test';
import assert from 'node:assert/strict';
import { storyPass } from '../src/orchestrator/generateNoteV2.js';

const note = () => ({ metadata: {}, subjective: { reason_for_visit: 'Cough', hpi_details: 'Dry cough for 3 days\nWorse at night\nNo fever\nNo wheeze' }, past_medical_history: { other: 'Medications: Ventolin as needed' } });
const GOOD = JSON.stringify({ subjective: { reason_for_visit: 'Presenting Complaint:\n- Cough', hpi_details: 'Cough:\n- Dry cough for 3 days, worse at night\n- No fever or wheeze' }, past_medical_history: { other: 'Medications: Ventolin as needed' } });
const BAD = 'not json';
const fake = (answers) => { let i = 0; const calls = []; return { calls, _agent: '', generateContent: async () => { const n = i++; calls.push(n); await new Promise((r) => setTimeout(r, answers[n]?.[1] ?? 5)); return answers[n]?.[0] ?? BAD; } }; };
const TX = 'Doctor: any cough? Patient: a dry cough for 3 days, worse at night, no fever, no wheeze. I use Ventolin as needed.';

test('sequential (default): a rejected first answer is retried and the second is kept', async () => {
  delete process.env.STORY_PARALLEL; const llm = fake([[BAD], [GOOD]]);
  const r = await storyPass(llm, note(), TX, () => {}, {}); assert.ok(r.out); assert.equal(r.why, 'applied on retry'); assert.equal(llm.calls.length, 2);
});
test('STORY_PARALLEL=1: the first two attempts start together and the first valid answer wins, even if it is the second one', async () => {
  process.env.STORY_PARALLEL = '1'; try {
    const llm = fake([[BAD, 5], [GOOD, 30]]); const t0 = Date.now();
    const r = await storyPass(llm, note(), TX, () => {}, {}); assert.ok(r.out); assert.equal(llm.calls.length, 2, 'both were asked at once, no third call'); assert.ok(Date.now() - t0 < 500);
    const both = fake([[BAD], [BAD], [GOOD]]); const r2 = await storyPass(both, note(), TX, () => {}, {}); assert.ok(r2.out, 'a third attempt still runs when both are rejected'); assert.equal(both.calls.length, 3);
  } finally { delete process.env.STORY_PARALLEL; }
});

test('time guard: past the budget no retry starts (the first attempt always runs); on time, the retry still runs', async () => {
  delete process.env.STORY_PARALLEL;
  const late = fake([[BAD], [GOOD]]); const logs = [];
  const r = await storyPass(late, note(), TX, (m) => logs.push(m), { budgetUntil: Date.now() - 1 });
  assert.equal(r.out, null); assert.equal(late.calls.length, 1, 'only the first attempt'); assert.ok(logs.some((l) => /no retry 2/.test(l)));
  const onTime = fake([[BAD], [GOOD]]);
  const r2 = await storyPass(onTime, note(), TX, () => {}, { budgetUntil: Date.now() + 60000 }); assert.ok(r2.out); assert.equal(onTime.calls.length, 2);
  const firstOk = fake([[GOOD]]); const r3 = await storyPass(firstOk, note(), TX, () => {}, { budgetUntil: Date.now() - 1 }); assert.ok(r3.out, 'a late note still gets its first story attempt');
});
