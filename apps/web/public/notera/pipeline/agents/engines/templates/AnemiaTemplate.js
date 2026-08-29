/**
 * AnemiaTemplate — DAS V30
 *
 * Evidence: Hb value + trend + reference range, ferritin, iron deficiency.
 * Plan: supplementation, transfusion if extracted, referral if extracted.
 */

function getNumeric(graph, ...kws) {
  const numerics = graph.numeric_data || [];
  for (const kw of kws) {
    const m = numerics.find(n => (n.test_name || '').toLowerCase().includes(kw));
    if (m) return m;
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
  entities.forEach(e => { e.represented_by = e.represented_by || []; if (!e.represented_by.includes(tag)) e.represented_by.push(tag); });
}

export class AnemiaTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    // 1. Haemoglobin
    const hb = getNumeric(graph, 'haemoglobin', 'hemoglobin', 'hgb', 'hb');
    if (hb) {
      let line = `Haemoglobin ${hb.value}${hb.unit ? ` ${hb.unit}` : ''}`;
      if (hb.previous_value && String(hb.previous_value) !== String(hb.value)) {
        line += ` (previously ${hb.previous_value}${hb.unit ? ` ${hb.unit}` : ''})`;
      }
      line += '.';
      evidence.push(line);
      markRepresented([hb], 'ANEMIA_TEMPLATE_HB');
    }

    // 2. Ferritin
    const ferritin = getNumeric(graph, 'ferritin');
    if (ferritin) {
      evidence.push(`Ferritin ${ferritin.value}${ferritin.unit ? ` ${ferritin.unit}` : ''}.`);
      markRepresented([ferritin], 'ANEMIA_TEMPLATE_FERRITIN');
    }

    // 3. Iron deficiency characterisation
    const ironDefEntities = getEntities(graph, ['iron deficiency', 'iron-deficiency', 'iron supplementation', 'supplementation']);
    if (ironDefEntities.length > 0) {
      const supplementing = getEntities(graph, ['supplementation', 'iron supplement'], ['medication', 'medication_order']);
      if (supplementing.length > 0) {
        evidence.push('Persistent iron deficiency despite supplementation.');
      } else {
        evidence.push('Iron deficiency identified.');
      }
      markRepresented(ironDefEntities, 'ANEMIA_TEMPLATE_IRON');
    }

    // 4. Referrals (hematology if extracted)
    const hemaReferral = getEntities(graph, ['hematology', 'haematology', 'haematologist', 'hematologist'], ['referral', 'administrative', 'follow_up']);
    if (hemaReferral.length > 0) {
      evidence.push('Awaiting haematology assessment.');
      referrals.push('Haematology referral.');
      markRepresented(hemaReferral, 'ANEMIA_TEMPLATE_REFERRAL');
    }

    // 5. Current medications
    const ironMeds = getEntities(graph, ['ferrous', 'iron', 'folic acid', 'b12', 'vitamin b12', 'cyanocobalamin'], ['medication', 'medication_order']);
    ironMeds.forEach(med => {
      const name = med.medication || med.canonical_name || med.display_text || '';
      const dose = med.dose ? ` ${med.dose}` : '';
      const freq = med.frequency ? ` ${med.frequency}` : '';
      treatments_planned.push(`Continue ${name}${dose}${freq}.`);
      markRepresented([med], 'ANEMIA_TEMPLATE_MEDS');
    });

    // 6. Orders
    const anemiaOrders = (graph.orders || []).filter(o =>
      /hb|haemoglobin|hemoglobin|ferritin|iron|b12|folate|cbc|full blood/i.test(o.test || '')
    );
    anemiaOrders.forEach(o => investigations_planned.push(`${o.test}.`));

    return { evidence, treatments_planned, investigations_planned, referrals, follow_ups, counselling: [] };
  }
}
