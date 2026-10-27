// Action pass (audit 2026-10-27, owner: "encounter coverage and action-oriented details are not up to the mark"). A check of 8 recent real notes against their recordings found that the
// ACTIONS of the visit and their details were the weakest part: patient decisions (agreed, declined, deferred) 11 of 17 absent; prescriptions (how they were sent, quantity, pharmacy)
// 3 absent and 4 partial; medicine changes 6 absent and 8 partial; orders (a printed requisition, where and when) partial or absent.
// This is ONE extra question, asked at the same moment as the coverage check on the same note copy, that is only about what the clinician DID or DECIDED and the details a colleague
// needs to carry it out: for every problem, medicines (started / stopped / changed / continued / declined, dose, quantity, refills, pharmacy, and how the prescription was sent), tests
// and requisitions (what, when, where), referrals, vaccines (given, deferred, declined), the follow-up and what the patient agreed to or declined.
// Its items go through the plan-completeness code that already exists and is part of the spec (exact quote in the transcript, not history, not already in the plan, at most 3 per problem),
// so the note format is unchanged. It only ADDS lines to a problem that already exists. Off unless ACTION_PASS=1.
'use strict';

import { listing, parseItems } from './planComplete.js';
import { issuesOf } from './gapEarly.js';
import { overlap } from './planSweep.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

export const ACTION_SYS = `You check the PLAN of a finished clinic note against the consultation transcript for ACTIONS and DECISIONS of the clinician that the plan leaves out or states without the details a colleague needs.
You receive the TRANSCRIPT, the numbered PROBLEMS with the lines each has now, and the MEDICATIONS a checklist found (name - status).
For each problem list what the clinician did or decided IN THIS VISIT that is missing, with the details:
 - "treatment": a medicine started, stopped, changed, refilled, continued or declined, with dose, frequency, quantity, refills, pharmacy, and HOW the prescription was sent (faxed, printed, sent to a named pharmacy); a vaccine given, deferred or declined (and why); another treatment or procedure done; what the patient agreed to, declined or wants to think about;
 - "investigations": a test, scan or requisition ordered or printed: what, when, where, and any condition ("only if the brace does not help");
 - "referrals": a referral, who to, how it will be arranged;
 - "advice": instructions, warnings, "return if" advice, what to avoid, what to monitor;
 - "follow_up": when the patient returns or is contacted, and what happens first (results, a call, a recheck).
A line the plan already has is NOT missing unless it leaves out a detail that was said (then give only the missing detail as its own short statement that names the medicine or test, for example "Prescription for X faxed to Y pharmacy").
Rules:
 - Every item carries "evidence": 6-25 words copied exactly from the transcript. No quote, no item.
 - Only what the clinician decided or the patient agreed or declined in this visit. Not history, not what another doctor did, not a medicine nobody changed.
 - Something only discussed or offered is written as such ("Offered X; patient to think about it"), never as done.
 - Use the speaker's own numbers, names and doses. Short plain clinical phrases, one fact per item, no diagnosis. At most 3 items per problem. Nothing for a complete problem.
Return ONLY JSON: {"items":[{"n":1,"field":"treatment|investigations|referrals|advice|follow_up","text":"","evidence":""}]}. If nothing is missing: {"items":[]}.`;

export async function askActions(llm, note, transcript, { timeoutMs = 45000, meds = [] } = {}) {
  const t0 = Date.now();
  try {
    const medList = (meds || []).filter((m) => m && m.name).map((m) => `- ${m.name}${m.detail ? ' ' + m.detail : ''} - ${m.status || 'current'}`).join('\n') || '(none)';
    const raw = await llm.generateContent(ACTION_SYS, `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nPROBLEMS:\n${listing(note.assessment_and_plan || [])}\n\nMEDICATIONS FOUND:\n${medList}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 3500, temperature: 0, timeoutMs, retries: 2, hedgeMs: 0, thinkingBudget: 512, responseMimeType: 'application/json' });
    return { raw, ms: Date.now() - t0 };
  } catch (e) { return { raw: null, error: String(e.message || e), ms: Date.now() - t0 }; }
}

/** The problem numbers of an answer asked on an earlier copy are moved to the same problems of the current note (by title); an item whose problem is gone is dropped. */
export function remapActions(raw, askedIssues, note) {
  if (raw == null) return raw;
  const now = issuesOf(note);
  const items = [];
  for (const it of parseItems(raw)) {
    const n = Number(it?.n); if (!(n >= 1)) continue;
    const old = askedIssues[n - 1] || ''; let at = now.findIndex((t) => norm(t) === norm(old));
    if (at < 0) at = now.findIndex((t) => overlap(t, old) >= 0.85);
    if (at >= 0) items.push({ ...it, n: at + 1 });
  }
  return JSON.stringify({ items });
}
