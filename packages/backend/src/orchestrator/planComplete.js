// Plan completeness (Style Spec v2.1.1, owner unlocked 2026-10-23 after a reviewed Super run: two problems stood in the plan as bare headings
// - "Weight loss" and "Benign prostatic hyperplasia" - and the advice "have your weight checked at every visit" and the "let me know in two weeks"
// were missing).
// Why it happened: the guards before this stage (diagnosis-only-if-said, restated-history cleaning) correctly remove a "Diagnosis:" line that only
// repeats the heading, and the writer sometimes put nothing else under that heading. Nothing then looked at the heading again.
// What this stage does, after the quality guards and the plan sweep and before the grounding agent:
//   1. asks once what the clinician decided for each problem that the lines leave out (treatment, advice, follow-up, tests, referrals; an
//      assessment only for a problem with no lines at all);
//   2. accepts an item only when its quote is really in the transcript, it is not history, and it is not already in the plan;
//   3. appends it to the problem (advice and follow-up become parts of the treatment line, which the Advice / Follow-up splitter then shows on their own lines);
//   4. a problem that is still a bare heading is taken out of the plan (the Subjective already tells the story); if the model could not be asked,
//      it stays and is flagged for the clinician instead.
// It never creates a diagnosis, never rewords an existing line, never touches another section. Off switch: PLAN_COMPLETE=0.
'use strict';

import { quoted, overlap } from './planSweep.js';
import { classify } from './adviceLines.js';

export const MAX_PER_PROBLEM = 3;
export const MAX_ITEMS = 10;
const FIELDS = { treatment: 'treatment_planned', advice: 'treatment_planned', follow_up: 'treatment_planned', investigations: 'investigations_planned', referrals: 'referrals', assessment: 'assessment' };
const CONTENT = ['diagnosis', 'assessment', 'investigations_planned', 'treatment_planned', 'referrals'];

export const COMPLETE_SYS = `You check an Assessment & Plan against the transcript for decisions the clinician gave that the plan leaves out.
You receive the TRANSCRIPT and the numbered PROBLEMS with the lines each has now (a problem may have no lines at all).
For each problem find what the CLINICIAN said or decided about it IN THIS VISIT that is missing from its lines:
 - "treatment": a medicine started, changed, refilled or told to continue (with the dose and duration if said), or a non-drug treatment;
 - "advice": counselling or safety-net advice the clinician gave (for example: have the weight checked at every visit);
 - "follow_up": a return visit, a recheck, or "let me know how it goes", with the timeframe if said;
 - "investigations": tests ordered or to be arranged;
 - "referrals": a referral made;
 - "assessment": ONLY for a problem that has no lines at all: the clinician's own conclusion in a short phrase, if one was stated.
Rules:
 - Every item carries "evidence": 6-25 words copied exactly from the transcript that show it. No quote, no item.
 - History is not a decision: what the patient took before, an earlier visit, what another doctor did, a medicine the patient is already on and nobody said to change. Say "Continue X" only if the clinician said to continue it.
 - A medicine the clinician told the patient to stop or not to take is advice ("Do not take X"), never treatment.
 - Something only mentioned or offered, with no sign the clinician chose it, is not treatment.
 - Do not repeat anything already in the lines. Do not name a diagnosis. Short plain clinical phrases, each fact once. At most ${MAX_PER_PROBLEM} items per problem; return nothing for a problem that is complete.
Return ONLY JSON: {"items":[{"n":1,"field":"treatment|advice|follow_up|investigations|referrals|assessment","text":"","evidence":""}]}. If nothing is missing: {"items":[]}.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const planText = (p) => [p.issue, p.diagnosis, p.assessment, p.investigations_planned, p.treatment_planned, p.referrals].filter(Boolean).join(' ');
const HISTORY = /\b(last (visit|time|week|month|year)|previous(ly)?|ago|earlier|already (had|done|given|tried)|used to|was (on|taking)|has been (on|taking)|tried (it|them|that))\b/i;
const STOPPED = /\b(stopp?ed|not taking|no longer|discontinued|ran out)\b/i;

/** A problem with nothing under its heading: no diagnosis, assessment, tests, treatment, referral or differential. */
export const isBare = (p) => !CONTENT.some((f) => String(p?.[f] || '').trim()) && !(Array.isArray(p?.differential_diagnoses) && p.differential_diagnoses.some((d) => String(d || '').trim()));

export function listing(problems) {
  return problems.map((p, i) => {
    const lines = [p.diagnosis && `Diagnosis: ${p.diagnosis}`, p.assessment && `Assessment: ${p.assessment}`, p.investigations_planned && `Investigations: ${p.investigations_planned}`, p.treatment_planned && `Treatment: ${p.treatment_planned}`, p.referrals && `Referrals: ${p.referrals}`].filter(Boolean);
    return `${i + 1}. ${p.issue || ''}\n${lines.length ? lines.join('\n') : '(no lines)'}`;
  }).join('\n\n');
}

export function parseItems(raw) {
  try { const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return Array.isArray(j?.items) ? j.items : []; } catch { return []; }
}

/** Which proposed items survive. Pure. Returns { keep: [{ index, field, part }], dropped: [{ n, why }] }. */
export function acceptItems(items, problems, transcript) {
  const tx = norm(transcript); const keep = []; const dropped = []; const per = {};
  for (const it of items || []) {
    const n = Number(it?.n); const p = problems[n - 1]; const field = String(it?.field || '');
    if (!p) { dropped.push({ n, why: 'no such problem' }); continue; }
    if (!FIELDS[field]) { dropped.push({ n, why: 'unknown field' }); continue; }
    const text = String(it?.text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
    if (text.length < 3 || text.length > 220) { dropped.push({ n, why: 'empty or too long' }); continue; }
    if (keep.length >= MAX_ITEMS || (per[n] || 0) >= MAX_PER_PROBLEM) { dropped.push({ n, why: 'over the limit' }); continue; }
    if (!quoted(it.evidence, tx)) { dropped.push({ n, why: 'quote not found in the transcript' }); continue; }
    if (HISTORY.test(String(it.evidence || '') + ' ' + text) && field !== 'follow_up') { dropped.push({ n, why: 'history, not a decision' }); continue; }
    if (field === 'treatment' && STOPPED.test(text)) { dropped.push({ n, why: 'a stopped medicine is not a treatment' }); continue; }
    if (field === 'assessment' && !isBare(p)) { dropped.push({ n, why: 'assessment only for a bare problem' }); continue; }
    const have = [planText(p), ...keep.filter((k) => k.index === n - 1).map((k) => k.part)].join(' ');
    if (overlap(text, have) >= 0.6) { dropped.push({ n, why: 'already in the plan' }); continue; }
    let part = text.replace(/^./, (c) => c.toUpperCase());
    if (field === 'advice' && classify(part) === 'treat') part = 'Advised ' + text.replace(/^./, (c) => c.toLowerCase());
    if (field === 'follow_up' && classify(part) !== 'follow') part = 'Follow-up ' + text.replace(/^./, (c) => c.toLowerCase());
    keep.push({ index: n - 1, field: FIELDS[field], part }); per[n] = (per[n] || 0) + 1;
  }
  return { keep, dropped };
}

export async function askComplete(llm, note, transcript, { timeoutMs = 40000 } = {}) {
  const t0 = Date.now();
  try {
    const raw = await llm.generateContent(COMPLETE_SYS, `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nPROBLEMS:\n${listing(note.assessment_and_plan || [])}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 3000, temperature: 0, timeoutMs, retries: 2, hedgeMs: 0, thinkingBudget: 512, responseMimeType: 'application/json' });
    return { raw, ms: Date.now() - t0 };
  } catch (e) { return { raw: null, error: String(e.message || e), ms: Date.now() - t0 }; }
}

