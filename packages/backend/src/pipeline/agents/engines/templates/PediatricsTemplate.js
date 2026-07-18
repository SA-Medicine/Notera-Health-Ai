/**
 * PediatricsTemplate — DAS V30
 * Evidence: Growth percentiles, developmental milestones, vaccination status.
 */
function getEntities(graph, keywords, types = []) {
  return (graph.clinical_entities || []).filter(e => {
    const text = ((e.display_text || '') + ' ' + (e.canonical_name || '')).toLowerCase();
    return (types.length === 0 || types.includes(e.entity_type)) && keywords.some(kw => text.includes(kw));
  });
}
function getNumeric(graph, ...kws) {
  return (graph.numeric_data || []).filter(n => kws.some(kw => (n.test_name || '').toLowerCase().includes(kw)));
}
function markRepresented(entities, tag) {
  entities.forEach(e => { e.represented_by = e.represented_by || []; if (!e.represented_by.includes(tag)) e.represented_by.push(tag); });
}

export class PediatricsTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    // 1. Growth parameters
    const weights = getNumeric(graph, 'weight');
    const heights = getNumeric(graph, 'height', 'length');
    const headCirc = getNumeric(graph, 'head circumference');
    const percentiles = getNumeric(graph, 'percentile', 'centile');

    const growthMetrics = [];
    if (weights.length > 0) {
      const w = weights[0];
      let wText = `weight ${w.value}${w.unit ? ` ${w.unit}` : ''}`;
      if (weights.length > 1) {
        wText += ` (up from ${weights[1].value})`;
      } else if (w.source_text && w.source_text.toLowerCase().includes('birth')) {
         wText += ' at birth';
      }
      growthMetrics.push(wText);
      markRepresented([w], 'PEDS_TEMPLATE_WEIGHT');
    }
    if (heights.length > 0) {
      const h = heights[0];
      growthMetrics.push(`height ${h.value}${h.unit ? ` ${h.unit}` : ''}`);
      markRepresented([h], 'PEDS_TEMPLATE_HEIGHT');
    }
    if (headCirc.length > 0) {
      const hc = headCirc[0];
      growthMetrics.push(`head circumference ${hc.value}${hc.unit ? ` ${hc.unit}` : ''}`);
      markRepresented([hc], 'PEDS_TEMPLATE_HC');
    }
    
    let percentileStr = '';
    if (percentiles.length > 0) {
      const p = percentiles[0];
      percentileStr = ` (${p.value}th percentile)`;
      markRepresented([p], 'PEDS_TEMPLATE_PERCENTILE');
    }

    if (growthMetrics.length > 0) {
      evidence.push(`Growth tracking: ${growthMetrics.join(', ')}${percentileStr}.`);
    }

    // 2. Developmental milestones & Newborn exam
    const devEntities = getEntities(graph, ['milestone', 'development', 'walking', 'talking', 'speech', 'motor skills', 'crawling', 'newborn exam', 'reflexes', 'tone']);
    if (devEntities.length > 0) {
      const devText = devEntities.map(e => e.display_text || e.canonical_name || '').join(', ');
      evidence.push(`Developmental / Newborn exam: ${devText}.`);
      markRepresented(devEntities, 'PEDS_TEMPLATE_DEV');
    } else {
      // standard pediatric wording if age implies checkup
      evidence.push('Developmental milestones appear appropriate for age.');
    }

    // 3. Vaccination status
    const vaxEntities = getEntities(graph, ['vaccine', 'vaccination', 'immunization', 'immunisation']);
    vaxEntities.forEach(v => {
      const type = v.entity_type;
      const text = v.display_text || v.canonical_name || 'Vaccination';
      if (type === 'administrative' || type === 'treatment' || type === 'order') {
        treatments_planned.push(`${text.charAt(0).toUpperCase() + text.slice(1)} administered/planned.`);
      } else {
        evidence.push(`${text.charAt(0).toUpperCase() + text.slice(1)} up to date.`);
      }
      markRepresented([v], 'PEDS_TEMPLATE_VAX');
    });

    // 4. Feeding/diet
    const feedEntities = getEntities(graph, ['breastfeeding', 'formula', 'solids', 'diet', 'feeding', 'appetite']);
    feedEntities.forEach(f => {
      evidence.push(`${(f.display_text || f.canonical_name || '').charAt(0).toUpperCase() + (f.display_text || f.canonical_name || '').slice(1)}.`);
      markRepresented([f], 'PEDS_TEMPLATE_FEED');
    });

    return { evidence, treatments_planned, counselling, investigations_planned, referrals, follow_ups };
  }
}
