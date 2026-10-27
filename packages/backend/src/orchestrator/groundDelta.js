// Grounding check of the lines the main grounding check never saw (audit 2026-10-27).
//
// The main check runs beside coverage, the fact ledger and the story merge, on a copy of the note taken before them. Lines those stages ADD arrive after it.
// On the gold set (232 late lines in 30 notes) this check removed four lines that were not in the recording: "Continue Cymbalta (duloxetine) 60 mg once daily"
// (a medicine the visit does not say is continued; the judge called the same line a critical wrong claim in the control run), "Continue Rupall daily", and two
// examination findings nobody performed ("Abdomen: palpation performed...", "MSK: ... no significant pain").
//
// It runs the SAME prompt, rules and second look as the main check (imported from groundingAgent.js, which is locked and untouched) on just those lines.
//   GROUND_DELTA=1  every unseen line, checked and applied right away          (7 s per note on the gold set: too slow to keep)
//   GROUND_DELTA=2  only the plan and Objective lines the gap stages added, asked in the background while the story merge runs, applied to the finished note
// Off unless GROUND_DELTA is set.
'use strict';

import { GROUND_SYS, collectParts, parseGround, decide, secondLook, applyRemovals, REMOVAL_CAP } from './groundingAgent.js';

/** Ask the question about these parts. Resolves to a decision that applyGroundDelta() can use on the finished note. Never throws. */
export async function askGroundDelta(llm, transcript, parts, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  try {
    if (!parts.length) return { checked: 0, remove: [], flag: [], ms: 0 };
    const listing = parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
    const raw = await llm.generateContent(GROUND_SYS, `TRANSCRIPT:\n"""\n${String(transcript).slice(0, 60000)}\n"""\n\nNOTE LINES:\n${listing}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 1500, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 1024, responseMimeType: 'application/json' });
    const verdicts = parseGround(raw);
    if (verdicts === null) return { checked: parts.length, remove: [], flag: [], ms: Date.now() - t0, error: 'unparseable' };
    const d = decide(parts, verdicts, transcript); let removeNow = []; let capped = false;
    if (d.remove.length) {
      const sl = await secondLook(llm, transcript, d.remove); removeNow = sl.confirmed;
      if (removeNow.length > Math.max(2, Math.ceil(parts.length * REMOVAL_CAP))) { capped = true; d.flag.push(...removeNow.map((r) => ({ ...r, verdict: 'unsupported' }))); removeNow = []; }
    }
    return { checked: parts.length, remove: removeNow.map((r) => r.text), flag: d.flag.map((r) => ({ text: r.text, why: String(r.why || '') })), capped, ms: Date.now() - t0 };
  } catch (e) { return { checked: parts.length, remove: [], flag: [], ms: Date.now() - t0, error: String(e.message || e) }; }
}

/** Apply a decision to the note as it is now: a line to remove is found again by its text; one that was reworded meanwhile is flagged for the clinician instead. */
export function applyGroundDelta(note, decision, log = () => {}) {
  const parts = collectParts(note); const used = new Set(); const hits = []; const lost = [];
  for (const text of decision.remove || []) { const idx = parts.findIndex((p, i) => !used.has(i) && p.text === text); if (idx >= 0) { used.add(idx); hits.push({ idx }); } else lost.push(text); }
  const removed = applyRemovals(parts, hits);
  const flags = [
    ...(decision.remove || []).filter((t) => !lost.includes(t)).slice(0, 8).map((t) => ({ type: 'removed_unsupported', field: 'note', message: `"${String(t).slice(0, 120)}"`, severity: 'info' })),
    ...lost.slice(0, 8).map((t) => ({ type: 'check_against_recording', field: 'note', message: `"${String(t).slice(0, 120)}" - the recording does not say this`, severity: 'warning' })),
    ...(decision.flag || []).slice(0, 8).map((r) => ({ type: 'check_against_recording', field: 'note', message: `"${String(r.text).slice(0, 120)}" - ${r.why.slice(0, 90)}${decision.capped ? ' (many lines looked doubtful, none were removed)' : ''}`, severity: 'warning' })),
  ];
  note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), ...flags];
  if (removed || lost.length || (decision.flag || []).length) log(`[v2:ground-delta] checked ${decision.checked} late line(s) · removed ${removed} · flagged ${lost.length + (decision.flag || []).length}`);
  return { removed, flagged: lost.length + (decision.flag || []).length };
}

/** Check and apply at once (GROUND_DELTA=1). */
export async function groundDelta(llm, note, transcript, onlyTexts, log = () => {}, opts = {}) {
  const parts = collectParts(note).filter((p) => onlyTexts.has(p.text));
  const decision = await askGroundDelta(llm, transcript, parts, opts);
  const r = applyGroundDelta(note, decision, log);
  return { checked: decision.checked, removed: decision.remove, flagged: r.flagged, ms: decision.ms, error: decision.error };
}
