import test from 'node:test';
import assert from 'node:assert/strict';
import { guardDrugNames, medNames } from '../src/orchestrator/drugGuard.js';
import { emptyNote, emptyIssue } from '@notera/schema';

const mk = (other, plan) => { const n = emptyNote({}); n.past_medical_history.other = other; n.assessment_and_plan = [{ ...emptyIssue(), issue: 'Leg swelling', treatment_planned: plan }]; n.metadata.flags = []; return n; };

test('a drug the transcript never says is kept as spoken and flagged', () => {
  const transcript = 'I take two corinderol in the morning and a statin at night. The leg swelling started in June.';
  const note = mk('Current medications: Coricidin two in the morning, statin at night', 'Continue Coricidin as before');
  const r = guardDrugNames(note, transcript, { medications: [{ name: 'Coricidin' }] });
  assert.equal(r.replaced.length, 1);
  assert.match(note.past_medical_history.other, /Corinderol/);
  assert.doesNotMatch(note.past_medical_history.other + note.assessment_and_plan[0].treatment_planned, /Coricidin/);
  assert.equal(note.metadata.flags[0].type, 'medication_unverified');
});

test('a drug that is said (even with a different spelling) is left alone', () => {
  const transcript = 'She takes metformin and also lisinopril 10 mg every day.';
  const note = mk('Current medications: Metformin, Lisinopril 10 mg daily', 'Continue Metformin');
  const r = guardDrugNames(note, transcript, { medications: [{ name: 'Metformin' }, { name: 'Lisinopril' }, { name: 'Lisinoprill' }] });
  assert.equal(r.replaced.length, 0); assert.equal(r.flagged.length, 0); assert.equal(note.metadata.flags.length, 0);
});

test('a drug with nothing similar in the transcript is not kept: it becomes "medication (name unclear)" and is flagged with the name', () => {
  const note = mk('Current medications: Bisoprolol 5 mg daily', 'Continue Bisoprolol');
  const r = guardDrugNames(note, 'We talked about the swelling and the walking plan for next month.', { medications: [] });
  assert.equal(r.flagged.length, 1); assert.doesNotMatch(note.past_medical_history.other, /Bisoprolol/); assert.match(note.past_medical_history.other, /medication \(name unclear\)/);
  assert.match(note.metadata.flags[0].message, /Bisoprolol/);
});
test('a drug the recognizer split into two words is still said ("zep bound")', () => {
  const note = mk('Current medications: Zepbound 5 mg weekly', 'Continue Zepbound');
  const r = guardDrugNames(note, 'I am on zep bound once a week and it is going fine.', { medications: [] });
  assert.equal(r.flagged.length, 0); assert.match(note.past_medical_history.other, /Zepbound/);
});

test('generic words and multi-word names are not treated as drugs', () => {
  const note = mk('Current medications: vitamin D, fish oil, pills', '');
  assert.deepEqual(medNames(note, { medications: [{ name: 'medication' }, { name: 'Fish oil' }] }), []);
});
