import test from 'node:test';
import assert from 'node:assert/strict';
import { writerDraftIssue, pickDraft } from '../src/orchestrator/writerGuard.js';

const TX = Array.from({ length: 600 }, (_, i) => 'word' + i).join(' ');
const plan = [{ assessment: 'Sciatica', diagnosis: '', investigations: 'MRI', treatment: 'physio', referrals: '' }];
const good = { subjective: { reason_for_visit: 'Leg pain', symptom_progression: 'Worse when sitting\nLimp' }, assessment_and_plan: plan };

test('a normal draft passes', () => assert.equal(writerDraftIssue(good, TX), ''));
test('an empty or missing plan on a real consultation is flagged; on a short recording it is not', () => {
  assert.equal(writerDraftIssue({ ...good, assessment_and_plan: [] }, TX), 'no_plan');
  assert.equal(writerDraftIssue({ subjective: good.subjective }, TX), 'no_plan');
  assert.equal(writerDraftIssue({ ...good, assessment_and_plan: [{ assessment: '', treatment: '' }] }, TX), 'no_plan');
  assert.equal(writerDraftIssue({ ...good, assessment_and_plan: [] }, 'short chat only'), '');
});
test('a repetition loop is flagged (repeated line, or an absurdly long draft)', () => {
  const rep = { subjective: { symptom_progression: Array.from({ length: 40 }, () => 'Weight loss of 22 pounds reported').join('\n') } };
  assert.equal(writerDraftIssue(rep, TX), 'loop');
  const long = { subjective: { symptom_progression: Array.from({ length: 400 }, (_, i) => 'a different symptom line number ' + i).join('\n') }, assessment_and_plan: plan };
  assert.equal(writerDraftIssue(long, TX), 'loop');
});
test('the retry replaces the draft only when it is better', () => {
  const bad = { subjective: good.subjective, assessment_and_plan: [] };
  assert.equal(pickDraft(bad, good, TX).used, 'retry');
  assert.equal(pickDraft(bad, null, TX).used, 'original');
  assert.equal(pickDraft(bad, { ...bad }, TX).used, 'original', 'a retry with the same problem changes nothing');
  const loop = { subjective: { x: Array.from({ length: 40 }, () => 'the same repeated line again').join('\n') } };
  assert.equal(pickDraft(loop, bad, TX).used, 'retry', 'a missing plan is better than a loop');
  assert.equal(pickDraft(good, bad, TX).used, 'original');
});
