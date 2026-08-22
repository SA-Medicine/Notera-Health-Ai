// ─────────────────────────────────────────────────────────────────────────────
// Run Summary (Metrics v2) — the "Eval Analyst" agent.
//
// Takes ALL of a run's per-fixture LLM comparison reports (<fixture>.compare.json:
// overall_score, verdict, dimensions, notera_missing, notera_extra, key_differences,
// summary) plus the deterministic metric summary, and produces ONE executive run
// report. Aggregates (average score, verdict split, per-dimension means, worst/best
// fixtures) are computed IN CODE for reliability; an LLM is used only for the
// qualitative synthesis (recurring themes, failure modes, recommendations, narrative),
// with a Notera product-aware prompt. Degrades gracefully with no LLM.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { createGeminiService } from '../services/LLMService.js';

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function parseJson(raw) {
  const s = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch { /* repair */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ } }
  return null;
}
const r2 = (v) => (v == null ? null : +v.toFixed(2));

/** Deterministic aggregation over the per-fixture comparison reports. */
export function aggregateCompares(compares) {
  const scored = compares.filter((c) => typeof c.overall_score === 'number');
  const avg_overall = r2(mean(scored.map((c) => c.overall_score)));
  const verdict_counts = { notera_better: 0, gold_better: 0, equivalent: 0, other: 0 };
  for (const c of compares) { const v = String(c.verdict || 'other'); verdict_counts[v] = (verdict_counts[v] ?? verdict_counts.other) + 1; if (!(v in verdict_counts)) verdict_counts.other++; }
  // per-dimension means (Notera vs Gold)
  const dims = {};
  for (const c of compares) for (const d of (c.dimensions || [])) { if (!d || !d.name) continue; const k = d.name; (dims[k] ??= { notera: [], gold: [] }); if (typeof d.notera === 'number') dims[k].notera.push(d.notera); if (typeof d.gold === 'number') dims[k].gold.push(d.gold); }
  const dimension_averages = Object.entries(dims).map(([name, v]) => ({ name, notera: r2(mean(v.notera)), gold: r2(mean(v.gold)), gap: r2((mean(v.gold) ?? 0) - (mean(v.notera) ?? 0)) }));
  const byScore = [...scored].sort((a, b) => a.overall_score - b.overall_score);
  const worst_fixtures = byScore.slice(0, 6).map((c) => ({ fixture: c.fixture, score: c.overall_score, verdict: c.verdict, why: (c.notera_missing || [])[0] || (c.summary || '').slice(0, 120) }));
  const best_fixtures = byScore.slice(-6).reverse().map((c) => ({ fixture: c.fixture, score: c.overall_score, verdict: c.verdict }));
  return { n_fixtures: compares.length, n_scored: scored.length, avg_overall, verdict_counts, dimension_averages, worst_fixtures, best_fixtures };
}

const SYS = `You are the EVAL ANALYST for Notera — a clinical documentation engine that converts raw consultation transcripts into schema-structured SOAP notes, benchmarked against clinician "gold" reference notes. You are given the per-fixture comparison reports for ONE evaluation run (each: a 0–100 score, a verdict of notera_better/gold_better/equivalent, the facts Notera MISSED vs gold, the UNSUPPORTED extras Notera added, key differences, and a one-line summary).

Synthesize a concise, decision-useful run report for the team. Focus on PATTERNS across fixtures, not per-fixture detail. Identify the recurring ways Notera loses to gold (e.g. dropped plan facts, missing etiology, fabricated names/doses, over-long subjective), quantify how often each occurs, and give concrete, prioritized fixes tied to Notera's pipeline (extractor / slot-filler / story / tightener / hallucination-remover / guardrails).

Return ONLY this JSON (no markdown):
{
  "headline": "one blunt sentence on where this run stands",
  "recurring_missing": ["the kinds of facts Notera most often DROPS vs gold, most common first"],
  "recurring_fabrications": ["the kinds of unsupported content Notera most often ADDS"],
  "failure_themes": [ { "theme": "short name", "count": <how many fixtures show it>, "examples": ["fixture: brief"] } ],
  "recommendations": ["specific, prioritized fixes; reference the responsible pipeline stage"],
  "narrative": "2-4 short paragraphs: overall quality, the main gaps vs gold, and what to fix next"
}`;

/** LLM synthesis of qualitative themes (best-effort) — runs on the main-pipeline LLM (Gemini). */
export async function synthesize(compares, { llm = null } = {}) {
  const compact = compares.slice(0, 60).map((c) => ({
    fixture: c.fixture, score: c.overall_score, verdict: c.verdict,
    missing: (c.notera_missing || []).slice(0, 6), extra: (c.notera_extra || []).slice(0, 6),
    key: (c.key_differences || []).slice(0, 4), summary: String(c.summary || '').slice(0, 240),
  }));
  const user = `RUN comparison reports (${compact.length} fixtures):\n${JSON.stringify(compact)}\n\nProduce the executive run report as JSON.`;
  try {
    const svc = llm || await createGeminiService();
    if (!svc) return { ok: false, error: 'no LLM service' };
    const raw = await svc.generateContent(SYS, user, null, { maxOutputTokens: 2600 });
    const data = parseJson(raw);
    if (!data) return { ok: false, error: 'could not parse run-summary JSON' };
    return { ok: true, model: svc.model || 'gemini', ...data };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Full report: deterministic aggregates + metric summary + LLM synthesis. */
export async function buildRunSummary(compares, metricSummary, { llm } = {}) {
  const agg = aggregateCompares(compares);
  const synth = await synthesize(compares, { llm });
  return {
    ...agg,
    metrics: metricSummary || null,
    headline: synth.ok ? synth.headline : null,
    recurring_missing: synth.ok ? (synth.recurring_missing || []) : [],
    recurring_fabrications: synth.ok ? (synth.recurring_fabrications || []) : [],
    failure_themes: synth.ok ? (synth.failure_themes || []) : [],
    recommendations: synth.ok ? (synth.recommendations || []) : [],
    narrative: synth.ok ? (synth.narrative || '') : '',
    synthesized: synth.ok,
    synthError: synth.ok ? null : (synth.error || 'LLM synthesis unavailable'),
    model: synth.model || null,
    generatedAt: new Date().toISOString(),
  };
}
