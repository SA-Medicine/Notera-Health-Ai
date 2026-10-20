// Learning from the doctor's own edits (the signal Heidi and Freed use for "personalisation"): the difference between what the AI wrote
// and what the doctor kept is computed deterministically; a model then states the style PREFERENCES behind the edits as readable,
// PHI-free rules (PRELUDE/CIPHER idea, Gao et al., NeurIPS 2024). The rules are PROPOSALS for a future spec — never applied automatically.
'use strict';

import { askJson, MODELS } from './llm.js';

const clean = (l) => l.replace(/^\s*[-*•]\s+/, '').replace(/\*\*/g, '').replace(/^\d+\.\s+/, '').trim();
const key = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (t) => new Set(key(t).split(' ').filter((w) => w.length > 3));
const sim = (a, b) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; return [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size); };

export function toLines(md) {
  const out = []; let section = 'Note';
  for (const raw of String(md || '').split('\n')) {
    const h = raw.match(/^###\s+(.*)$/); if (h) { section = h[1].trim(); continue; }
    const t = clean(raw); if (t) out.push({ section, text: t });
  }
  return out;
}

/** → { removed:[{section,text}], added:[{section,text}], reworded:[{section,from,to}], kept, edit_rate } */
export function diffRendered(before, after) {
  const B = toLines(before), A = toLines(after);
  const aKeys = new Set(A.map((x) => key(x.text))), bKeys = new Set(B.map((x) => key(x.text)));
  const removed = B.filter((x) => !aKeys.has(key(x.text))); const added = A.filter((x) => !bKeys.has(key(x.text)));
  const reworded = []; const usedAdded = new Set();
  for (const r of removed.slice()) {
    let best = -1, bs = 0; added.forEach((a, i) => { if (usedAdded.has(i) || a.section !== r.section) return; const s = sim(r.text, a.text); if (s > bs) { bs = s; best = i; } });
    if (best >= 0 && bs >= 0.5) { usedAdded.add(best); reworded.push({ section: r.section, from: r.text, to: added[best].text }); }
  }
  const rw = new Set(reworded.map((x) => key(x.from))); const rwTo = new Set(reworded.map((x) => key(x.to)));
  const pureRemoved = removed.filter((x) => !rw.has(key(x.text))); const pureAdded = added.filter((x) => !rwTo.has(key(x.text)));
  const kept = B.length - removed.length;
  return { removed: pureRemoved, added: pureAdded, reworded, kept, total_before: B.length, edit_rate: B.length ? (pureRemoved.length + pureAdded.length + reworded.length) / B.length : 0 };
}

export const EDIT_SYS = `You study how a physician edited an AI-written clinical note. You get the edits: lines she DELETED, lines she ADDED, and lines she REWORDED (from -> to), each with its section.
State the style PREFERENCES behind them as general, reusable rules. Rules:
- Only preferences that the edits clearly support. If an edit is a one-off correction of a fact for this patient, do not turn it into a rule.
- No patient-specific detail (no names, drugs, numbers, dates, places). Write the rule so it applies to any patient.
- At most 5 proposals. kind: add_rule | change_rule | remove_rule | wording. section: Subjective | Past Medical History | Objective | Assessment & Plan | Overall.
Return JSON {"proposals":[{"title":"short","section":"...","kind":"...","rule":"one or two sentences","because":"which edits show it"}]}.`;

export async function inferPreferences({ diff, llm }) {
  const n = diff.removed.length + diff.added.length + diff.reworded.length; if (!n) return [];
  const fmt = (arr, f) => arr.slice(0, 25).map(f).join('\n') || '(none)';
  const out = await askJson({ llm, model: MODELS.fast(), agent: 'studio-edits', system: EDIT_SYS, maxOutputTokens: 3000,
    user: `DELETED:\n${fmt(diff.removed, (x) => `[${x.section}] ${x.text}`)}\n\nADDED:\n${fmt(diff.added, (x) => `[${x.section}] ${x.text}`)}\n\nREWORDED:\n${fmt(diff.reworded, (x) => `[${x.section}] "${x.from}" -> "${x.to}"`)}\n\nReturn ONLY the JSON.` });
  return (Array.isArray(out.proposals) ? out.proposals : []).slice(0, 5).map((p) => ({
    title: String(p.title || p.rule || '').slice(0, 140), section: String(p.section || 'Overall').slice(0, 40), kind: String(p.kind || 'add_rule').slice(0, 20),
    rule: String(p.rule || '').slice(0, 500), because: String(p.because || '').slice(0, 300),
  })).filter((p) => p.title && p.rule);
}
