// Treatment planned as sub-points (Style Spec v2.2, owner 2026-10-24: "divide the data in more sub points in treatment planned" and "what went and what to
// go on with"). Works on the rendered Markdown, after the Advice / Follow-up lines were split off. It only re-lays-out the parts of the existing
// "Treatment planned:" line; no wording is added or removed except the leading verb that the label now carries.
//
//   - Treatment planned:
//     - Started: Lyrica (pregabalin) 75 mg twice daily for pain
//     - Stopped: naproxen
//     - Continued: Tylenol (acetaminophen) as needed
//     - Given today: influenza vaccine
//
// Order: what was started, changed, stopped, then what to go on with, what was done in the visit, and anything else. A line with one plain item stays as it is.
'use strict';

const STOP = /^(stop(ped)?|discontinu\w*|d\/c|hold|do not (take|use)|no longer)\b/i;
const CONT = /^(continue[sd]?|refill\w*|renew\w*|resume\w*|maintain\w*|keep (taking|on|using)|remain on|stay on|carry on)\b/i;
const CHANGE = /^(increas\w*|decreas\w*|reduc\w*|titrat\w*|chang\w*|switch\w*|adjust\w*|up-?titrat\w*|taper\w*|double\w*|lower\w*|raise\w*)\b/i;
const GIVEN = /^(administer\w*|given|gave|injected|injection|vaccin\w+ (given|administered)|applied|dressing|cast|splint|suture\w*|irrigat\w*|removed|drained|biopsy done|procedure)\b|\b(administered|given today|given in clinic)\b/i;
const START = /^(start\w*|begin|began|begun|initiat\w*|prescrib\w*|commenc\w*|trial|try|add\w*|new|order\w*|apply|use|take|use)\b/i;
const DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|µg|g|ml|cc|units?|iu|%|tablets?|pills?|puffs?|drops?)\b|\b(od|bid|tid|qid|qhs|prn|daily|twice (a|per) day|once (a|per) day|at (bed|night)time|at night|every \d+ hours?)\b/i;

export const ORDER = ['Started', 'Changed', 'Stopped', 'Continued', 'Given today', 'Other'];
const LEAD = { Started: START, Changed: CHANGE, Stopped: STOP, Continued: CONT };

export function classify(part) {
  const p = String(part).trim();
  if (STOP.test(p)) return 'Stopped';
  if (CONT.test(p)) return 'Continued';
  if (CHANGE.test(p)) return 'Changed';
  if (GIVEN.test(p)) return 'Given today';
  if (START.test(p)) return 'Started';
  if (DOSE.test(p)) return 'Started';   // "Lyrica 75 mg twice daily" with no verb is something to take
  return 'Other';
}

/** The part without the leading verb the label now carries ("Discontinue naproxen" -> "naproxen"), first letter kept as written for drug names. */
export function bare(part, kind) {
  let p = String(part).trim().replace(/\.$/, '');
  const rx = LEAD[kind]; if (rx) { const q = p.replace(rx, '').replace(/^\s*(to|on|the|with|taking|using)?\s*/i, '').trim(); if (q.length >= 3) p = q; }
  return p.replace(/^./, (c) => c.toUpperCase());
}

/** Lay out one "Treatment planned" line; returns the lines to put in its place (an array of strings, indentation included). */
export function layoutTreatment(indent, text) {
  const parts = String(text).split(/;\s+/).map((x) => x.trim()).filter(Boolean);
  const items = parts.map((p) => { const kind = classify(p); return { kind, text: bare(p, kind) }; });
  if (items.length < 2 && (!items.length || items[0].kind === 'Other')) return [`${indent}- Treatment planned: ${parts.join('; ')}`];
  const out = [`${indent}- Treatment planned:`];
  for (const k of ORDER) for (const it of items.filter((x) => x.kind === k)) out.push(`${indent}  - ${k}: ${it.text}`);
  return out;
}

export function structureTreatment(md) {
  const lines = String(md || '').split('\n'); const out = []; let inAP = false;
  for (const l of lines) {
    if (/^###\s+/.test(l)) inAP = /^###\s+Assessment/i.test(l);
    const m = inAP && l.match(/^(\s+)-\s+Treatment planned:\s*(.+)$/);
    if (m) out.push(...layoutTreatment(m[1], m[2])); else out.push(l);
  }
  return out.join('\n');
}
