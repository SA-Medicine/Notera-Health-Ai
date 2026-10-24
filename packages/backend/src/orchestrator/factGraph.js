// Fact graph for the v2 note pipeline (Style Spec v2.3, owner 2026-10-24: "the facts are generated in a graph ... so missing lines or missing facts are not there").
//
// The owner's v1 pipeline already has the agent that does this: ClinicalObservationExtractorAgent reads the transcript and returns every clinical fact
// as a record (entity_type, clinical_role, importance, source_quote, body_part, medication / dose / frequency / status, value / unit, objective_region_label ...)
// with edges between them (treated_by, investigated_by, ...), plus numeric_data, orders, follow_ups and medication_decisions. ClinicalRecallAnalyzer then
// checks which categories look empty and FactRecoveryAgent re-reads the transcript for those. This module runs that same chain for the v2 pipeline:
//   * a long transcript is read in overlapping windows in parallel (one call over 2 000 words returned 29 facts; windows return more and finish sooner),
//   * the windows are merged, de-duplicated and numbered F001, F002 ...,
//   * every fact keeps its exact source_quote, checked by code against the transcript (start/end positions), so a fact is grounded by construction.
// The graph is then used by factLedger.js to check that every fact is in the note and to place the ones that are not.
// Off switch: FACT_GRAPH=0. Nothing here writes into the note.
'use strict';

import { ClinicalObservationExtractorAgent } from '../pipeline/agents/ClinicalObservationExtractorAgent.js';
import { RelationshipEngine } from '../pipeline/agents/engines/RelationshipEngine.js';
import { ClinicalRecallAnalyzer } from '../pipeline/agents/ClinicalRecallAnalyzer.js';
import { FactRecoveryAgent } from '../pipeline/agents/FactRecoveryAgent.js';
import { createGeminiService } from '../services/LLMService.js';

