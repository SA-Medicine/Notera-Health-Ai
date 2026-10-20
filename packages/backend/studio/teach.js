// "Teach Notera": the interview we ran by hand, as a product feature. For ONE note the system asks the doctor targeted questions
// (what it saw, with the exact line quoted), and turns her answers into PROPOSALS for a future Style Spec. Proposals are only stored:
// the approved spec is locked and nothing here ever changes the notes the app produces.
'use strict';

import { askJson, MODELS } from './llm.js';
import { SPEC } from './conformance.js';

export const TEACH_SYS = `You are "Teach Notera". A physician is teaching an AI scribe how she wants her notes written. You see ONE note, its transcript, the CURRENT STYLE RULES (already approved) and the automatic checks that failed on this note.
Ask 4 to 6 short, concrete questions about THIS note, at least one per section (Subjective, Past Medical History, Objective, Assessment & Plan) and one overall. Each question quotes the exact line or pattern you saw ("evidence"), and offers 2 to 4 clearly different answer options (each says what the rule would then be). The doctor can also write her own answer.
Ask about real choices the note shows: wording length, what to include or leave out, where a fact belongs, how to group, how to word a plan. Do not ask about something the current rules already decide, unless this note breaks that rule. Never ask about patient-specific facts.
Return JSON {"questions":[{"id":"q1","section":"Subjective|Past Medical History|Objective|Assessment & Plan|Overall","question":"...","evidence":"short quote from the note","options":[{"id":"a","label":"short option","meaning":"the rule this would become"}]}]}.`;

export const PROPOSE_SYS = `You turn a physician's answers about ONE note into proposed changes to a note-writing style spec. Rules:
- One proposal per answer that expresses a preference. Skip answers that only say "keep as is".
- Each proposal is a GENERAL, reusable rule with no patient-specific detail (no names, drugs, numbers or dates from this note).
- Use the doctor's own free-text words when she gave them; keep her meaning exactly.
- kind: add_rule | change_rule | remove_rule | wording | example. section: Subjective | Past Medical History | Objective | Assessment & Plan | Overall. If it changes an existing rule, give its id in "replaces".
Return JSON {"proposals":[{"title":"short","section":"...","kind":"...","rule":"the new rule in one or two sentences","replaces":"S2 or empty","because":"the doctor's answer in a few words","answers":["q1"]}]}.`;

const rulesText = () => SPEC.rules.map((r) => `${r.id} [${r.section}] ${r.text}`).join('\n');

export async function makeQuestions({ transcript, rendered, conformance, llm }) {
  const out = await askJson({ llm, model: MODELS.judge(), agent: 'studio-teach', system: TEACH_SYS, maxOutputTokens: 5000, thinkingBudget: 1024,
    user: `=== CURRENT STYLE RULES ===\n${rulesText()}\n\n=== AUTOMATIC CHECKS THAT FAILED ===\n${(conformance?.failed || []).map((f) => `${f.rule}: ${f.detail}`).join('\n') || 'none'}\n\n=== NOTE ===\n${String(rendered).slice(0, 10000)}\n\n=== TRANSCRIPT (for context) ===\n${String(transcript).slice(0, 20000)}\n\nReturn ONLY the JSON.` });
  const qs = (Array.isArray(out.questions) ? out.questions : []).slice(0, 7).map((q, i) => ({
    id: String(q.id || `q${i + 1}`), section: String(q.section || 'Overall').slice(0, 40), question: String(q.question || '').slice(0, 400), evidence: String(q.evidence || '').slice(0, 300),
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 4).map((o, j) => ({ id: String(o.id || 'abcd'[j]), label: String(o.label || '').slice(0, 120), meaning: String(o.meaning || '').slice(0, 300) })).filter((o) => o.label),
  })).filter((q) => q.question);
  if (!qs.length) throw new Error('no questions were generated');
  return qs;
}

/** answers: { q1: { option: 'a', text: 'free text' }, … } */
export async function answersToProposals({ questions, answers, llm }) {
  const lines = questions.map((q) => {
    const a = answers?.[q.id] || {}; const opt = q.options.find((o) => o.id === a.option);
    if (!opt && !String(a.text || '').trim()) return null;
    return `${q.id} [${q.section}] Q: ${q.question}\n  note line: ${q.evidence}\n  chosen: ${opt ? `${opt.label} (${opt.meaning})` : '(none)'}\n  doctor's own words: ${String(a.text || '').trim() || '(none)'}`;
  }).filter(Boolean);
  if (!lines.length) return [];
  const out = await askJson({ llm, model: MODELS.fast(), agent: 'studio-propose', system: PROPOSE_SYS, maxOutputTokens: 4000, user: `=== CURRENT RULES ===\n${rulesText()}\n\n=== DOCTOR'S ANSWERS ===\n${lines.join('\n')}\n\nReturn ONLY the JSON.` });
  return (Array.isArray(out.proposals) ? out.proposals : []).slice(0, 10).map((p) => ({
    title: String(p.title || p.rule || '').slice(0, 140), section: String(p.section || 'Overall').slice(0, 40), kind: String(p.kind || 'add_rule').slice(0, 20),
    rule: String(p.rule || '').slice(0, 500), replaces: String(p.replaces || '').slice(0, 10), because: String(p.because || '').slice(0, 300), answers: Array.isArray(p.answers) ? p.answers.map(String).slice(0, 8) : [],
  })).filter((p) => p.title && p.rule);
}
