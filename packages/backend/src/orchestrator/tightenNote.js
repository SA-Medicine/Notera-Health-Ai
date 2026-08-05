// ─────────────────────────────────────────────────────────────────────────────
// tightenNote — LLM "gold-style tightener" (optional agent).
//
// Re-reads the raw transcript + the current draft note and rewrites it to match the
// gold house style: (a) COMPLETE — pulls in clinical facts the pipeline dropped, esp.
// PLAN actions (new/changed meds with dose, destination pharmacy, referrals, exact
// return-to-clinic timing) and ALL investigation results incl. normals; (b) CONCISE —
// trims conversational filler and cross-section repetition; (c) GROUNDED — never invents
// a fact not in the transcript. Returns the SAME schema note so the deterministic
// guardrails + condenser + renderer still run afterward.
//
// Opt-in via NOTE_TIGHTENER=1. Robust: any error / bad JSON → returns the input note.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { noteToMarkdown } from './renderMarkdown.js';

// Local blank note in the v2 Heidi schema shape (kept in sync with schema/index.js) —
// inlined so this agent is self-contained and unit-testable without workspace resolution.
function emptyNote({ specialty = 'general_primary_care', noteType = 'consultation' } = {}) {
  return {
    schema_version: '2.0.0', note_type: noteType, specialty,
    subjective: { reason_for_visit: '', hpi_details: '', aggravating_relieving_factors: '', symptom_progression: '', previous_episodes: '', functional_impact: '', associated_symptoms: '' },
    past_medical_history: { medical_surgical: '', social: '', family: '', exposure: '', immunisation: '', other: '' },
    objective: { vital_signs: '', examination: '', completed_investigations: '' },
    assessment_and_plan: [],
    metadata: { confidence: {}, medications_mentioned: [], flags: [] },
  };
}

const SYS = `You are a meticulous clinical documentation editor. You receive the raw consultation TRANSCRIPT (the sole source of truth) and a DRAFT SOAP note. Produce a corrected, concise, gold-standard note as JSON.

RULES (in priority order):
1. GROUNDING — include ONLY facts explicitly present in the transcript. Never invent or infer a name, number, date, dose, pharmacy, or clinical detail. If the draft contains anything not supported by the transcript, DELETE it.
2. COMPLETENESS — capture EVERY clinically relevant fact from the transcript. In particular the PLAN: every new or changed medication WITH its dose/frequency, the destination pharmacy, any referral, and the exact return-to-clinic timing. Also record ALL investigation results, including normal ones (e.g. "B12 normal", "cholesterol normal").
3. CONCISENESS — short clinical points, not prose. Omit small talk and non-actionable filler. Do not repeat the same fact across sections at the same level of detail.
4. STRUCTURE — Subjective and Objective may stay detailed; Assessment & Plan is concise: one numbered problem each, with a diagnosis and terse plan points.

Return ONLY this JSON object (no markdown, no commentary). Every string field is newline-separated short points:
{
  "subjective": { "reason_for_visit": "", "hpi_details": "", "aggravating_relieving_factors": "", "symptom_progression": "", "previous_episodes": "", "functional_impact": "", "associated_symptoms": "" },
  "past_medical_history": { "medical_surgical": "", "social": "", "family": "", "exposure": "", "immunisation": "", "other": "" },
  "objective": { "vital_signs": "", "examination": "", "completed_investigations": "" },
  "assessment_and_plan": [ { "issue": "", "diagnosis": "", "assessment": "", "investigations_planned": "", "treatment_planned": "", "referrals": "" } ]
}`;

// compact robust parse: strip fences → JSON.parse → close a truncated object
function safeParse(raw) {
  const s = String(raw || '').replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch { /* repair */ }
  const start = s.indexOf('{'); if (start < 0) return null;
  const body = s.slice(start); let inStr = false, esc = false; const stack = [];
  for (let k = 0; k < body.length; k++) { const c = body[k]; if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']'); else if (c === '}' || c === ']') stack.pop(); }
  let out = body; if (inStr) out += '"'; out = out.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, ''); while (stack.length) out += stack.pop(); out = out.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(out); } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v.trim() : (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : ''));

// Merge the model's JSON into a valid schema note, preserving metadata/specialty.
function buildNote(currentNote, parsed) {
  const n = emptyNote({ specialty: currentNote.specialty, noteType: currentNote.note_type });
  n.metadata = currentNote.metadata || n.metadata;
  const sub = parsed.subjective || {};
  for (const k of Object.keys(n.subjective)) n.subjective[k] = str(sub[k]);
  const pmh = parsed.past_medical_history || {};
  for (const k of Object.keys(n.past_medical_history)) n.past_medical_history[k] = str(pmh[k]);
  const obj = parsed.objective || {};
  for (const k of Object.keys(n.objective)) n.objective[k] = str(obj[k]);
  const ap = Array.isArray(parsed.assessment_and_plan) ? parsed.assessment_and_plan : [];
  n.assessment_and_plan = ap.filter((p) => p && (str(p.issue) || str(p.diagnosis) || str(p.assessment) || str(p.treatment_planned))).map((p) => ({
    issue: str(p.issue), diagnosis: str(p.diagnosis), assessment: str(p.assessment),
    differential_diagnoses: Array.isArray(p.differential_diagnoses) ? p.differential_diagnoses.filter((x) => typeof x === 'string') : [],
    investigations_planned: str(p.investigations_planned), treatment_planned: str(p.treatment_planned), referrals: str(p.referrals),
  }));
  return n;
}

/** Non-empty-ish check so we never replace a good note with a hollow one. */
function looksPopulated(n) {
  const anySub = Object.values(n.subjective || {}).some((v) => String(v).trim());
  return anySub || (n.assessment_and_plan || []).length > 0;
}

export async function tightenNote(currentNote, { llm, transcript = '', log = () => {}, maxOutputTokens } = {}) {
  if (!llm || !transcript.trim() || !currentNote) return currentNote;
  try {
    const draft = noteToMarkdown(currentNote);
    const user = `TRANSCRIPT (sole source of truth):\n"""\n${transcript}\n"""\n\nDRAFT NOTE (fix omissions, remove unsupported/filler content, keep only transcript-grounded facts):\n${draft}\n\nReturn ONLY the corrected JSON.`;
    const raw = await llm.generateContent(SYS, user, null, { maxOutputTokens: maxOutputTokens || Number(process.env.TIGHTENER_MAX_OUTPUT_TOKENS) || 16384, thinkingBudget: 0 });
    const parsed = safeParse(raw);
    if (!parsed || typeof parsed !== 'object') { log('[upgrade:tightener] no valid JSON returned — keeping draft'); return currentNote; }
    const out = buildNote(currentNote, parsed);
    if (!looksPopulated(out)) { log('[upgrade:tightener] result was empty — keeping draft'); return currentNote; }
    out.specialty = currentNote.specialty; out.metadata = currentNote.metadata;
    log('[upgrade:tightener] rewrote note gold-style (grounded, complete, concise)');
    return out;
  } catch (e) { log('[upgrade:tightener] skipped: ' + e.message); return currentNote; }
}

export { buildNote as _buildNote, safeParse as _safeParse };
