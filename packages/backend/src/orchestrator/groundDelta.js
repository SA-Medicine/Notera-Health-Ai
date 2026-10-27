// Grounding check of only the lines the main grounding check never saw (audit 2026-10-27).
//
// The main check runs beside coverage, the fact ledger and the story merge, on a copy of the note taken before them. Lines those stages added or reworded were
// therefore never checked by it. This runs the SAME prompt, rules and second look (all imported from groundingAgent.js, which is locked and untouched) on just
// those lines: a handful of lines, so one small call. Off unless GROUND_DELTA=1.
'use strict';

import { GROUND_SYS, collectParts, parseGround, decide, secondLook, applyRemovals, REMOVAL_CAP } from './groundingAgent.js';

export async function groundDelta(llm, note, transcript, onlyTexts, log = () => {}, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  const parts = collectParts(note).filter((p) => onlyTexts.has(p.text));
  if (!parts.length) return { checked: 0, removed: [], flagged: [], ms: 0 };
  const listing = parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
  const raw = await llm.generateContent(GROUND_SYS, `TRANSCRIPT:\n"""\n${String(transcript).slice(0, 60000)}\n"""\n\nNOTE LINES:\n${listing}\n\nReturn ONLY the JSON.`, null,
    { maxOutputTokens: 1500, temperature: 0, timeoutMs, retries: 1, hedgeMs: 0, thinkingBudget: 1024, responseMimeType: 'application/json' });
  const verdicts = parseGround(raw);
  if (verdicts === null) { log('[v2:ground-delta] no usable answer — note unchanged'); return { checked: parts.length, removed: [], flagged: [], ms: Date.now() - t0, error: 'unparseable' }; }
  const d = decide(parts, verdicts, transcript);
  let removeNow = []; let capped = false;
  if (d.remove.length) {
    const sl = await secondLook(llm, transcript, d.remove); removeNow = sl.confirmed;
    if (removeNow.length > Math.max(2, Math.ceil(parts.length * REMOVAL_CAP))) { capped = true; d.flag.push(...removeNow.map((r) => ({ ...r, verdict: 'unsupported' }))); removeNow = []; }
  }
  const removed = applyRemovals(parts, removeNow);
  const flags = [
    ...removeNow.slice(0, 8).map((r) => ({ type: 'removed_unsupported', field: 'note', message: `"${r.text.slice(0, 120)}"`, severity: 'info' })),
    ...d.flag.slice(0, 8).map((r) => ({ type: 'check_against_recording', field: 'note', message: `"${r.text.slice(0, 120)}" - ${String(r.why).slice(0, 90)}${capped ? ' (many lines looked doubtful, none were removed)' : ''}`, severity: 'warning' })),
  ];
  note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), ...flags];
  log(`[v2:ground-delta] checked ${parts.length} late line(s) · removed ${removed} · flagged ${d.flag.length}`);
  return { checked: parts.length, removed: removeNow.map((r) => r.text), flagged: d.flag.length, ms: Date.now() - t0 };
}
