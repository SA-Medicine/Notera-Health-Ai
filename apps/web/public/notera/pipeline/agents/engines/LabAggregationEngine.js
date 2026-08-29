/**
 * LabAggregationEngine — DAS V25
 *
 * Groups repeated numeric fact entries for the same lab/vital into a single
 * aggregated trend object with a human-readable trend_narrative.
 *
 * Prevents duplicate lab lines in the note (e.g. "Hb 87" and "Hb 88"
 * becoming "Hemoglobin 88 (previously 87, normal 120)").
 *
 * Sets entity.represented_by = ["LAB_{KEY}_TREND"] for StoryCoverageValidator.
 *
 * Runs on: graph.numeric_data[]
 */

// Canonical name → normalised key mapping
const LAB_CANONICAL_KEYS = {
  hemoglobin: 'HB', hb: 'HB', haemoglobin: 'HB',
  'a1c': 'A1C', 'hba1c': 'A1C', 'glycated hemoglobin': 'A1C', 'glycated haemoglobin': 'A1C',
  ldl: 'LDL', 'ldl cholesterol': 'LDL',
  hdl: 'HDL', 'hdl cholesterol': 'HDL',
  ferritin: 'FERRITIN',
  iron: 'IRON', 'serum iron': 'IRON',
  wbc: 'WBC', 'white blood cell': 'WBC', 'white blood cells': 'WBC',
  platelets: 'PLATELETS',
  tsh: 'TSH', 'thyroid stimulating hormone': 'TSH',
  egfr: 'EGFR', 'estimated gfr': 'EGFR', 'glomerular filtration rate': 'EGFR',
  bmi: 'BMI', 'body mass index': 'BMI',
  weight: 'WEIGHT',
  bp: 'BP', 'blood pressure': 'BP', 'systolic': 'BP',
  glucose: 'GLUCOSE', 'fasting glucose': 'GLUCOSE', 'blood glucose': 'GLUCOSE',
  creatinine: 'CREATININE',
  sodium: 'SODIUM', potassium: 'POTASSIUM',
  triglycerides: 'TRIGLYCERIDES',
  'total cholesterol': 'CHOLESTEROL',
};

function getCanonicalKey(testName) {
  if (!testName) return null;
  const lower = testName.toLowerCase().trim();
  for (const [pattern, key] of Object.entries(LAB_CANONICAL_KEYS)) {
    if (lower.includes(pattern)) return key;
  }
  return null;
}

function parseTrend(current, previous) {
  if (previous == null) return 'stable';
  const cur = parseFloat(current);
  const prev = parseFloat(previous);
  if (isNaN(cur) || isNaN(prev)) return 'stable';
  if (cur > prev * 1.05) return 'rising';
  if (cur < prev * 0.95) return 'falling';
  return 'stable';
}

function buildTrendNarrative(label, current, previous, normal, unit) {
  let narrative = `${label} ${current}`;
  if (unit) narrative += ` ${unit}`;
  if (previous != null && String(previous) !== String(current)) {
    narrative += ` (previously ${previous})`;
  }
  if (normal != null) {
    narrative += `, normal ${normal}`;
    if (unit) narrative += ` ${unit}`;
  }
  return narrative;
}

export class LabAggregationEngine {
  static execute(graph) {
    const numerics = graph.numeric_data || [];
    if (!numerics.length) return graph;

    // Group by canonical key
    const groups = {};
    const ungrouped = [];

    numerics.forEach(n => {
      const key = getCanonicalKey(n.test_name);
      if (key) {
        if (!groups[key]) groups[key] = [];
        groups[key].push(n);
      } else {
        ungrouped.push(n);
      }
    });

    const aggregated = [...ungrouped];

    for (const [key, entries] of Object.entries(groups)) {
      if (entries.length === 1) {
        // Single entry — still mark represented_by
        const e = entries[0];
        e.represented_by = e.represented_by || [];
        e.represented_by.push(`LAB_${key}_TREND`);
        aggregated.push(e);
        continue;
      }

      // Sort entries: prefer most recent (by observation_date if present)
      entries.sort((a, b) => {
        if (a.observation_date && b.observation_date) {
          return new Date(b.observation_date) - new Date(a.observation_date);
        }
        return 0;
      });

      const primary = entries[0];
      const previousEntries = entries.slice(1);
      const previousValue = previousEntries[0]?.value ?? null;
      const normalValue = entries.find(e => e.normal_range || e.normal_value)?.normal_value ?? null;

      const trend = parseTrend(primary.value, previousValue);
      const label = primary.test_name || key;
      const trendNarrative = buildTrendNarrative(label, primary.value, previousValue, normalValue, primary.unit);

      // Build aggregated entry
      const aggregatedEntry = {
        ...primary,
        trend,
        trend_narrative: trendNarrative,
        previous_value: previousValue,
        normal_value: normalValue,
        aggregated_from: entries.map(e => e.id || e.value),
        represented_by: [`LAB_${key}_TREND`],
      };

      // Mark old entries as aggregated so renderer skips them
      previousEntries.forEach(e => {
        e.render_status = 'aggregated';
        e.represented_by = e.represented_by || [];
        e.represented_by.push(`LAB_${key}_TREND`);
      });

      aggregated.push(aggregatedEntry);
    }

    graph.numeric_data = aggregated;
    return graph;
  }
}
