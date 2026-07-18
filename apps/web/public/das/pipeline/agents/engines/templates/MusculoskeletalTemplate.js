/**
 * MusculoskeletalTemplate — DAS V31
 * Handles both: chronic musculoskeletal and acute injury problems.
 *
 * V31 changes:
 *   - Returns new schema keys: narrative, treatment_planned, investigations_planned
 *   - Renders V31 slot-aware fields: aggravating_factors, relieving_factors,
 *     self_treatment_effectiveness, functional_impact, precipitating_activity
 *   - Never adds standard-of-care RICE when not in transcript
 */
function getEntities(graph, keywords, types = []) {
  return (graph.clinical_entities || []).filter(e => {
    const text = ((e.display_text || '') + ' ' + (e.canonical_name || '') + ' ' + (e.source_quote || '')).toLowerCase();
    return (types.length === 0 || types.includes(e.entity_type)) && keywords.some(kw => text.includes(kw));
  });
}
function markRepresented(entities, tag) {
  entities.forEach(e => { e.represented_by = e.represented_by || []; if (!e.represented_by.includes(tag)) e.represented_by.push(tag); });
}

/**
 * renderSymptomSlotLines()
 * Builds V31 slot-aware line fragments from entity's new fields.
 * These are returned as narrative[] entries.
 */
function renderSymptomSlotLines(fact, allFacts) {
  const rendered = [];

  // Slot 3 — Aggravating factors (labeled line)
  if (fact.aggravating_factors?.length) {
    rendered.push(`Aggravating factors: ${fact.aggravating_factors.join(', ')}`);
  }

  // Slot 3 — Relieving factors (labeled line)
  if (fact.relieving_factors?.length) {
    const rfText = fact.relieving_factors
      .map(rf => rf.context ? `${rf.factor} - ${rf.context}` : rf.factor)
      .join('; ');
    rendered.push(`Relieving factors: ${rfText}`);
  }

  // Slot 3 — Self-treatment barrier (verbatim if meaningful)
  if (fact.self_treatment_effectiveness) {
    const eff = fact.self_treatment_effectiveness;
    // Only add if it's a notable barrier (not just "provides relief" already captured)
    if (/wife|smell|intolerant|cannot|unable/i.test(eff)) {
      rendered.push(`Unable to use consistently — ${eff}`);
    }
  }

  // Slot 6 — Functional impact with exact timeframe
  if (fact.functional_impact && fact.functional_limitation_timeframe) {
    const domain = fact.functional_domain || 'activity';
    rendered.push(`Had to stop ${domain} ${fact.functional_limitation_timeframe} due to severity`);
  } else if (fact.functional_impact) {
    rendered.push(fact.functional_impact);
  }

  // Slot 7 — Precipitating activity + no-fall negation
  if (fact.precipitating_activity) {
    const hadFallNegation = allFacts.find(f =>
      f.clinical_role === 'negative_finding' &&
      (f.display_text || '').toLowerCase().includes('fall')
    );
    const text = hadFallNegation
      ? `No fall but has been ${fact.precipitating_activity}`
      : `Onset after ${fact.precipitating_activity}`;
    rendered.push(text);
  }

  return rendered;
}

export class MusculoskeletalTemplate {
  static execute(problem, graph) {
    const narrative = [];
    const treatment_planned = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];
    const counselling = [];

    const entities = graph.clinical_entities || [];
    const allFacts = entities;

    // 1. Injury mechanism / context (adds to narrative)
    const injuryEntities = getEntities(graph, ['fall', 'fell', 'trauma', 'injury', 'twist', 'sprain', 'mechanism', 'moving furniture', 'precipitat']);
    if (injuryEntities.length > 0) {
      const inj = injuryEntities[0];
      const text = inj.display_text || inj.canonical_name || '';
      const onset = inj.onset || inj.temporal_qualifier || '';
      if (text) {
        narrative.push(`${text.charAt(0).toUpperCase() + text.slice(1)}${onset ? ` — ${onset}` : ''}.`);
      }
      markRepresented(injuryEntities.slice(0, 2), 'MSK_TEMPLATE_INJURY');
    }

    // 2. V31 slot-aware lines from symptom entities
    const symptomEntities = entities.filter(e =>
      e.entity_type === 'symptom' &&
      (e.aggravating_factors?.length || e.relieving_factors?.length ||
       e.functional_impact || e.precipitating_activity)
    );
    symptomEntities.forEach(fact => {
      const slotLines = renderSymptomSlotLines(fact, allFacts);
      narrative.push(...slotLines);
      markRepresented([fact], 'MSK_TEMPLATE_SLOT_LINES');
    });

