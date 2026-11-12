// Unclear plan lines (2026-11-05, from the owner's side-by-side review: "For the or once a day and you're taking at bedtime...", "Can you suck on the ice cubes?").
// A plan line that is a question, speaks to the patient ("you"), breaks off in the middle, or has a doubled/stranded function word is most often a mis-heard or half-heard instruction.
// FLAGS ONLY: the line is never changed or removed, it is shown under "Before you sign" so the clinician checks the recording. Nothing is guessed and nothing is invented.
// Pure code, no model call. UNCLEAR_PLAN=0 switches it off.
'use strict';

const FUNC = '(?:the|a|an|of|to|for|with|at|on|in|and|or|but|if|is|are)';
const RULES = [
  ['a question', /\?\s*$|^(?:can|could|should|do|does|did|will|would|is|are|have|has)\s+(?:you|we|i|she|he|they|it)\b/i],
  ['spoken to the patient', /\b(?:you|you're|you've|you'll)\b|\b(?:i'll|i will|i would|i think|i'd|let me|let's|we're|we are|we'll|we will)\b|\bthat is (?:perfect|great|good|fine)\b|^(?:beautiful|perfect|great|wonderful|excellent)\b/i],
  ['two small words in a row', new RegExp('\\b(?:the|a|an|of|to|for)\\s+(?:or|and|but)\\b|\\b(?:or|and)\\s+(?:or|and)\\b', 'i')],
  ['the same word twice in a row', /\b([a-z]{3,})\s+\1\b/i],
  ['breaks off at the end', new RegExp('\\b' + FUNC + '\\s*[.…-]*\\s*$', 'i')],
  ['starts in the middle', /^(?:and|or|but|so|then|because|which|of|for the|to the)\s/i],
  // a bare medicine phrase ("Sleeping pills", "Cortisone cream") says nothing about start, stop or continue: the doctor must check the recording (owner, 2026-11-12)
  ['a medicine with no action word (start, stop or continue?)', /^(?!(?:start|stop|continue|take|use|apply|prescri\w*|arrange|order\w*|refill|renew\w*|avoid|increase|decrease|switch\w*|change\w*|add|give\w*|provide\w*|trial|try|discuss\w*|declin\w*|no|current)\b)(?:[A-Za-z'-]+\s+){0,2}(?:pills?|tablets?|capsules?|creams?|ointments?|drops|sprays?|inhalers?|patch(?:es)?|injections?|gels?|lotions?|supplements?|vitamins?|medicines?|antibiotics?|syrup|suppositor(?:y|ies))\s*\.?$/i],
];

/** The plan lines of the finished markdown: [{ problem, line }]. */
export function planLines(md) {
  const out = []; let inAP = false, problem = '';
  for (const ln of String(md || '').split('\n')) {
    const h = ln.match(/^###\s+(.*)$/); if (h) { inAP = /assessment/i.test(h[1]); continue; }
    if (!inAP) continue;
    const p = ln.match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/); if (p) { problem = p[1].trim(); continue; }
    const b = ln.match(/^\s*[-*]\s+(.*\S)\s*$/); if (b && problem) out.push({ problem, line: b[1] });
  }
  return out;
}

export function whyUnclear(line) {
  const l = String(line || '').trim().replace(/^(?:Diagnosis|Differential diagnoses|Investigations planned|Treatment planned|Referrals|Advice|Follow-up|Started|Changed|Stopped|Continued|Given today|Other):\s*/i, ''); if (l.length < 4) return '';
  for (const [why, re] of RULES) if (re.test(l)) return why;
  return '';
}

/** @returns {{flags: object[], checked: number}} */
export function unclearPlan(md, { max = 5 } = {}) {
  const lines = planLines(md); const flags = [];
  for (const { problem, line } of lines) {
    if (/^follow-?up$/i.test(problem)) continue;
    const why = whyUnclear(line); if (!why) continue;
    flags.push({ type: 'plan_unclear', field: 'assessment_and_plan', severity: 'warning', message: `Plan line under "${problem}" may be mis-heard or unfinished (${why}): "${line.slice(0, 120)}". Check the recording before you sign.` });
    if (flags.length >= max) break;
  }
  return { flags, checked: lines.length };
}
