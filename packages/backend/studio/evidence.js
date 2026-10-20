// Evidence-linked review ("show me where this came from"). Every bullet of the note is matched to the transcript sentence that supports it.
// A bullet whose evidence quote cannot be found verbatim in the transcript is downgraded to "unverified", so the model cannot invent
// support. Runs in SHADOW mode: it annotates the review screen and never changes the note.
'use strict';

import { askJson, MODELS } from './llm.js';
import { parseRendered } from './conformance.js';

const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Every checkable line of the note with a stable id. */
export function noteClaims(rendered) {
  const P = parseRendered(rendered); const claims = [];
  for (const sec of ['Subjective', 'Past Medical History', 'Objective']) for (const x of P[sec]) if (x.type === 'bullet') claims.push({ id: `c${claims.length + 1}`, section: sec, text: x.text });
  for (const p of P.plan) { claims.push({ id: `c${claims.length + 1}`, section: 'Assessment & Plan', text: p.title }); for (const i of p.items) claims.push({ id: `c${claims.length + 1}`, section: 'Assessment & Plan', text: `${i.label ? i.label + ': ' : ''}${i.text}` }); }
  return claims;
}

export const EVIDENCE_SYS = `You check an AI-written clinical note against the TRANSCRIPT. For EACH numbered note line decide whether the transcript supports it.
Return JSON {"claims":[{"id":"c1","verdict":"supported|partial|unsupported","quote":"the exact words copied from the transcript that support it (max 200 characters), or empty"}]}.
- supported: the transcript says this (a reasonable clinical wording of what was said counts).
- partial: part of the line is supported but a detail (number, drug, side, reason, time) is not.
- unsupported: nothing in the transcript says this.
Copy the quote EXACTLY from the transcript. Never invent a quote. Return every id.`;

export async function mapEvidence({ transcript, rendered, llm }) {
  const claims = noteClaims(rendered); if (!claims.length) return { claims: [], summary: { supported: 0, partial: 0, unsupported: 0, unverified: 0 } };
  const out = await askJson({ llm, model: MODELS.fast(), agent: 'studio-evidence', system: EVIDENCE_SYS, maxOutputTokens: 8000,
    user: `=== TRANSCRIPT ===\n${String(transcript).slice(0, 60000)}\n\n=== NOTE LINES ===\n${claims.map((c) => `${c.id}: ${c.text}`).join('\n')}\n\nReturn ONLY the JSON.` });
  const T = norm(transcript); const byId = Object.fromEntries((out.claims || []).map((c) => [c.id, c]));
  const res = claims.map((c) => {
    const m = byId[c.id] || {}; let verdict = ['supported', 'partial', 'unsupported'].includes(m.verdict) ? m.verdict : 'unsupported'; const quote = String(m.quote || '').slice(0, 220);
    const found = quote && T.includes(norm(quote)) ? true : false;
    if (verdict !== 'unsupported' && !found) verdict = 'unverified';                 // the model claimed support but its quote is not in the transcript
    return { ...c, verdict, quote: found ? quote : '' };
  });
  const summary = { supported: 0, partial: 0, unsupported: 0, unverified: 0 }; for (const c of res) summary[c.verdict]++;
  return { claims: res, summary, at: new Date().toISOString() };
}
