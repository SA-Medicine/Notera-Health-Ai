// Second reading for the fact graph (audit 2026-10-27). The fact extractor is not deterministic: the same recording gave a plan with the lab order in one run and without it in the next, and
// the facts that stay missing from finished notes are almost all facts the extractor never produced (85-93% on 60 gold notes). This runs one more, independent reading of the recording at the
// same time as the normal graph (different window borders), and adds the facts of it that the normal graph does not have. factGraph.js itself is unchanged (it is part of the locked spec files).
// Off unless FACT_GRAPH_RUNS=2.
'use strict';

import { buildFactGraph, windowsOf, mergeGraphs, numberFacts, WINDOW_WORDS, OVERLAP_WORDS } from './factGraph.js';
import { ClinicalObservationExtractorAgent } from '../pipeline/agents/ClinicalObservationExtractorAgent.js';
import { createGeminiService } from '../services/LLMService.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const keyOf = (f) => norm(f.quote).slice(0, 80) + '|' + norm(f.type) + '|' + norm(f.text).slice(0, 60);

/** Facts of a second reading that the first graph lacks, numbered after it. Pure. */
export function addNewFacts(base, extra) {
  const have = new Set(base.map(keyOf)); const quotes = new Set(base.map((f) => norm(f.quote).slice(0, 60)).filter(Boolean));
  const out = []; let n = base.length;
  for (const f of extra) {
    const k = keyOf(f); if (have.has(k)) continue;
    const q = norm(f.quote).slice(0, 60); if (q && quotes.has(q) && base.some((b) => norm(b.quote).slice(0, 60) === q && norm(b.text).slice(0, 25) === norm(f.text).slice(0, 25))) continue;
    have.add(k); n++; out.push({ ...f, id: 'F' + String(n).padStart(3, '0'), index: n - 1, second: true });
  }
  return out;
}

async function secondReading(transcript, { log, encounterType }) {
  const wins = windowsOf(transcript, { size: Math.round(WINDOW_WORDS * 0.75), overlap: OVERLAP_WORDS - 10 });
  const graphs = await Promise.all(wins.map(async (w, i) => {
    const llm = await createGeminiService(); llm._agent = 'observation-extractor';
    try { return await new ClinicalObservationExtractorAgent(llm).execute(w, encounterType); } catch (e) { log(`[v2:facts] second reading, window ${i + 1}/${wins.length} failed — ${String(e.message).slice(0, 120)}`); return null; }
  }));
  return numberFacts(mergeGraphs(graphs), transcript).facts;
}

export async function buildFactGraphPlus(transcript, opts = {}) {
  if (process.env.FACT_GRAPH_RUNS !== '2') return buildFactGraph(transcript, opts);
  const log = opts.log || (() => {}); const encounterType = opts.encounterType || 'general_primary_care';
  const [base, extra] = await Promise.all([buildFactGraph(transcript, opts), secondReading(transcript, { log, encounterType }).catch(() => [])]);
  if (!base.facts?.length) return base;
  const added = addNewFacts(base.facts, extra);
  if (added.length) log(`[v2:facts] second reading added ${added.length} fact(s) the first reading did not have`);
  const facts = [...base.facts, ...added]; const counts = facts.reduce((m, f) => { m[f.type] = (m[f.type] || 0) + 1; return m; }, {});
  return { ...base, facts, counts, secondAdded: added.length };
}
