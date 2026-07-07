// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Note schema loader + validator (v2.0.0, Heidi template)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = '2.0.0';

export const noteSchema = JSON.parse(
  readFileSync(join(__dirname, `note.schema.v${SCHEMA_VERSION}.json`), 'utf8')
);

const ajv = new Ajv({ allErrors: true, strict: false });
const _validate = ajv.compile(noteSchema);

/**
 * Validate a note object against the versioned schema.
 * @param {object} note
 * @returns {{ valid: boolean, errors: Array<{path:string, message:string}> }}
 */
export function validateNote(note) {
  const valid = _validate(note);
  const errors = valid
    ? []
    : (_validate.errors || []).map((e) => ({
        path: e.instancePath || e.schemaPath,
        message: `${e.instancePath || '(root)'} ${e.message}`,
      }));
  return { valid, errors };
}

/** An empty A&P issue block. */
export function emptyIssue() {
  return { issue: '', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '' };
}

/** A minimal valid, all-blank note in the Heidi template shape. */
export function emptyNote({ specialty = 'general_primary_care', noteType = 'consultation', generatedBy = 'notera-pipeline' } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    note_type: noteType,
    specialty,
    subjective: {
      reason_for_visit: '',
      hpi_details: '',
      aggravating_relieving_factors: '',
      symptom_progression: '',
      previous_episodes: '',
      functional_impact: '',
      associated_symptoms: '',
    },
    past_medical_history: {
      medical_surgical: '',
      social: '',
      family: '',
      exposure: '',
      immunisation: '',
      other: '',
    },
    objective: {
      vital_signs: '',
      examination: '',
      completed_investigations: '',
    },
    assessment_and_plan: [],
    metadata: { generated_by: generatedBy, encounter_id: null, confidence: {}, medications_mentioned: [], flags: [] },
  };
}
