// ─────────────────────────────────────────────────────────────────────────────
// Metric Registry (Metrics v2 · P0) — the single source of truth that turns flat
// metric keys into TYPED definitions: polarity (higher/lower better), unit, family,
// system (notera/heidi), severity, gate status. Everything downstream — delta
// colouring, axis splitting, faceting, gates — derives from this.
//
// Two sources of keys:
//   • fixed pipeline metrics from eval/metrics.mjs (section_coverage, similarity_to_gold,
//     omission_rate, story_flow, schema_valid, med_grounding, meds_unsupported, …)
//   • dynamic judge metrics `qa_*` (e.g. "qa_metric_2_structure_heidi_duplicated_content")
//     — parsed tolerantly into {group, family, system, sub}.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// polarity: which direction is GOOD.  unit: how to render / which axis.
// family: metric-group grouping for small-multiples + faceting.
const FIXED = {
  section_coverage:   { label: 'Coverage',        unit: 'score01', polarity: 'higher_better', family: 'equivalence',  severity: 'major',    isGate: true,  gateThreshold: 0.8, gateDirection: '>=', description: 'Share of required SOAP sections present.' },
  similarity_to_gold: { label: 'Similarity',      unit: 'score01', polarity: 'higher_better', family: 'equivalence',  severity: 'minor',    description: 'Token overlap with the gold note.' },
  omission_rate:      { label: 'Omission',        unit: 'score01', polarity: 'lower_better',  family: 'missing_info', severity: 'major',    description: 'Fraction of gold terms missing from the note (lower is better).' },
  story_flow:         { label: 'Story flow',      unit: 'score01', polarity: 'higher_better', family: 'story_flow',   severity: 'minor',    description: 'Coherent prose vs disjoint fragments.' },
  schema_valid:       { label: 'Schema valid',    unit: 'bool',    polarity: 'higher_better', family: 'structure',    severity: 'critical', isGate: true,  gateThreshold: 1, gateDirection: '>=', description: 'Note validates against the fixed schema.' },
  schema_errors:      { label: 'Schema errors',   unit: 'count',   polarity: 'lower_better',  family: 'structure',    severity: 'major',    description: 'Count of schema validation errors.' },
  med_grounding:      { label: 'Med grounding',   unit: 'score01', polarity: 'higher_better', family: 'quality',      severity: 'critical', description: 'Share of medications resolvable to a real concept.' },
  meds_unsupported:   { label: 'Unsupported meds',unit: 'count',   polarity: 'lower_better',  family: 'quality',      severity: 'critical', description: 'Medications in the note not supported by the transcript (fabrication risk).' },
  meds_checked:       { label: 'Meds checked',    unit: 'count',   polarity: 'target',        family: 'quality',      severity: 'minor',    description: 'Number of medications cross-checked.' },
  hallucinations_removed: { label: 'Hallucinations removed', unit: 'count', polarity: 'target', family: 'quality',   severity: 'major',    description: 'Spans the hallucination-remover deleted (diagnostic, not a score).' },
};

// aggregate history keys are the fixed keys prefixed with avg_ / total_ / rate names.
const AGG_ALIAS = {
  schema_validity: 'schema_valid',
  avg_section_coverage: 'section_coverage',
  avg_similarity_to_gold: 'similarity_to_gold',
  avg_omission_rate: 'omission_rate',
  avg_story_flow: 'story_flow',
  total_unsupported_meds: 'meds_unsupported',
};

const humanize = (s) => String(s || '').replace(/^qa[_ ]?/i, '').replace(/[_.]+/g, ' ').replace(/\bmetric (\d)\b/i, 'M$1').trim().replace(/\b\w/g, (c) => c.toUpperCase());

// negative-sense tokens ⇒ lower is better (a fabrication/duplication/omission count).
const NEG_SENSE = /(duplicat|fabricat|hallucin|omission|missing|error|contradict|unsupported|extra|leak|repetit|incorrect|wrong|absent|violation|drift)/i;
const CRITICAL = /(fabricat|hallucin|safety|contradict|wrong dose|allerg)/i;

