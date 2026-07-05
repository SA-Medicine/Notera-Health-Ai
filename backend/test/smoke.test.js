// Notera backend smoke tests — v2.0.0 schema (Heidi template), no-API-key paths.
import { test } from 'node:test';
import assert from 'node:assert';

import { validateNote, emptyNote } from '../../schema/index.js';
import { deidentify, reidentify } from '../src/deid/deidentify.js';
import { structureNote } from '../src/orchestrator/structureNote.js';
import { runGuardrails, crossCheckMeds } from '../src/validation/guardrails.js';
import { store, audit } from '../src/firestore/store.js';

test('empty note is schema-valid (v2)', () => {
  const { valid, errors } = validateNote(emptyNote());
  assert.ok(valid, JSON.stringify(errors));
});

test('deidentify + reidentify round-trips PHI', () => {
  const src = 'Mr. John Smith, MRN: AB12345, called about chest pain. Phone 415-555-1234.';
  const { text, map } = deidentify(src);
  assert.ok(!text.includes('John Smith'));
  assert.ok(!text.includes('AB12345'));
  assert.ok(!text.includes('415-555-1234'));
  const restored = reidentify(text, map);
  assert.ok(restored.includes('AB12345'));
  assert.ok(restored.includes('415-555-1234'));
});

test('structureNote heading parser → schema-valid Heidi note', async () => {
  const md = `Chief Complaint:\nSore throat for 3 days.\n\nHPI:\nSore throat, mild fever, worse on swallowing.\n\nExamination:\nThroat red, no pus. Chest clear.\n\nAssessment:\nLikely viral pharyngitis.\n\nPlan:\nRest, fluids, paracetamol 500mg. Review in 1 week.`;
  const note = await structureNote(md, { specialty: 'general_primary_care', noteType: 'consultation', llm: null });
  const { valid, errors } = validateNote(note);
  assert.ok(valid, JSON.stringify(errors));
  assert.ok(note.subjective.reason_for_visit.includes('Sore throat'));
  assert.ok(note.objective.examination.toLowerCase().includes('throat'));
  assert.ok(note.assessment_and_plan.length >= 1);
});

test('crossCheckMeds flags an unsupported medication', () => {
  const note = emptyNote();
  note.metadata.medications_mentioned = ['Amoxicillin', 'Oxycodone'];
  const flags = crossCheckMeds(note, [{ text: 'Amoxicillin', label: 'DRUG' }]);
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /Oxycodone/);
  assert.equal(flags[0].severity, 'critical');
});

test('runGuardrails FLAGGED on unsupported med', () => {
  const note = emptyNote();
  note.subjective.hpi_details = 'cough';
  note.assessment_and_plan.push({ issue: 'Cough', diagnosis: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: 'Ghostazolam 10mg', referrals: '' });
  note.metadata.medications_mentioned = ['Ghostazolam'];
  const gr = runGuardrails(note, [{ text: 'Aspirin', label: 'DRUG' }]);
  assert.equal(gr.status, 'FLAGGED');
});

test('firestore memory store: consult lifecycle + audit', async () => {
  const consultId = 'CONS-TEST-1';
  await store.createConsult({ consultId, specialty: 'x', noteType: 'consultation', status: 'processing', createdAt: new Date().toISOString() });
  await store.addDraft(consultId, { draftId: 'D1', note: emptyNote(), status: 'PASS' });
  await audit({ consultId, actor: 'test', action: 'draft.created', target: 'D1' });
  const c = await store.getConsult(consultId);
  assert.equal(c.drafts.length, 1);
  assert.ok((await store.listConsults()).some((x) => x.consultId === consultId));
});
