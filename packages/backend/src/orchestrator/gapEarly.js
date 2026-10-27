// Gap pass in parallel with the story agent (audit 2026-10-27, experiment GAP_EARLY=1; off by default).
//
// Today the coverage check (7.5 s) and the fact ledger's AI call (5 s) run one after the other AFTER the story agent. Neither needs the story's wording: both ask
// "what was said and is not in the note", and the story agent only rewrites wording it must keep every fact of. So the two questions are asked while the story agent
// works, on a copy of the note taken just before it; the answers are applied to the finished note afterwards. Nothing about WHAT is checked changes; only when.
//
// Three things make an answer given about the earlier copy safe for the later note:
//   - plan problems are numbered in the copy; numbers are translated back to the current problems by their titles,
//   - "this line already says it" claims name a line of the copy; the claim is moved to the most similar line of the current note (the code check that a critical
//     fact's words and numbers are in that line still runs, unchanged),
//   - a fact the code had already found in the copy is still there after the story (the story is rejected if it loses one): it is not asked about again.
// Every addition still needs its exact transcript quote and the "not already in the note" test at the moment it is applied (applyCoverage / applyPlacement, unchanged).
'use strict';

import { overlap } from './planSweep.js';
import { parseCoverage } from './noteCoverage.js';
import { requiredFacts, ledger, askPlacement } from './factLedger.js';
import { noteToMarkdown } from './renderMarkdown.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Titles of the plan problems, in order: the numbering the early questions were asked with. */
export const issuesOf = (note) => (note.assessment_and_plan || []).map((p) => String(p?.issue || ''));

/** Plan item numbers of an early coverage answer, translated to the current problem list. A problem that is gone becomes "no problem" (n = 0) with its old title as the topic. */
export function remapCoverageRaw(raw, askedIssues, note) {
  if (raw == null) return raw;
  const now = issuesOf(note);
  const items = parseCoverage(raw).map((it) => {
    if (it?.section !== 'plan' || !(Number(it.n) >= 1)) return it;
    const old = askedIssues[Number(it.n) - 1] || ''; let at = now.findIndex((t) => norm(t) === norm(old));
    if (at < 0) at = now.findIndex((t) => overlap(t, old) >= 0.85);
    return at >= 0 ? { ...it, n: at + 1 } : { ...it, n: 0, topic: it.topic || old };
  });
  return JSON.stringify({ items });
}

/** Start the ledger's AI question early. Resolves to { graph, foundIds, askedIds, answer, issues } (or { error }). `note` must be a copy that nothing changes afterwards. */
export function askLedgerEarly(factsP, snap, llm) {
  return (async () => {
    const graph = await factsP; if (!graph?.facts?.length) return null;
    const all = requiredFacts(graph.facts); const L = ledger(snap, all);
    const missingIds = new Set(L.missing.map((f) => f.id));
    const answer = L.missing.length ? await askPlacement(llm, snap, L.missing) : null;
    return { graph, foundIds: new Set(all.filter((f) => !missingIds.has(f.id)).map((f) => f.id)), askedIds: missingIds, answer, issues: issuesOf(snap), snapText: noteToMarkdown(snap) };
  })().catch((error) => ({ error }));
}

const lineOf = (note) => noteToMarkdown(note).split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim()).filter((l) => l.length >= 8);
const best = (text, lines) => { let b = null, s0 = 0.5; for (const l of lines) { const s = overlap(text, l); if (s > s0) { s0 = s; b = l; } } return b; };

/**
 * An object that stands in for the model in reconcileFacts(): it answers with the early answer, rewritten for the current note.
 *  - a "found_in" line of the copy becomes the most similar line of the current note (or the claim is dropped when there is none),
 *  - a fact the code found in the copy but not in the current note (the story reworded the line) gets a "found_in" for its best current line,
 *  - plan numbers are translated (remapCoverageRaw-style) so placements go to the right problem.
 */
export function ledgerShim(early, note) {
  return {
    generateContent: async () => {
      const missingNow = new Map(ledger(note, requiredFacts(early.graph.facts)).missing.map((f) => [f.id, f]));   // what reconcileFacts is asking about, on the current note
      const lines = lineOf(note); let entries = [];
      try { entries = JSON.parse(String(early.answer?.raw || '{}').replace(/^```json|```$/g, '').trim()).entries || []; } catch { entries = []; }
      const nowIssues = issuesOf(note); const have = new Set();
      const out = [];
      for (const e of entries) {
        if (!e?.fact || !missingNow.has(e.fact)) continue; have.add(e.fact);
        if (e.found_in) { const b = best(e.found_in, lines); if (b) out.push({ ...e, found_in: b }); continue; }
        if (Number(e.n) >= 1) { const old = early.issues[Number(e.n) - 1] || ''; let at = nowIssues.findIndex((t) => norm(t) === norm(old)); if (at < 0) at = nowIssues.findIndex((t) => overlap(t, old) >= 0.85); out.push(at >= 0 ? { ...e, n: at + 1 } : { ...e, n: 0, topic: e.topic || old }); continue; }
        out.push(e);
      }
      for (const f of missingNow.values()) {   // found by code in the copy, reworded since: still there; point at its best current line
        if (have.has(f.id) || !early.foundIds.has(f.id)) continue;
        const b = best(f.text, lines); if (b) out.push({ fact: f.id, found_in: b });
      }
      return JSON.stringify({ entries: out });
    },
  };
}