// families we recognise in a qa key
function familyFrom(s) {
  if (/structur|format|section|heading/i.test(s)) return 'structure';
  if (/equivalen|coverage|similar|match|faithful|accuracy/i.test(s)) return 'equivalence';
  if (/missing|omission|recall|completeness/i.test(s)) return 'missing_info';
  if (/story|flow|coheren|narrative|readab|clarity/i.test(s)) return 'story_flow';
  if (/quality|fabricat|hallucin|safety|ground|med/i.test(s)) return 'quality';
  return 'quality';
}

/** Parse ANY metric key into a typed MetricDef. Never throws. */
export function describeMetric(rawKey) {
  const key = String(rawKey || '').trim();
  const canon = AGG_ALIAS[key] || key.replace(/^avg_/, '');
  if (FIXED[canon]) {
    return { key, canonicalKey: canon, judge: 'code', system: null, metricGroup: null, aggregation: FIXED[canon].unit === 'count' ? 'sum' : 'mean', range: FIXED[canon].unit === 'score01' ? [0, 1] : null, isGate: false, ...FIXED[canon] };
  }
  // dynamic qa_* (or unknown) key
  const isQa = /^qa[_ ]/i.test(key);
  const body = key.replace(/^qa[_ ]?/i, '');
  const system = /heidi/i.test(body) ? 'heidi' : /notera/i.test(body) ? 'notera' : null;
  const groupM = body.match(/metric[_ ]?(\d)/i) || body.match(/\bm(\d)\b/i);
  const metricGroup = groupM ? Number(groupM[1]) : null;
  const family = familyFrom(body);
  const polarity = NEG_SENSE.test(body) ? 'lower_better' : 'higher_better';
  const severity = CRITICAL.test(body) ? 'critical' : NEG_SENSE.test(body) ? 'major' : 'minor';
  // qa scores are usually 0..5 rubric points; counts if the sub says count/duplicated etc.
  const unit = /count|number|num_|duplicat|_n$/i.test(body) ? 'count' : 'score01';
  return {
    key, canonicalKey: key, label: humanize(body) || key, judge: isQa ? 'qa' : 'code',
    metricGroup, family, system, unit, polarity, range: unit === 'score01' ? [0, 5] : null,
    aggregation: unit === 'count' ? 'sum' : 'mean', isGate: false, severity,
    description: isQa ? 'Judge (QA) metric — parsed from the flat key.' : 'Metric.',
  };
}

/** Is a delta an improvement for this metric? (polarity-aware — fixes the "lying arrow" bug.) */
export function isImprovement(delta, key) {
  if (!delta) return null;                       // exactly 0 → no change
  const pol = describeMetric(key).polarity;
  if (pol === 'higher_better') return delta > 0;
  if (pol === 'lower_better') return delta < 0;
  return null;                                    // target/neutral → no good/bad
}

/** Extract the numeric value of a metric key from a per-fixture result row. */
export function valueFromRow(row, key) {
  if (!row) return null;
  const canon = AGG_ALIAS[key] || key;
  // booleans → 1/0; arrays (meds_unsupported/missing_sections) → their length
  const raw = row[canon] !== undefined ? row[canon] : row[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'number') return raw;
  return null;
}

/** Which metric keys are present (numeric) across a set of result rows. */
export function metricKeysInRows(rows) {
  const keys = new Set();
  for (const r of rows || []) for (const k of Object.keys(r)) {
    if (['id', 'status', 'missing_sections', 'omission_missed', 'meds_unsupported', 'schema_errors'].includes(k)) { if (k === 'meds_unsupported' || k === 'schema_errors') keys.add(k); continue; }
    const v = valueFromRow(r, k);
    if (typeof v === 'number' && Number.isFinite(v)) keys.add(k);
  }
  // always surface the core five if any row has them
  return [...keys];
}

export const FAMILIES = ['equivalence', 'structure', 'missing_info', 'quality', 'story_flow'];
export const HEADLINE_KEYS = ['section_coverage', 'similarity_to_gold', 'story_flow', 'omission_rate', 'schema_valid'];
