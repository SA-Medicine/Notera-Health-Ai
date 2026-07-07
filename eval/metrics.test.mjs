import { test } from 'node:test';
import assert from 'node:assert';
import { sectionCoverage, medGrounding, similarityToGold, scoreNote } from './metrics.mjs';
import { emptyNote } from '../schema/index.js';

test('sectionCoverage: empty note has 0 of 4 core sections', () => {
  const cov = sectionCoverage(emptyNote());
  assert.equal(cov.present, 0);
  assert.equal(cov.total, 4);
});

test('medGrounding catches an unsupported med (metadata list)', () => {
  const note = emptyNote();
  note.metadata.medications_mentioned = ['Amoxicillin', 'Ghostazolam'];
  const mg = medGrounding(note, [{ text: 'Amoxicillin', label: 'DRUG' }]);
  assert.equal(mg.unsupported.length, 1);
  assert.match(mg.unsupported[0], /Ghostazolam/);
});

test('similarityToGold: 1 for identical, <1 otherwise', () => {
  assert.equal(similarityToGold('sore throat fever', 'sore throat fever'), 1);
  assert.ok(similarityToGold('sore throat', 'sore throat fever cough') < 1);
});

test('scoreNote returns a full row for a populated v2 note', () => {
  const note = emptyNote();
  note.subjective.reason_for_visit = 'cough';
  note.objective.examination = 'chest clear';
  note.assessment_and_plan.push({ issue: 'Bronchitis', diagnosis: 'acute bronchitis', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: 'supportive care', referrals: '' });
  const s = scoreNote({ note, noteText: 'cough bronchitis', goldText: 'cough bronchitis fever', entities: [] });
  assert.equal(s.schema_valid, true);
  assert.ok(s.section_coverage > 0);
});
