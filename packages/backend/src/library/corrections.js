// What a clinician corrected in a generated note, kept for later learning (see PUT /api/library/consults/:id/note).
// Pure functions: sanitise the events the web app sends, merge them into the consult's feedback record, diff the generated note against the
// clinician's version, and work out which flags are already resolved. Nothing here changes how notes are generated.
'use strict';

export const ACTIONS = ['kept', 'edited', 'removed', 'side_swapped', 'drug_changed', 'added_back', 'left_out', 'undone'];
const MAX_EVENTS_PER_SAVE = 100;
export const MAX_EVENTS_STORED = 400;
const cut = (v, n) => String(v ?? '').slice(0, n);

/** Event = { at, flagType, flagMessage, label, action, before, after }. Unknown actions and non-objects are dropped. */
export function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, MAX_EVENTS_PER_SAVE)) {
    if (!e || typeof e !== 'object' || !ACTIONS.includes(e.action)) continue;
    const at = Number.isFinite(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
    out.push({ at, flagType: cut(e.flagType, 60), flagMessage: cut(e.flagMessage, 400), label: cut(e.label, 60), action: e.action, before: cut(e.before, 400), after: cut(e.after, 400) });
  }
  return out;
}

const norm = (l) => String(l || '').replace(/^\s*[-•*]\s*/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const lines = (md) => String(md || '').split('\n').map(norm).filter((l) => l && !/^#{1,6}\s/.test(l));

/** Lines the clinician removed from, or added to, the generated note (as a set difference; order and moves are not tracked). */
export function diffLines(generatedMd, finalMd) {
  const a = lines(generatedMd); const b = lines(finalMd); const A = new Set(a); const B = new Set(b);
  const removed = a.filter((l) => !B.has(l)); const added = b.filter((l) => !A.has(l));
  return { removed: removed.slice(0, 80).map((l) => l.slice(0, 300)), added: added.slice(0, 80).map((l) => l.slice(0, 300)), removedCount: removed.length, addedCount: added.length, editRate: +((removed.length + added.length) / Math.max(a.length, 1)).toFixed(3) };
}

export function mergeFeedback(prev, events, diff) {
  const old = Array.isArray(prev?.events) ? prev.events : [];
  return { events: [...old, ...events].slice(-MAX_EVENTS_STORED), diff, updatedAt: new Date().toISOString() };
}

/** Flag messages the clinician has dealt with (an Undo puts the flag back). */
export function resolvedMessages(events) {
  const s = new Set();
  for (const e of Array.isArray(events) ? events : []) { if (!e?.flagMessage) continue; if (e.action === 'undone') s.delete(e.flagMessage); else s.add(e.flagMessage); }
  return s;
}
