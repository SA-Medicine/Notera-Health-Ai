// ─────────────────────────────────────────────────────────────────────────────
// Compare engine (Metrics v2 · P2) — the analysis core.
//
// Runs are compared PAIRED over fixtures: both runs see the same fixtures, so the
// per-fixture difference controls for fixture difficulty and yields far tighter
// intervals than comparing two independent means. We return, per metric:
//   n, base mean, each run's mean + Δ vs base + 95% paired-bootstrap CI + a
//   POLARITY-AWARE verdict (improved / regressed / no-change / underpowered).
// And a per-fixture grid for a focus metric with each fixture's Δ and its
// contribution % to the aggregate Δ (catches "one fixture carried the whole move").
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { describeMetric, isImprovement, valueFromRow, metricKeysInRows, HEADLINE_KEYS } from './registry.js';

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// deterministic PRNG so cached compares are reproducible
function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

// percentile bootstrap CI on the paired differences
function pairedBootstrapCI(deltas, { B = 3000, alpha = 0.05, seed = 12345 } = {}) {
  const n = deltas.length;
  if (n < 2) return { low: null, high: null };
  const rnd = mulberry32(seed);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[(rnd() * n) | 0];
    means[b] = s / n;
  }
  means.sort((a, z) => a - z);
  const lo = means[Math.floor((alpha / 2) * B)];
  const hi = means[Math.floor((1 - alpha / 2) * B) - 1];
  return { low: lo, high: hi };
}

const indexById = (rows) => { const m = new Map(); for (const r of rows || []) if (r && r.id != null) m.set(String(r.id), r); return m; };

/**
 * @param baseRows  result rows of the baseline run
 * @param targets   [{ dir, rows }]
 * @param opts      { focusKey, system, minN }
 */
export function buildComparison(baseRows, targets, opts = {}) {
  const minN = opts.minN ?? 8;
  const baseIdx = indexById(baseRows);

  // candidate metric keys = union across base + all targets, optionally system-filtered
  const keySet = new Set(metricKeysInRows(baseRows));
  for (const t of targets) for (const k of metricKeysInRows(t.rows)) keySet.add(k);
  let keys = [...keySet];
  if (opts.system) keys = keys.filter((k) => { const s = describeMetric(k).system; return s == null || s === opts.system; });

  const metrics = keys.map((key) => {
    const meta = describeMetric(key);
    const baseVals = [...baseIdx.values()].map((r) => valueFromRow(r, key)).filter((v) => typeof v === 'number');
    const baseMean = baseVals.length ? mean(baseVals) : null;
    const runs = targets.map((t) => {
      const idx = indexById(t.rows);
      const tVals = [...idx.values()].map((r) => valueFromRow(r, key)).filter((v) => typeof v === 'number');
      // paired deltas over fixtures present (numeric) in BOTH runs
      const deltas = [];
      for (const [id, r] of idx) { const b = baseIdx.get(id); if (!b) continue; const tv = valueFromRow(r, key), bv = valueFromRow(b, key); if (typeof tv === 'number' && typeof bv === 'number') deltas.push(tv - bv); }
      const n = deltas.length;
      const delta = n ? mean(deltas) : null;
      const ci = pairedBootstrapCI(deltas);
      const crossesZero = ci.low == null || (ci.low <= 0 && ci.high >= 0);
      const significant = n >= 2 && !crossesZero;
      const underpowered = n < minN || crossesZero;
      const improved = delta == null ? null : isImprovement(delta, key);
      const verdict = n < 2 ? 'no_data' : underpowered ? 'indicative' : improved === null ? 'changed' : improved ? 'improved' : 'regressed';
      return { dir: t.dir, mean: tVals.length ? mean(tVals) : null, n, delta, ciLow: ci.low, ciHigh: ci.high, significant, underpowered, improved, verdict };
    });
    return { key, meta, base: baseMean, baseN: baseVals.length, runs };
  });

  // sort: critical first, then significant by |effect|, then the rest
  const rank = (m) => {
    const sev = m.meta.severity === 'critical' ? 0 : m.meta.severity === 'major' ? 1 : 2;
    const anySig = m.runs.some((r) => r.significant) ? 0 : 1;
    const eff = -Math.max(0, ...m.runs.map((r) => Math.abs(r.delta || 0)));
    return [sev, anySig, eff];
  };
  metrics.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]; });

  // per-fixture grid for a focus metric vs the FIRST target run
  const focusKey = opts.focusKey && keys.includes(opts.focusKey) ? opts.focusKey : (HEADLINE_KEYS.find((k) => keys.includes(k)) || keys[0]);
  let perFixture = { focusKey: focusKey || null, rows: [] };
  if (focusKey) {
    const ids = new Set([...baseIdx.keys()]);
    for (const t of targets) for (const id of indexById(t.rows).keys()) ids.add(id);
    const firstIdx = targets[0] ? indexById(targets[0].rows) : new Map();
    const rows = [];
    for (const id of ids) {
      const bv = valueFromRow(baseIdx.get(id), focusKey);
      const runVals = targets.map((t) => valueFromRow(indexById(t.rows).get(id), focusKey));
      const fv = valueFromRow(firstIdx.get(id), focusKey);
      const delta = (typeof fv === 'number' && typeof bv === 'number') ? fv - bv : null;
      rows.push({ fixture: id, base: bv, runs: runVals, delta });
    }
    const totalAbs = rows.reduce((s, r) => s + Math.abs(r.delta || 0), 0) || 1;
    for (const r of rows) r.contributionPct = r.delta == null ? null : +(Math.abs(r.delta) / totalAbs * 100).toFixed(1);
    rows.sort((a, z) => Math.abs(z.delta || 0) - Math.abs(a.delta || 0));
    perFixture = { focusKey, rows };
  }

  // power hint: minimum detectable effect ≈ from the base variance & n (rough, informative)
  const focusMeta = focusKey ? describeMetric(focusKey) : null;
  const baseFocus = focusKey ? [...baseIdx.values()].map((r) => valueFromRow(r, focusKey)).filter((v) => typeof v === 'number') : [];
  const sd = (() => { if (baseFocus.length < 2) return null; const m = mean(baseFocus); return Math.sqrt(baseFocus.reduce((s, x) => s + (x - m) ** 2, 0) / (baseFocus.length - 1)); })();
  const mde = (sd != null && baseFocus.length) ? +(2.8 * sd / Math.sqrt(baseFocus.length)).toFixed(3) : null;

  return {
    base: { n: baseIdx.size },
    runs: targets.map((t) => ({ dir: t.dir, n: indexById(t.rows).size })),
    metrics, perFixture,
    power: { focusKey, focusLabel: focusMeta?.label || focusKey, nFixtures: baseFocus.length, mde },
  };
}
