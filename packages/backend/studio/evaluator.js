// Doctor-centred evaluator. A note is judged ON ITS OWN against the transcript — never against another author's note.
//   * rubric: PDQI-9 adapted for AI scribe notes (Palm et al. 2025; "up to date" dropped because it does not apply to a one-visit note)
//   * errors: CREOLA taxonomy (Asgari et al., npj Digital Medicine 2025): hallucination (fabrication, negation, causality, contextual),
//     omission (current issues, past medical/medication/family/social history, plan), each major or minor
//   * style: deterministic Style Spec v1 conformance (conformance.js)
// The LLM judge is a first pass for the doctor; its agreement with the doctor's own ratings is tracked on the dashboard.
'use strict';

import { askJson, MODELS } from './llm.js';
import { conformance } from './conformance.js';

export const RUBRIC = [
  { id: 'accurate', label: 'Accurate', help: 'Every statement is true to the visit; nothing invented, no flipped negations.' },
  { id: 'thorough', label: 'Thorough', help: 'Everything clinically important that was said is in the note.' },
  { id: 'useful', label: 'Useful', help: 'You could act on it or hand over care from it.' },
  { id: 'organized', label: 'Organised', help: 'Right facts in the right section and problem, logical order.' },
  { id: 'comprehensible', label: 'Comprehensible', help: 'Clear, grammatical, easy to read at a glance.' },
  { id: 'succinct', label: 'Succinct', help: 'No padding, no repetition, no filler.' },
  { id: 'synthesized', label: 'Synthesised', help: 'Reads as a coherent clinical story, not a list of fragments.' },
  { id: 'consistent', label: 'Internally consistent', help: 'No contradictions between sections.' },
];
export const ERROR_TYPES = {
  hallucination: ['fabrication', 'negation', 'causality', 'contextual'],
  omission: ['current_issue', 'history', 'plan'],
};

export const EVAL_SYS = `You are a senior physician reviewing an AI-written clinical note for ONE consultation. The TRANSCRIPT is the only ground truth. Judge the note on its own merits as a doctor who must sign it.
Score each criterion 1-5 (5 = I would sign it as is): ${RUBRIC.map((r) => `${r.id} (${r.help})`).join('; ')}.
List every ERROR you can find, using this taxonomy:
- hallucination: fabrication (stated but never said), negation (a denial turned into a finding or the reverse), causality (a cause or reason the clinician never gave), contextual (a fact from another topic mixed in)
- omission: current_issue (an important symptom/problem/result missing), history (past medical/medication/family/social history missing), plan (a plan item, drug decision, referral or follow-up missing)
Each error: severity "major" (could change diagnosis or management if uncorrected) or "minor". Quote the exact note text for a hallucination, or the missing fact for an omission. Report only real errors; do not invent any.
Return JSON: {"scores":{"accurate":n,...},"overall":n,"would_sign":true|false,"errors":[{"kind":"hallucination|omission","subtype":"...","severity":"major|minor","section":"Subjective|Past Medical History|Objective|Assessment & Plan","text":"...","why":"..."}],"summary":"one sentence"}.
At most 12 errors. Be strict and specific.`;

export function normalizeEval(o) {
  const scores = {}; for (const r of RUBRIC) { const v = Number(o?.scores?.[r.id]); scores[r.id] = Number.isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : null; }
  const vals = Object.values(scores).filter((v) => v != null);
  const errors = (Array.isArray(o?.errors) ? o.errors : []).slice(0, 12).map((e) => ({
    kind: e?.kind === 'omission' ? 'omission' : 'hallucination', subtype: String(e?.subtype || '').slice(0, 30), severity: e?.severity === 'major' ? 'major' : 'minor',
    section: String(e?.section || '').slice(0, 40), text: String(e?.text || '').slice(0, 300), why: String(e?.why || '').slice(0, 300),
  }));
  return { scores, overall: Number.isFinite(Number(o?.overall)) ? Math.min(5, Math.max(1, Math.round(Number(o.overall)))) : (vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null),
    would_sign: typeof o?.would_sign === 'boolean' ? o.would_sign : null, errors, summary: String(o?.summary || '').slice(0, 300),
    major_errors: errors.filter((e) => e.severity === 'major').length };
}

export async function evaluateNote({ transcript, rendered, llm }) {
  const raw = await askJson({ llm, model: MODELS.judge(), agent: 'studio-evaluator', system: EVAL_SYS, thinkingBudget: 1024,
    user: `=== TRANSCRIPT ===\n${String(transcript).slice(0, 60000)}\n\n=== NOTE ===\n${String(rendered).slice(0, 12000)}\n\nReturn ONLY the JSON.` });
  return { ...normalizeEval(raw), model: MODELS.judge(), at: new Date().toISOString() };
}
export { conformance };
