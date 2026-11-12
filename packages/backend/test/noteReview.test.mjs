import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, REVIEW_SYS } from '../src/admin/noteReview.js';

test('review parser: clean object from model JSON, unknown verdict becomes needs_work, junk and non-JSON are refused', () => {
  const r = parseReview('```json\n' + JSON.stringify({ verdict: 'great', what_it_says: 'A knee visit', captured: ['Knee x-ray ordered'], missed: [{ item: 'Dose of Motrin', transcript: 'six hundred' }, 'plain string'], not_supported: [{ note: 'Hypertension', why: 'not said' }], format: ['a'], extra: 1 }) + '\n```');
  assert.equal(r.verdict, 'needs_work'); assert.equal(r.what_it_says, 'A knee visit');
  assert.deepEqual(r.missed[0], { item: 'Dose of Motrin', transcript: 'six hundred' }); assert.equal(r.missed[1].item, 'plain string');
  assert.equal(r.not_supported[0].why, 'not said'); assert.deepEqual(r.plan_quality, []); assert.equal('extra' in r, false);
  assert.equal(parseReview('not json'), null);
  assert.equal(parseReview('{"verdict":"good"}').verdict, 'good');
});
test('the reviewer prompt asks for the six checks and a review, not a comparison', () => {
  for (const k of ['WHAT THE NOTE SAYS', 'CAPTURED', 'MISSED', 'NOT SUPPORTED', 'PLAN QUALITY', 'FORMAT', 'Do not compare']) assert.ok(REVIEW_SYS.includes(k), k);
});