    // 3. Pain characteristics (narrative)
    const painEntities = entities.filter(e =>
      e.entity_type === 'symptom' &&
      /pain|discomfort|ache|tenderness|sore|swelling|tightening|burning/i.test(e.display_text || e.canonical_name || '')
    );
    painEntities.slice(0, 3).forEach(pain => {
      const site = pain.body_site || pain.anatomical_location || pain.body_part || '';
      const lateral = pain.laterality || '';
      const quality = pain.quality_description || pain.quality || '';
      const progression = pain.progression_description || '';
      let parts = [lateral, site, pain.display_text || pain.canonical_name || ''].filter(Boolean);
      let sentence = parts.join(' ');
      if (quality) sentence += `, ${quality}`;
      if (progression) sentence += `; ${progression}`;
      if (sentence) narrative.push(`${sentence.charAt(0).toUpperCase() + sentence.slice(1)}.`);
      markRepresented([pain], 'MSK_TEMPLATE_PAIN');
    });

    // 4. Investigations ordered (X-ray, MRI, ultrasound)
    const imagingOrders = (graph.orders || []).filter(o =>
      /x.ray|xray|mri|ct|ultrasound|scan|bone scan/i.test(o.test || '')
    );
    imagingOrders.forEach(o => {
      // V31: Apply laterality normalization
      let orderText = o.test || '';
      if (o.laterality === 'bilateral') {
        orderText = orderText.replace(/x[-\s]?ray\s+of\s+(?:both\s+)?(?:the\s+)?(\w+)/i, 'X-ray bilateral $1');
        orderText = orderText.replace(/x[-\s]?ray\s+(?:the\s+)?(\w+)\s+(?:bilaterally|both\s+sides)/i, 'X-ray bilateral $1');
      }
      investigations_planned.push(orderText);
    });

    // Also from entities
    const imagingEntities = getEntities(graph, ['x-ray', 'xray', 'mri', 'ct scan', 'ultrasound', 'radiograph'],
      ['investigation', 'order', 'administrative']);
    imagingEntities.forEach(e => {
      const text = e.display_text || e.canonical_name || '';
      if (text && !investigations_planned.some(inv => inv.toLowerCase().includes(text.toLowerCase()))) {
        investigations_planned.push(text.charAt(0).toUpperCase() + text.slice(1));
      }
      markRepresented([e], 'MSK_TEMPLATE_IMAGING');
    });

    // 5. Treatment plan — only from transcript, no standard-of-care defaults
    const treatmentEntities = getEntities(graph,
      ['rest', 'ice', 'elevation', 'physiotherapy', 'physio', 'ibuprofen', 'naproxen', 'nsaid', 'analgesia', 'paracetamol', 'acetaminophen', 'splint', 'brace', 'crutches', 'heat'],
      ['medication', 'medication_order', 'treatment', 'administrative', 'follow_up']
    );
    if (treatmentEntities.length > 0) {
      const treatTexts = treatmentEntities.map(e => e.display_text || e.canonical_name || '').filter(Boolean);
      treatment_planned.push(...treatTexts);
      markRepresented(treatmentEntities, 'MSK_TEMPLATE_TREATMENT');
    }
    // V31: Do NOT add "Rest, ice, compression, elevation" if not in transcript

    // 6. Referrals — only from transcript
    const orthoReferrals = getEntities(graph, ['orthopaedic', 'orthopedic', 'physiotherapy', 'physio', 'rheumatology', 'sports medicine'],
      ['referral', 'administrative', 'follow_up']);
    orthoReferrals.forEach(r => {
      const text = r.display_text || r.canonical_name || '';
      if (text) referrals.push(`${text.charAt(0).toUpperCase() + text.slice(1)}.`);
      markRepresented([r], 'MSK_TEMPLATE_REFERRAL');
    });

    // 7. Follow-up
    const followUpEntities = getEntities(graph, ['follow.up', 'review', 'return'], ['follow_up', 'administrative']);
    followUpEntities.forEach(f => {
      follow_ups.push(f.display_text || f.canonical_name || 'Follow-up as required');
      markRepresented([f], 'MSK_TEMPLATE_FOLLOWUP');
    });

    // V31: return new schema keys (backwards-compatible aliases included)
    return {
      narrative,
      evidence: narrative,          // backwards compat
      treatment_planned,
      treatments_planned: treatment_planned, // backwards compat
      investigations_planned,
      referrals,
      follow_up: follow_ups,
      follow_ups,                   // backwards compat
      counselling,
    };
  }
}
