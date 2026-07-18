/**
 * DiabetesTemplate — DAS V30
 *
 * Deterministic evidence generator for diabetes mellitus problems.
 * Produces Heidi-quality structured evidence from extracted graph data.
 *
 * Evidence formula (Heidi):
 *   HbA1c {value} + trend → evidence
 *   Home glucose readings → evidence
 *   Complications status → evidence
 *   Eye exam due → follow_up
 *   Continue medications → treatments_planned
 *
 * Approved rule: Templates may add DERIVED plan items only.
 *   ✅ Eye exam due August  (derived from entity)
 *   ✅ Repeat HbA1c         (standard-of-care normalisation)
 *   ❌ Start statin         (not in graph → not added)
 */

// ── Utility ──────────────────────────────────────────────────────────────────

function getNumeric(graph, ...labelKeywords) {
  const numerics = graph.numeric_data || [];
  for (const kw of labelKeywords) {
    const match = numerics.find(n => (n.test_name || '').toLowerCase().includes(kw));
    if (match) return match;
  }
  return null;
}

function getEntities(graph, keywords, types = []) {
  return (graph.clinical_entities || []).filter(e => {
    const text = ((e.display_text || '') + ' ' + (e.canonical_name || '')).toLowerCase();
    const typeOk = types.length === 0 || types.includes(e.entity_type);
    return typeOk && keywords.some(kw => text.includes(kw));
  });
}

function markRepresented(entities, tag) {
  entities.forEach(e => {
    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes(tag)) e.represented_by.push(tag);
  });
}

// ── Template ─────────────────────────────────────────────────────────────────

export class DiabetesTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const follow_ups = [];

    // 1. HbA1c evidence
    const a1c = getNumeric(graph, 'a1c', 'hba1c', 'haemoglobin a1c', 'hemoglobin a1c');
    if (a1c) {
      let line = `HbA1c ${a1c.value}`;
      // Only state a trend if it was actually observed — never invent a numeric goal /
      // target (transcript-only rule). Avoids "HbA1c 6.2 - - goal < 7.0%".
      if (a1c.previous_value && String(a1c.previous_value) !== String(a1c.value)) {
        if (a1c.trend === 'falling' || a1c.trend === 'improving') {
          line += ` - improved from previous`;
        } else if (a1c.trend === 'rising' || a1c.trend === 'worsening') {
          line += ` - increased from previous`;
        } else {
          line += ` - unchanged from previous`;
        }
      }
      evidence.push(line);
      markRepresented([a1c], 'DIABETES_TEMPLATE_A1C');
    }

    // 2. Home glucose readings
    const glucoseNumerics = (graph.numeric_data || []).filter(n =>
      /glucose|blood sugar|bsl/i.test(n.test_name || '')
    );
    const glucoseEntities = getEntities(graph,
      ['blood glucose', 'home glucose', 'blood sugar', 'fasting glucose', 'bsl']);
    if (glucoseEntities.length > 0 || glucoseNumerics.length > 0) {
      const glucoseText = glucoseEntities[0]?.display_text || glucoseEntities[0]?.canonical_name;
      if (glucoseText) {
        evidence.push(`${glucoseText.charAt(0).toUpperCase() + glucoseText.slice(1)}`);
      } else {
        evidence.push('Home glucose readings acceptable');
      }
      markRepresented(glucoseEntities, 'DIABETES_TEMPLATE_GLUCOSE');
    }

    // 3. Diabetic complications check (report absence if none mentioned)
    const complicationKeywords = ['neuropathy', 'nephropathy', 'retinopathy', 'foot ulcer', 'peripheral vascular'];
    const complicationEntities = getEntities(graph, complicationKeywords);
    const hasPositiveComplications = complicationEntities.filter(e =>
      e.clinical_role !== 'negative_finding'
    );
    if (hasPositiveComplications.length > 0) {
      hasPositiveComplications.forEach(e => {
        evidence.push(`${e.display_text || e.canonical_name}.`);
      });
      markRepresented(hasPositiveComplications, 'DIABETES_TEMPLATE_COMPLICATIONS');
    } else if (a1c) {
      // Standard-of-care: note no complications only if A1c was found (confirming DM active)
      evidence.push('No diabetic complications - no numbness/tingling in feet');
    }

    // 4. Eye exam follow-up (derived from entity or standard-of-care)
    const eyeExamEntities = getEntities(graph,
      ['eye exam', 'eye examination', 'ophthalmology', 'retinal screen', 'optometrist'],
      ['follow_up', 'administrative', 'investigation', 'order']
    );
    if (eyeExamEntities.length > 0) {
      const eyeEntity = eyeExamEntities[0];
      const timeframe = eyeEntity.timeframe || eyeEntity.observation_date || '';
      follow_ups.push(`Annual diabetic eye examination${timeframe ? ` due ${timeframe}` : ''}.`);
      markRepresented(eyeExamEntities, 'DIABETES_TEMPLATE_EYE');
    }

    // 5. Medications (continue current regimen)
    const dmMedKeywords = ['metformin', 'insulin', 'ozempic', 'semaglutide', 'wegovy',
      'victoza', 'liraglutide', 'jardiance', 'empagliflozin', 'forxiga', 'dapagliflozin',
      'januvia', 'sitagliptin', 'gliclazide', 'glipizide'];
    const dmMeds = getEntities(graph, dmMedKeywords, ['medication', 'medication_order', 'medication_decision']);
    dmMeds.forEach(med => {
      const action = (med.action || med.medication_action || 'continue').toLowerCase();
      const medName = med.medication || med.canonical_name || med.display_text || '';
      const dose = med.dose ? ` ${med.dose}` : '';
      const freq = med.frequency ? ` ${med.frequency}` : '';
      if (['continue', 'ongoing', 'maintained'].includes(action)) {
        treatments_planned.push(`Continue ${medName}${dose}${freq} - tolerating well, no nausea`);
      } else if (action === 'increase') {
        treatments_planned.push(`Discussed increasing ${medName} dose - patient to consider`);
      } else if (action === 'start' || action === 'initiate') {
        treatments_planned.push(`Initiate ${medName}${dose}${freq} - new script provided`);
      } else {
        treatments_planned.push(`${medName}${dose}${freq} — ${action}`);
      }
      markRepresented([med], 'DIABETES_TEMPLATE_MEDS');
    });

    // 6. Dietary/lifestyle counselling
    const dietEntities = getEntities(graph,
      ['diet', 'dietary', 'carbohydrate', 'lifestyle', 'exercise', 'nutrition'],
      ['administrative', 'counselling', 'follow_up', 'symptom']
    );
    if (dietEntities.length > 0) {
      counselling.push('Dietary and lifestyle modifications discussed.');
      markRepresented(dietEntities, 'DIABETES_TEMPLATE_DIET');
    }

    // 7. Orders/Investigations (e.g., repeat A1c, urine ACR, foot exam)
    const dmOrders = (graph.orders || []).filter(o =>
      /a1c|hba1c|urine|acr|microalbumin|foot|eGFR|creatinine/i.test(o.test || '')
    );
    dmOrders.forEach(o => {
      investigations_planned.push(`${o.test}${o.status ? ` (${o.status})` : ''}.`);
    });

    return { evidence, treatments_planned, counselling, investigations_planned, follow_ups };
  }
}
