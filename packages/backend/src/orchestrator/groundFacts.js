// Grounding that reuses the fact graph (audit 2026-10-27, experiment GROUND_FACTS=1; off by default).
//
// The fact graph already holds every fact of the visit with its exact quote, checked against the transcript by code. A note line that states one of those facts needs
// no second reading of the whole transcript, and must never be removed by the grounding check as "unsupported" (the ablation of the grounding stage showed it costs
// about 0.4 critical misses per note: lines it removes count as omissions). So:
//   - lines that a graph fact supports are not sent to the grounding model and cannot be removed;
//   - every other line is checked exactly as before (same prompt, same second look, same removal cap).
// "Supports" is deliberately strict, because a name and a number in a line do not prove the line's ACTION or STATUS:
//   - a plan line that states an action ("Continue duloxetine 60 mg", "Start ...", "Stop ...") needs a fact whose own words carry that action;
//   - a negated line ("No murmur", "Denies wheezing") needs a negated fact;
//   - the numbers in the line must be the fact's numbers (matchFact already requires this).
// The graph is waited for at most GROUND_FACTS_WAIT_MS (8 s); without it every line is checked, as before.
'use strict';

import { unitsOf, matchFact, requiredFacts } from './factLedger.js';
import { collectParts } from './groundingAgent.js';
import { askGroundDelta } from './groundDelta.js';

const ACTION = /\b(continu\w*|refill\w*|renew\w*|resum\w*|start\w*|began|begin|prescrib\w*|stop\w*|discontinu\w*|increas\w*|decreas\w*|switch\w*|chang\w*|titrat\w*|taper\w*)\b/i;
const NEG = /\b(no|not|never|without|denies|denied|negative for|absent|declined|refused|none|nil|didn'?t|doesn'?t|don'?t|stopped|no longer)\b/i;

/** A one-line note that puts the part where the fact matcher expects it (same section rules as the real note). */
export function noteFor(p) {
  const base = { metadata: {}, subjective: {}, past_medical_history: {}, objective: {}, assessment_and_plan: [] };
  if (p.where === 'subjective') base.subjective = { hpi_details: p.text };
  else if (p.where === 'past_medical_history') base.past_medical_history = { medical_surgical: p.text };
  else if (p.where === 'objective') base.objective = { examination: p.text };
  else base.assessment_and_plan = [{ issue: 'x', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: p.text, referrals: '' }];
  return base;
}

/** The texts of the parts that a graph fact supports. */
export function supportedTexts(parts, facts) {
  const out = new Set();
  for (const p of parts) {
    let units; try { units = unitsOf(noteFor(p)).filter((u) => !u.isBlock); } catch { continue; }
    const lineNeg = NEG.test(p.text); const act = p.where.startsWith('plan') ? (p.text.match(ACTION) || [])[0] : null;
    for (const f of facts) {
      if (!matchFact(f, units)) continue;
      if (act && !ACTION.test(`${f.text} ${f.quote || ''}`)) continue;     // the action of the line must be the fact's own
      if (lineNeg && !f.negative && !NEG.test(`${f.text} ${f.quote || ''}`)) continue;   // a negated line needs a negated fact
      out.add(p.text); break;
    }
  }
  return out;
}

/**
 * The grounding check on a copy of the note, skipping the lines the fact graph supports. Returns what groundNote() returns (checked, removed, flagged, ...), plus how many
 * lines the graph covered, and puts the flags on `snap` like groundNote() does, so the caller's join code is unchanged.
 */
export async function groundNoteFactAware(llm, snap, transcript, factsP, log = () => {}, { timeoutMs = 45000 } = {}) {
  const t0 = Date.now(); const parts = collectParts(snap);
  if (parts.length < 3) return { checked: 0, removed: [], flagged: [], doubtful: [], rescued: [], ms: 0 };
  const graph = await Promise.race([Promise.resolve(factsP).catch(() => null), new Promise((r) => setTimeout(() => r(null), Number(process.env.GROUND_FACTS_WAIT_MS || 8000)))]);
  let toCheck = parts;
  if (graph?.facts?.length) { const sup = supportedTexts(parts, requiredFacts(graph.facts)); toCheck = parts.filter((p) => !sup.has(p.text)); }
  const covered = parts.length - toCheck.length;
  const d = await askGroundDelta(llm, transcript, toCheck, { timeoutMs });
  const removed = (d.remove || []).map((text) => { const p = parts.find((x) => x.text === text); return { text, key: p?.key, where: p?.where }; });
  const flags = [
    ...removed.slice(0, 8).map((r) => ({ type: 'removed_unsupported', field: 'note', message: `"${String(r.text).slice(0, 120)}"`, severity: 'info' })),
    ...(d.flag || []).slice(0, 8).map((r) => ({ type: 'check_against_recording', field: 'note', message: `"${String(r.text).slice(0, 120)}" - ${String(r.why).slice(0, 90)}${d.capped ? ' (many lines looked doubtful, none were removed)' : ''}`, severity: 'warning' })),
  ];
  snap.metadata = snap.metadata || {}; snap.metadata.flags = [...(snap.metadata.flags || []), ...flags];
  log(`[v2:ground] ${parts.length} lines: ${covered} supported by the fact graph, ${toCheck.length} checked · removed ${removed.length} · flagged ${(d.flag || []).length}${d.error ? ' · ' + d.error : ''}`);
  return { checked: toCheck.length, total: parts.length, covered, removed, flagged: d.flag || [], doubtful: [], rescued: [], capped: d.capped, ms: Date.now() - t0, error: d.error };
}
