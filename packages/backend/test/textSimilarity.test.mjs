// Near-duplicate detection. The SAFETY cases matter more than the recall cases: a
// missed duplicate is cosmetic, a wrong merge silently deletes clinical information.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collapseRepetitions, compareText, conflictReason, contentTokens, dedupeList,
} from '../src/validation/textSimilarity.js';

const dup = (a, b) => compareText(a, b).duplicate;

test('paraphrases of the same clinical point are duplicates', () => {
  assert.ok(dup('HTN not adequately controlled', 'Hypertension is not well controlled'));
  assert.ok(dup('T2DM with suboptimal glycaemic control', 'Type 2 diabetes mellitus, glycemic control suboptimal'));
  assert.ok(dup('HbA1c 7.8% (above target)', 'Haemoglobin A1c 7.8 percent, above target'));
  assert.ok(dup('No fever', 'Denies fever'));
  assert.ok(dup('Refer to cardiology', 'Referral to cardiology arranged'));
  assert.ok(dup('Start lisinopril 10 mg', 'Commence lisinopril 10mg daily'));
});

test('condition synonyms collapse even with no shared words', () => {
  assert.ok(dup('Hypertension', 'Elevated blood pressure'));
  assert.ok(dup('Raised blood sugar', 'Type 2 diabetes mellitus'));
  assert.ok(dup('High cholesterol', 'Hyperlipidaemia'));
  assert.ok(dup('Acid reflux', 'GERD'));
});

test('a vague title is subsumed by the specific one', () => {
  assert.ok(dup('Anaemia', 'Iron deficiency anaemia'));
  assert.ok(dup('Diabetes', 'Type 2 diabetes mellitus'));
  assert.ok(dup('Continue amlodipine', 'Continue amlodipine 5 mg daily'));
});

test('conflicting numbers are never merged', () => {
  assert.equal(conflictReason('Haemoglobin 88 g/L', 'Hemoglobin 102 g/L'), 'different-numbers');
  assert.equal(conflictReason('Repeat HbA1c in 3 months', 'Repeat HbA1c in 6 months'), 'different-numbers');
  assert.equal(conflictReason('Amlodipine 5 mg daily', 'Amlodipine 10 mg daily'), 'different-numbers');
  assert.equal(conflictReason('Type 1 diabetes mellitus', 'Type 2 diabetes mellitus'), 'different-numbers');
});

test('conflicting medications are never merged', () => {
  assert.equal(conflictReason('Continue amlodipine', 'Continue metformin'), 'different-facts');
  assert.equal(conflictReason('LDL 4.2', 'HDL 4.2'), 'different-facts');
});

test('meaning markers are never merged away', () => {
  // Laterality — the most dangerous wrong merge in a musculoskeletal note.
  assert.equal(conflictReason('Left knee pain on flexion', 'Right knee pain on flexion'), 'different-meaning');
  // Negation: dropping "not" would invert the clinical statement.
  assert.equal(conflictReason('BP well controlled', 'BP not controlled'), 'different-meaning');
  assert.equal(conflictReason('Fever present', 'No fever'), 'different-meaning');
  assert.equal(conflictReason('Symptoms improving on treatment', 'Symptoms worsening on treatment'), 'different-meaning');
  assert.equal(conflictReason('Stop ibuprofen', 'Start ibuprofen'), 'different-meaning');
  assert.equal(conflictReason('Chronic kidney disease', 'Acute kidney injury'), 'different-meaning');
  assert.equal(conflictReason('Mild eczema', 'Severe eczema'), 'different-meaning');
  assert.equal(conflictReason('Patient declined Jardiance', 'Patient accepted Jardiance'), 'different-meaning');
});

test('unrelated clinical statements are not duplicates', () => {
  assert.ok(!dup('No fever', 'Denies chest pain'));
  assert.ok(!dup('Hypertension', 'Hypothyroidism'));
  assert.ok(!dup('Depression', 'Anxiety'));
  assert.ok(!dup('Advised rest', 'Revised the plan'));
});

test('plural and singular reach the same stem', () => {
  assert.deepEqual(contentTokens('mornings'), contentTokens('morning'));
  assert.deepEqual(contentTokens('headaches'), contentTokens('headache'));
  // The stemmer must not chew a word down to a fragment.
  assert.deepEqual(contentTokens('present'), ['present']);
});

test('dedupeList keeps the most informative phrasing', () => {
  const out = dedupeList(['Blood pressure is elevated', 'BP elevated at 150/95']);
  assert.deepEqual(out, ['BP elevated at 150/95']);
});

test('dedupeList carries its seen-set across calls for cross-section passes', () => {
  const seen = [];
  const first = dedupeList(['BP elevated at 150/95'], { seen });
  const second = dedupeList(['Blood pressure is elevated', 'Knee pain'], { seen });
  assert.deepEqual(first, ['BP elevated at 150/95']);
  assert.deepEqual(second, ['Knee pain']);
});

test('collapseRepetitions unwinds a speech-recognition decoder loop', () => {
  const looped = 'the pain is worse at night the pain is worse at night the pain is worse at night and radiates';
  assert.equal(collapseRepetitions(looped), 'the pain is worse at night and radiates');
  // A genuine spoken double survives; a long stutter run does not.
  assert.equal(collapseRepetitions('no no i said pain pain pain pain stopped'), 'no no i said pain pain stopped');
  assert.equal(collapseRepetitions('blood pressure is fine'), 'blood pressure is fine');
  assert.equal(collapseRepetitions(''), '');
});