/** Merge the accepted items, then deal with the problems that are still bare headings. Mutates the note. */
export function applyComplete(note, answer, transcript, log = () => {}) {
  const problems = note.assessment_and_plan || [];
  const bareBefore = problems.filter(isBare).map((p) => p.issue);
  const asked = !!answer && answer.raw != null;
  let kept = [], dropped = [];
  if (asked) {
    const r = acceptItems(parseItems(answer.raw), problems, transcript); kept = r.keep; dropped = r.dropped;
    for (const k of kept) { const p = problems[k.index]; p[k.field] = p[k.field] ? `${String(p[k.field]).replace(/[.;\s]+$/, '')}; ${k.part}` : k.part; }
  } else if (answer?.error) log('[v2:complete] skipped — ' + answer.error);
  const removed = [], flagged = [];
  if (bareBefore.length) {
    const bare = problems.filter(isBare);
    if (asked) {
      if (bare.length && bare.length < problems.length) { note.assessment_and_plan = problems.filter((p) => !isBare(p)); removed.push(...bare.map((p) => p.issue)); }
      else if (bare.length) flagged.push(...bare.map((p) => p.issue));   // every problem is bare: keep them, the clinician decides
    } else flagged.push(...bare.map((p) => p.issue));
    if (flagged.length) { note.metadata ||= {}; note.metadata.flags ||= []; for (const t of flagged) note.metadata.flags.push({ type: 'empty_plan', field: 'assessment_and_plan', severity: 'warning', message: `"${t}" - Nothing is written under this problem. Add what was decided, or delete the heading.` }); }
  }
  if (kept.length || removed.length || flagged.length) log(`[v2:complete] ${kept.length} plan item(s) added${kept.length ? ': ' + kept.map((k) => k.part).join(' | ') : ''}${removed.length ? ` · ${removed.length} empty heading(s) removed: ${removed.join(' | ')}` : ''}${flagged.length ? ` · ${flagged.length} empty heading(s) flagged: ${flagged.join(' | ')}` : ''}${dropped.length ? ` · ${dropped.length} dropped (${dropped.map((d) => d.why).join(', ')})` : ''}`);
  else if (asked) log('[v2:complete] plan already complete');
  return { added: kept.map((k) => ({ problem: problems[k.index]?.issue, field: k.field, part: k.part })), removed, flagged, dropped, bareBefore, ms: answer?.ms || 0 };
}

export async function completePlan(llm, note, transcript, log = () => {}, opts = {}) {
  return applyComplete(note, await askComplete(llm, note, transcript, opts), transcript, log);
}
