/**
 * WeightLossTemplate — DAS V30
 * Evidence: BMI, lifestyle interventions, exercise barriers, medication status.
 */
function getNumeric(graph, ...kws) {
  return (graph.numeric_data || []).find(n => kws.some(kw => (n.test_name || '').toLowerCase().includes(kw))) || null;
}
function getEntities(graph, keywords, types = []) {
  return (graph.clinical_entities || []).filter(e => {
    const text = ((e.display_text || '') + ' ' + (e.canonical_name || '')).toLowerCase();
    return (types.length === 0 || types.includes(e.entity_type)) && keywords.some(kw => text.includes(kw));
  });
}
function markRepresented(entities, tag) {
  entities.forEach(e => { e.represented_by = e.represented_by || []; if (!e.represented_by.includes(tag)) e.represented_by.push(tag); });
}

export class WeightLossTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const follow_ups = [];

    // 1. BMI
    const bmi = getNumeric(graph, 'bmi', 'body mass index');
    const weight = getNumeric(graph, 'weight');
    if (bmi) {
      // Report only the measured value — never append an invented severity class
      // (e.g. "class I obesity") that the clinician did not state in the transcript.
      evidence.push(`BMI ${bmi.value}${bmi.unit ? ` ${bmi.unit}` : ''}.`);
      markRepresented([bmi], 'WEIGHT_TEMPLATE_BMI');
    } else if (weight) {
      evidence.push(`Weight ${weight.value}${weight.unit ? ` ${weight.unit}` : ''}.`);
    }

    // 2. Lifestyle interventions — echo the ACTUAL transcript fact, not canned text.
    const lifestyleEntities = getEntities(graph, ['lifestyle', 'dietitian', 'diet', 'nutrition', 'exercise program', 'gym']);
    if (lifestyleEntities.length > 0) {
      const ls = lifestyleEntities[0].display_text || lifestyleEntities[0].canonical_name;
      if (ls) evidence.push(/[.?!]$/.test(ls) ? ls : `${ls}.`);
      markRepresented(lifestyleEntities, 'WEIGHT_TEMPLATE_LIFESTYLE');
    }

    // 3. Exercise barriers (comorbidities)
    const barrierEntities = getEntities(graph, ['fibromyalgia', 'chronic pain', 'arthritis', 'osteoarthritis', 'limited mobility', 'exercise limited']);
    if (barrierEntities.length > 0) {
      const barrier = barrierEntities[0].display_text || barrierEntities[0].canonical_name || 'chronic pain';
      evidence.push(`Exercise limited by ${barrier}.`);
      markRepresented(barrierEntities, 'WEIGHT_TEMPLATE_BARRIER');
    }

    // 4. Weight loss medications
    const weightMeds = getEntities(graph,
      ['ozempic', 'wegovy', 'saxenda', 'zepbound', 'mounjaro', 'semaglutide', 'tirzepatide', 'liraglutide'],
      ['medication', 'medication_order', 'medication_decision']
    );
    weightMeds.forEach(med => {
      // Skip meds only discussed/compared (not prescribed/continued) — they must never
      // become a treatment line (template A&P "treatment planned" clause).
      const medState = String(med.medication_status || med.med_state || med.status || '').toLowerCase();
      const medAction = String(med.action || '').toLowerCase();
      const isMentionOnly = ['mention', 'mentioned', 'discussed', 'considered', 'compared', 'option', 'proposed', 'deferred'].includes(medState)
        || /\b(discuss|compar|consider|mention|option|propos|defer)/.test(medAction);
      if (isMentionOnly) return;

      const action = (med.action || 'continue').toLowerCase();
      const name = med.medication || med.canonical_name || med.display_text || '';
      const dose = med.dose ? ` ${med.dose}` : '';
      const freq = med.frequency ? ` ${med.frequency}` : '';
      if (action === 'start' || action === 'initiate') {
        treatments_planned.push(`Initiated ${name}${dose}${freq} for weight management.`);
      } else if (action === 'prior_authorization' || action === 'pending') {
        treatments_planned.push(`Prior authorisation submitted for ${name}.`);
      } else {
        treatments_planned.push(`Continue ${name}${dose}${freq}.`);
      }
      markRepresented([med], 'WEIGHT_TEMPLATE_MEDS');
    });

    // 5. Counselling
    if (lifestyleEntities.length > 0 || weightMeds.length > 0) {
      counselling.push('Weight management counselling provided.');
    }

    // 6. Orders (metabolic, lipid panels if extracted)
    const weightOrders = (graph.orders || []).filter(o =>
      /lipid|cholesterol|glucose|a1c|thyroid|tsh|metabolic/i.test(o.test || '')
    );
    weightOrders.forEach(o => investigations_planned.push(`${o.test}.`));

    return { evidence, treatments_planned, counselling, investigations_planned, follow_ups, referrals: [] };
  }
}
