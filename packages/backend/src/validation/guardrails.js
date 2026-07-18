// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Validation & guardrails (schema v2.0.0 / Heidi template)
//
// Deterministic checks that run BEFORE a clinician sees the draft:
//   - schema validation
//   - NER cross-check: every medication the note asserts (metadata.medications_mentioned)
//     must be supported by a NER entity found in the transcript. Unsupported = flagged.
//   - empty-note flags (no subjective content, or no A&P issue)
// Nothing is silently dropped — failures become flags on metadata.flags.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { validateNote } from '@notera/schema';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const head = (line) => norm(line).split(' ')[0];

/** Cross-check the note's asserted medications against NER-extracted entities. */
export function crossCheckMeds(note, entities = []) {
  const flags = [];
  const nerMedTerms = new Set();
  for (const e of entities) {
    if (/DRUG|CHEMICAL|MEDICATION|MED7|TREATMENT/i.test(String(e.label || ''))) {
      nerMedTerms.add(head(e.text));
      nerMedTerms.add(norm(e.text));
    }
  }
  const noteMeds = Array.isArray(note?.metadata?.medications_mentioned) ? note.metadata.medications_mentioned : [];
  if (nerMedTerms.size === 0 || noteMeds.length === 0) return flags; // can't cross-check

  for (const med of noteMeds) {
    const h = head(med), full = norm(med);
    const supported = nerMedTerms.has(h) || nerMedTerms.has(full) ||
      [...nerMedTerms].some((t) => t && (full.includes(t) || t.includes(h)));
    if (!supported) {
      flags.push({
        type: 'unsupported_medication',
        field: 'assessment_and_plan.treatment_planned',
        message: `Medication "${med}" is not supported by any NER entity from the transcript — verify before sign-off.`,
        severity: 'critical',
      });
    }
  }
  return flags;
}

/** Flag a wholly-empty Subjective or a missing Assessment & Plan. */
export function checkEmptySections(note) {
  const flags = [];
  const subjEmpty = Object.values(note?.subjective || {}).every((v) => !String(v).trim());
  if (subjEmpty) flags.push({ type: 'empty_section', field: 'subjective', message: 'Subjective has no content.', severity: 'warning' });
  if (!Array.isArray(note?.assessment_and_plan) || note.assessment_and_plan.length === 0) {
    flags.push({ type: 'empty_section', field: 'assessment_and_plan', message: 'No Assessment & Plan issue was produced.', severity: 'warning' });
  } else {
    note.assessment_and_plan.forEach((it, i) => {
      if (!String(it.issue || '').trim()) flags.push({ type: 'missing_issue_name', field: `assessment_and_plan[${i}].issue`, message: `A&P item ${i + 1} has no issue name.`, severity: 'low' });
    });
  }
  return flags;
}

/** Low per-section confidence → reviewer attention. */
export function checkConfidence(note, threshold = 0.6) {
  const flags = [];
  const conf = note?.metadata?.confidence || {};
  for (const [section, score] of Object.entries(conf)) {
    if (typeof score === 'number' && score < threshold) {
      flags.push({ type: 'low_confidence', field: section, message: `Low confidence (${score.toFixed(2)}) in "${section}".`, severity: 'low' });
    }
  }
  return flags;
}

/**
 * Run the full guardrail suite; returns the note with flags appended.
 * @returns {{ note, status:'PASS'|'FLAGGED'|'INVALID', flags, schemaErrors }}
 */
export function runGuardrails(note, entities = [], opts = {}) {
  const { valid, errors } = validateNote(note);
  const flags = [
    ...crossCheckMeds(note, entities),
    ...checkEmptySections(note),
    ...checkConfidence(note, opts.confidenceThreshold),
  ];
  note.metadata = note.metadata || {};
  note.metadata.flags = [...(note.metadata.flags || []), ...flags];

  let status = 'PASS';
  if (!valid) status = 'INVALID';
  else if (flags.some((f) => f.severity === 'critical' || f.severity === 'warning')) status = 'FLAGGED';
  return { note, status, flags, schemaErrors: errors };
}
