// Plan action check (research basis: Asgari et al., npj Digit Med 2025 — hallucinations concentrate in the plan; on our own judged wrong claims, half of the major
// and critical ones are plan lines, and the commonest kind is a WRONG ACTION STATUS or detail: a drug that was only discussed written as started, an injection
// "to research" written as given, a prescription "faxed" that the patient asked to have printed, a referral to a different doctor).
//
// Flags only; it never edits or removes a line. For every plan item that states a decision (Started / Changed / Stopped / Continued / Given today / an investigation,
// a referral, a follow-up), it is given the few passages of the recording that mention the same things (targeted evidence, not the whole transcript) and asked whether
// the recording shows that DECISION, only an OPTION, nothing, or a different detail. A flag needs an exact quote from the recording (checked by code).
// Off unless PLAN_CHECK=1. Findings appear under "Before you sign".
'use strict';

import { passages } from './negationGuard.js';

const STOP = new Set('the and for with that this have has had was were are you your his her she him they them their from about into over then than also just very really okay yeah well like some any all can could would should will not but one two patient says said told states reported mentions noted discussed plan advised note started stopped continued changed given today other follow referral referrals investigations planned treatment'.split(' '));
const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 6);
const keys = (s) => [...new Set(String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem))];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const PLAN_CHECK_SYS = `You check the ACTION STATUS of plan items in a clinic note against short passages of the consultation recording. The recording is the only truth.
For each numbered ITEM you get the passages that mention the same things. Decide:
- "done": the clinician decided, ordered, prescribed, started, stopped, continued, gave, booked or arranged exactly this;
- "option": it was only discussed, offered, asked about, considered, researched, conditional ("if the insurance approves", "we could", "you might want to think about it") or left for later;
- "wrong_detail": the action happened, but the item states a different drug, dose, doctor, place, route, form (printed or faxed) or timing than the recording;
- "not_said": none of the passages shows this action.
Be strict about the difference between talking about something and deciding it. When the passages do not settle it, answer "done": never guess a problem.
For "option" and "wrong_detail" give "quote": the exact words from a passage that show it, and "why": one short sentence.
Return ONLY JSON: {"items":[{"i":1,"verdict":"done|option|wrong_detail|not_said","quote":"","why":""}]}`;

const LABELS = /^(Started|Changed|Stopped|Continued|Given today|Other|Treatment planned|Investigations planned|Referrals|Follow-up):\s*(.+)$/i;

/** The plan items of a rendered note that state a decision: { label, text }. */
export function planItems(md) {
  const out = []; let inPlan = false;
  for (const raw of String(md || '').split('\n')) {
    if (/^###\s+/.test(raw)) { inPlan = /^###\s+Assessment/i.test(raw); continue; }
    if (!inPlan) continue;
    const m = raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').replace(/\*\*/g, '').trim().match(LABELS);
    if (!m) continue;
    for (const part of m[2].split(/;\s+/)) if (part.trim().length >= 6) out.push({ label: m[1], text: part.trim() });
  }
  return out;
}

/** Up to two passages (with their neighbours) per item that hold at least half of the item's key words. */
export function evidenceFor(item, ps, { max = 2, chars = 650 } = {}) {
  const k = keys(item.text); if (!k.length) return [];
  const scored = [];
  for (let i = 0; i < ps.length; i++) {
    const win = [ps[i - 1], ps[i], ps[i + 1]].filter(Boolean); const have = new Set(win.flatMap((p) => [...p.w]));
    const hit = k.filter((w) => have.has(w)).length / k.length; if (hit >= 0.5) scored.push({ hit, text: win.map((p) => p.t).join(' ').slice(0, chars) });
  }
  scored.sort((a, b) => b.hit - a.hit); const out = [];
  for (const s of scored) { if (out.length >= max) break; if (!out.some((o) => norm(o).includes(norm(s.text).slice(0, 60)) || norm(s.text).includes(norm(o).slice(0, 60)))) out.push(s.text); }
  return out;
}

/**
 * @returns {Promise<{flags: object[], checked: number, ms: number, error?: string}>}
 */
export async function planActionCheck(llm, md, transcript, log = () => {}, { timeoutMs = 30000, maxItems = 24 } = {}) {
  const t0 = Date.now();
  try {
    const items = planItems(md).slice(0, maxItems); if (!items.length) return { flags: [], checked: 0, ms: 0 };
    const ps = passages(transcript); const tx = norm(transcript);
    const body = items.map((it, i) => `ITEM ${i + 1} [${it.label}]: ${it.text}\nPASSAGES:\n${evidenceFor(it, ps).map((p) => `  - ${p}`).join('\n') || '  (no passage found)'}`).join('\n\n');
    const raw = await llm.generateContent(PLAN_CHECK_SYS, `${body}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 2500, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 512, responseMimeType: 'application/json' });
    const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); const flags = [];
    for (const r of j.items || []) {
      const it = items[Number(r.i) - 1]; if (!it || r.verdict === 'done') continue;
      if ((r.verdict === 'option' || r.verdict === 'wrong_detail') && !(String(r.quote || '').length >= 12 && tx.includes(norm(r.quote)))) continue;   // a claim needs the exact words
      const msg = r.verdict === 'option' ? 'the recording shows this was only discussed or conditional' : r.verdict === 'wrong_detail' ? 'a detail differs from the recording' : 'the recording does not show this being decided';
      flags.push({ type: 'check_against_recording', field: 'note', severity: 'warning', message: `"${it.text.slice(0, 110)}" - ${msg}${r.why ? ': ' + String(r.why).slice(0, 120) : ''}`, kind: r.verdict });
    }
    if (flags.length) log(`[v2:plan-check] ${flags.length} plan item(s) whose action status or detail the recording does not support (flagged, nothing changed)`);
    return { flags, checked: items.length, ms: Date.now() - t0 };
  } catch (e) { return { flags: [], checked: 0, ms: Date.now() - t0, error: String(e.message || e) }; }
}
