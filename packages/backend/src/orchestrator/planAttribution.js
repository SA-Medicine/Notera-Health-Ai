// Plan attribution: every investigation, treatment and referral must sit under the problem it is FOR.
// Found on the newer test notes (2026-10-22): the auditor reported plan items under the wrong problem in 22 of 29 notes (a kidney ultrasound under
// "Low B12", a referral under an unrelated problem). The editor and the re-attach guard fix some of it. This step asks a model once, beside the story
// agent (so it costs no waiting), which numbered plan items belong to a DIFFERENT problem; code then moves an item only when
//   * the model gives a quote and the quote is really in the transcript,
//   * the item is still exactly where the model saw it, and the destination problem exists,
//   * at most 6 items move per note.
// The text of an item is never changed, only the problem it sits under. ATTRIBUTION=0 / opts.planAttribution=false switches it off.
'use strict';

import { quoted } from './planSweep.js';

const FIELDS = [['investigations_planned', 'Investigation'], ['treatment_planned', 'Treatment'], ['referrals', 'Referral']];
export const MAX_MOVES = 6;

export const ATTR_SYS = `You check where the plan items of a clinic note sit. Each numbered PLAN ITEM is under a numbered PROBLEM. An item belongs under the problem it is FOR: the condition it tests, treats, refers for or advises about.
Typical mistakes: a kidney ultrasound under a vitamin problem; a referral under a problem it has nothing to do with; a treatment for one condition listed under another.
List ONLY the items that clearly belong under a DIFFERENT problem. Do not move an item that applies to the whole visit (such as a general follow-up); do not move when unsure; never move an item to a problem that does not exist. For every move quote the exact transcript words that show where the item belongs.
Return ONLY JSON: {"moves":[{"part":3,"to":2,"quote":"exact transcript words"}]}. If every item is where it belongs return {"moves":[]}.`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const split = (v) => String(v || '').split('\n').flatMap((l) => l.split('; ')).map((x) => x.trim()).filter(Boolean);

/** The numbered plan items of a note: [{n, pi (0-based problem index), field, kind, text}]. */
export function collectItems(note) {
  const items = []; let n = 0;
  (note?.assessment_and_plan || []).forEach((p, pi) => { for (const [field, kind] of FIELDS) for (const text of split(p?.[field])) items.push({ n: ++n, pi, field, kind, text }); });
  return items;
}

/** Step 1: the model call (read-only; it can run beside the story agent). Never throws into the pipeline. */
export async function askAttribution(llm, note, transcript, { timeoutMs = 30000 } = {}) {
  const t0 = Date.now(); const problems = note?.assessment_and_plan || []; const items = collectItems(note);
  if (problems.length < 2 || items.length < 2) return { skipped: true, items, ms: 0 };
  try {
    const plist = problems.map((p, i) => `${i + 1}. ${p.issue || ''}${p.assessment ? ' - ' + String(p.assessment).split('\n')[0].slice(0, 120) : ''}`).join('\n');
    const ilist = items.map((it) => `${it.n}. [${it.kind}, under problem ${it.pi + 1}] ${it.text}`).join('\n');
    const raw = await llm.generateContent(ATTR_SYS, `TRANSCRIPT:\n"""\n${String(transcript).slice(0, 60000)}\n"""\n\nPROBLEMS:\n${plist}\n\nPLAN ITEMS:\n${ilist}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 1500, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 512, responseMimeType: 'application/json' });
    return { raw, items, ms: Date.now() - t0 };
  } catch (e) { return { error: String(e.message || e), items, ms: Date.now() - t0 }; }
}

export function parseMoves(raw) { try { const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return Array.isArray(j?.moves) ? j.moves : []; } catch { return []; } }

/** Step 2: checks and moves against the FINAL note. Returns what moved and why the rest did not. */
export function applyAttribution(note, answer, transcript, log = () => {}) {
  const out = { moved: [], dropped: [], ms: answer?.ms || 0 };
  if (!answer || answer.skipped) return out;
  if (answer.error) { log('[v2:attr] skipped — ' + answer.error); out.error = answer.error; return out; }
  const problems = note?.assessment_and_plan || []; const txNorm = norm(transcript); const snap = new Map((answer.items || []).map((it) => [it.n, it]));
  for (const m of parseMoves(answer.raw)) {
    if (out.moved.length >= MAX_MOVES) { out.dropped.push({ part: m?.part, why: 'over the limit' }); continue; }
    const it = snap.get(Number(m?.part)); const to = Number(m?.to) - 1;
    if (!it) { out.dropped.push({ part: m?.part, why: 'unknown item' }); continue; }
    if (!Number.isInteger(to) || to < 0 || to >= problems.length) { out.dropped.push({ part: m.part, text: it.text, why: 'no such problem' }); continue; }
    if (!quoted(String(m.quote || ''), txNorm)) { out.dropped.push({ part: m.part, text: it.text, why: 'quote not in the transcript' }); continue; }
    // the item must still be exactly where the model saw it (earlier guards may have moved it)
    const src = problems.findIndex((p) => split(p?.[it.field]).includes(it.text)); if (src < 0) { out.dropped.push({ part: m.part, text: it.text, why: 'item changed meanwhile' }); continue; }
    if (src === to) { out.dropped.push({ part: m.part, text: it.text, why: 'already there' }); continue; }
    problems[src][it.field] = split(problems[src][it.field]).filter((x) => x !== it.text).join('\n');
    const dest = split(problems[to][it.field]); if (!dest.includes(it.text)) dest.push(it.text); problems[to][it.field] = dest.join('\n');
    out.moved.push({ text: it.text, kind: it.kind, from: problems[src].issue, to: problems[to].issue });
  }
  if (out.moved.length) log(`[v2:attr] moved ${out.moved.length} plan item(s): ${out.moved.map((x) => `"${x.text.slice(0, 40)}" ${x.from} -> ${x.to}`).join(' | ')}`);
  return out;
}
