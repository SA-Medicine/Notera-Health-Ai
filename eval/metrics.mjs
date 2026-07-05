// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Eval metrics (doc 03 §6) — schema v2.0.0 (Heidi template)
// ─────────────────────────────────────────────────────────────────────────────
import { validateNote } from '../schema/index.js';

// "Core" sections we expect a real consult to populate at least partially.
const CORE = [
  (n) => Object.values(n.subjective || {}).some((v) => String(v).trim()),
  (n) => Object.values(n.past_medical_history || {}).some((v) => String(v).trim()),
  (n) => Object.values(n.objective || {}).some((v) => String(v).trim()),
  (n) => Array.isArray(n.assessment_and_plan) && n.assessment_and_plan.length > 0,
];
const CORE_NAMES = ['subjective', 'past_medical_history', 'objective', 'assessment_and_plan'];

const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];

export function schemaValidity(note) {
  const { valid, errors } = validateNote(note);
  return { valid, errorCount: errors.length, errors };
}

export function sectionCoverage(note) {
  let present = 0; const missing = [];
  CORE.forEach((fn, i) => { if (fn(note)) present += 1; else missing.push(CORE_NAMES[i]); });
  return { present, total: CORE.length, coverage: present / CORE.length, missing };
}

/** meds asserted in the note (metadata.medications_mentioned) not supported by NER. */
export function medGrounding(note, entities = []) {
  const ner = new Set();
  for (const e of entities) {
    if (/DRUG|CHEMICAL|MEDICATION|MED7|TREATMENT/i.test(e.label || '')) ner.add(String(e.text).toLowerCase().split(/\s+/)[0]);
  }
  const meds = Array.isArray(note?.metadata?.medications_mentioned) ? note.metadata.medications_mentioned : [];
  if (!ner.size) return { checked: meds.length, unsupported: [], grounded: null };
  const unsupported = meds.filter((m) => {
    const head = String(m).toLowerCase().split(/\s+/)[0];
    return ![...ner].some((t) => t && (head.includes(t) || t.includes(head)));
  });
  return { checked: meds.length, unsupported, grounded: meds.length ? 1 - unsupported.length / meds.length : 1 };
}

export function similarityToGold(noteText, goldText) {
  const a = new Set(tokens(noteText)), b = new Set(tokens(goldText));
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter += 1;
  return inter / new Set([...a, ...b]).size;
}

export function omission(noteText, goldText) {
  const noteSet = new Set(tokens(noteText));
  const goldTerms = [...new Set(tokens(goldText))].filter((t) => t.length > 3);
  const missed = goldTerms.filter((t) => !noteSet.has(t));
  return { goldTerms: goldTerms.length, missed: missed.length, rate: goldTerms.length ? missed.length / goldTerms.length : 0 };
}

export function scoreNote({ note, noteText, goldText, entities }) {
  const sv = schemaValidity(note), sc = sectionCoverage(note), mg = medGrounding(note, entities);
  return {
    schema_valid: sv.valid, schema_errors: sv.errorCount,
    section_coverage: +sc.coverage.toFixed(3), missing_sections: sc.missing,
    meds_checked: mg.checked, meds_unsupported: mg.unsupported, med_grounding: mg.grounded,
    similarity_to_gold: +similarityToGold(noteText, goldText).toFixed(3),
    omission_rate: +omission(noteText, goldText).rate.toFixed(3),
  };
}

export function aggregate(rows) {
  const n = rows.length || 1;
  const avg = (k) => +(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) / n).toFixed(3);
  return {
    count: rows.length,
    schema_validity: +(rows.filter((r) => r.schema_valid).length / n).toFixed(3),
    avg_section_coverage: avg('section_coverage'),
    avg_similarity_to_gold: avg('similarity_to_gold'),
    avg_omission_rate: avg('omission_rate'),
    total_unsupported_meds: rows.reduce((s, r) => s + (r.meds_unsupported?.length || 0), 0),
  };
}