export const WINDOW_WORDS = 650;      // a window this long returns its facts in about 5-8 s
export const OVERLAP_WORDS = 90;      // a fact spoken at the border is seen by both windows
export const SWEEP_CATEGORIES = [
  'follow_up: every return visit, recheck or "see you again", with its timeframe, and anything the clinician will do once tests are done',
  'medication: every drug named, with dose, frequency, quantity, refills, pharmacy, and whether it was started, stopped, changed, continued or only discussed; every change of dose',
  'treatment_instruction: every piece of advice, warning or instruction the clinician gave the patient, with its duration (for example "for life")',
  'investigation: every test, scan or blood work ordered, planned, reviewed or due, with its date or timeframe',
  'social_history: age band, menopause status, travel plans, work, who the patient lives with, when the patient states it',
];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Split a transcript into overlapping windows on sentence ends. One window when it is short. */
export function windowsOf(transcript, { size = WINDOW_WORDS, overlap = OVERLAP_WORDS } = {}) {
  const words = String(transcript || '').split(/\s+/).filter(Boolean);
  if (words.length <= size * 1.25) return [String(transcript || '')];
  const out = []; let start = 0;
  while (start < words.length) {
    let end = Math.min(words.length, start + size);
    if (end < words.length) { for (let k = end; k > start + size * 0.7; k--) if (/[.?!]$/.test(words[k - 1])) { end = k; break; } }   // end the window at a sentence
    out.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return out;
}

/** Merge the graphs of several windows into one (entity indexes in the edges are moved to the merged list). */
export function mergeGraphs(graphs) {
  const merged = { clinical_entities: [], relationships: [], current_medications: [], numeric_data: [], orders: [], follow_ups: [], medication_decisions: [], encounter_subject: '' };
  const seen = new Map(); const keyOf = (e) => norm(e.source_quote || e.source_span || '').slice(0, 80) + '|' + norm(e.entity_type) + '|' + norm(e.display_text).slice(0, 60);
  for (const g of graphs) {
    if (!g) continue; const map = new Map();
    (g.clinical_entities || []).forEach((e, i) => {
      const k = keyOf(e); if (seen.has(k)) { map.set(i, seen.get(k)); return; }
      merged.clinical_entities.push(e); seen.set(k, merged.clinical_entities.length - 1); map.set(i, merged.clinical_entities.length - 1);
    });
    for (const r of g.relationships || []) { const s = map.get(r.source_index), t = map.get(r.target_index); if (s != null && t != null && s !== t && !merged.relationships.some((x) => x.source_index === s && x.target_index === t && x.relationship === r.relationship)) merged.relationships.push({ source_index: s, target_index: t, relationship: r.relationship }); }
    const addUnique = (field, key) => { const have = new Set(merged[field].map((x) => norm(typeof x === 'string' ? x : key(x)))); for (const x of g[field] || []) { const k = norm(typeof x === 'string' ? x : key(x)); if (k && !have.has(k)) { have.add(k); merged[field].push(x); } } };
    addUnique('current_medications', (x) => x);
    addUnique('numeric_data', (x) => `${x.test_name} ${x.value} ${x.unit || ''}`);
    addUnique('orders', (x) => `${x.test} ${x.status || ''} ${x.laterality || ''}`);
    addUnique('follow_ups', (x) => `${x.timeframe || ''} ${x.trigger || ''} ${x.followup_type || ''}`);
    addUnique('medication_decisions', (x) => `${x.medication} ${x.action || ''} ${x.planned_dose || ''}`);
    if (!merged.encounter_subject && g.encounter_subject) merged.encounter_subject = g.encounter_subject;
  }
  return merged;
}

/** Numbered facts with their grounding: F001 ..., transcript position of the exact quote, only the fields later stages read. */
export function numberFacts(graph, transcript) {
  const tx = String(transcript || ''); const txl = tx.toLowerCase();
  const facts = (graph.clinical_entities || []).map((e, i) => {
    const quote = String(e.source_quote || e.source_span || '').trim(); let at = quote ? txl.indexOf(quote.toLowerCase()) : -1;
    if (at < 0 && quote.length > 30) at = txl.indexOf(quote.toLowerCase().slice(0, 30));
    return {
      id: 'F' + String(i + 1).padStart(3, '0'), index: i, type: e.entity_type, role: e.clinical_role, slot: e.heidi_slot || '', text: String(e.display_text || '').trim(), importance: e.importance || 'major',
      confidence: typeof e.confidence === 'number' ? e.confidence : 0.8, actor: e.actor || '', status: e.status || '', certainty: e.certainty || '', body_part: e.body_part || '', region: e.objective_region_label || '',
      medication: e.medication || '', medication_status: e.medication_status || '', dose: e.dose || '', frequency: e.frequency || '', value: e.value || '', unit: e.unit || '', numeric_type: e.numeric_type || '',
      result_status: e.result_status || '', date: e.observation_date || '', negative: e.clinical_role === 'negative_finding' || e.is_negative === true, render_required: e.render_required !== false,
      quote, grounded: at >= 0, at,
    };
  });
  const edges = (graph.relationships || []).map((r) => ({ from: facts[r.source_index]?.id, to: facts[r.target_index]?.id, relationship: r.relationship })).filter((r) => r.from && r.to);
  return { facts, edges };
}

/**
 * Build the graph for one transcript. Never throws: a failure returns { facts: [], error } and the note is written without a graph.
 * @returns {{ facts, edges, orders, followUps, medications, counts, windows, recovered, ms, error? }}
 */
export async function buildFactGraph(transcript, { log = () => {}, encounterType = 'general_primary_care', recover = true } = {}) {
  const t0 = Date.now();
  try {
    const wins = windowsOf(transcript);
    // The details the plan is made of are the ones a first pass leaves out most often (the audit of 16 notes: follow-up after the tests, "up the dose", recheck in 6-12 months,
    // a drug's quantity and pharmacy, advice "for life"). The owner's recovery agent is therefore run on every transcript for these categories, at the same time as the windows.
    const sweepP = (!recover || process.env.FACT_SWEEP === '0') ? Promise.resolve(null) : (async () => {
      try { const llm = await createGeminiService(); llm._agent = 'fact-recovery'; const g0 = await new FactRecoveryAgent(llm).execute(transcript, SWEEP_CATEGORIES, { clinical_entities: [] }); return { clinical_entities: g0.clinical_entities || [], relationships: [] }; }
      catch (e) { log(`[v2:facts] detail sweep skipped — ${String(e.message).slice(0, 100)}`); return null; }
    })();
    const graphs = await Promise.all(wins.map(async (w, i) => {
      const llm = await createGeminiService(); llm._agent = 'observation-extractor';
      try { return await new ClinicalObservationExtractorAgent(llm).execute(w, encounterType); } catch (e) { log(`[v2:facts] window ${i + 1}/${wins.length} failed — ${String(e.message).slice(0, 120)}`); return null; }
    }));
    const swept = await sweepP; const sweptN = swept?.clinical_entities?.length || 0;
    let g = mergeGraphs([...graphs, swept]);
    if (sweptN) log(`[v2:facts] detail sweep returned ${sweptN} fact(s), ${g.clinical_entities.length - graphs.reduce((n, x) => n + (x?.clinical_entities?.length || 0), 0)} of them new`);
    if (!g.clinical_entities.length) return { facts: [], edges: [], orders: [], followUps: [], medications: [], counts: {}, windows: wins.length, recovered: 0, ms: Date.now() - t0, error: 'no facts returned' };
    try { g = RelationshipEngine.execute(g); } catch { /* the engine only adds edges */ }
    let recovered = 0;
    if (recover) {
      try {
        const rec = ClinicalRecallAnalyzer.analyze(transcript, g);
        if (rec.needsRecovery && rec.missingCategories?.length) {
          const llm = await createGeminiService(); llm._agent = 'fact-recovery'; const before = g.clinical_entities.length;
          g = await new FactRecoveryAgent(llm).execute(transcript, rec.missingCategories, g); recovered = g.clinical_entities.length - before;
          if (recovered) log(`[v2:facts] recovery for ${rec.missingCategories.join(', ')}: ${recovered} more fact(s)`);
        }
      } catch (e) { log(`[v2:facts] recovery skipped — ${String(e.message).slice(0, 100)}`); }
    }
    const { facts, edges } = numberFacts(g, transcript);
    const counts = facts.reduce((m, f) => { m[f.type] = (m[f.type] || 0) + 1; return m; }, {});
    log(`[v2:facts] ${facts.length} fact(s) from ${wins.length} window(s), ${edges.length} edge(s), ${facts.filter((f) => f.grounded).length} with a verified quote`);
    return { facts, edges, orders: g.orders || [], followUps: g.follow_ups || [], medications: g.current_medications || [], medicationDecisions: g.medication_decisions || [], numeric: g.numeric_data || [], counts, windows: wins.length, recovered, ms: Date.now() - t0 };
  } catch (e) {
    log(`[v2:facts] skipped — ${String(e.message).slice(0, 140)}`);
    return { facts: [], edges: [], orders: [], followUps: [], medications: [], counts: {}, windows: 0, recovered: 0, ms: Date.now() - t0, error: String(e.message).slice(0, 200) };
  }
}
