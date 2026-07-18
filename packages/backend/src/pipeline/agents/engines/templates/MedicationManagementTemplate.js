/**
 * MedicationManagementTemplate — DAS V30
 * Used for generic medication refill or review encounters.
 * Evidence: medication refill requests, tolerance, absence of adverse effects.
 */
function getEntities(graph, keywords, types = []) {
  return (graph.clinical_entities || []).filter(e => {
    const text = ((e.display_text || '') + ' ' + (e.canonical_name || '')).toLowerCase();
    return (types.length === 0 || types.includes(e.entity_type)) && keywords.some(kw => text.includes(kw));
  });
}
function markRepresented(entities, tag) {
  entities.forEach(e => { e.represented_by = e.represented_by || []; if (!e.represented_by.includes(tag)) e.represented_by.push(tag); });
}

export class MedicationManagementTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    const isAdminRefill = graph.encounter_type === 'medication_refill_administrative';

    // 1. Refill requests / review context
    const reviewEntities = getEntities(graph, ['refill', 'renewal', 'script', 'prescription', 'medication review']);
    if (reviewEntities.length > 0) {
      const texts = reviewEntities.map(e => e.display_text || e.canonical_name || '').filter(Boolean);
      if (!isAdminRefill) evidence.push(`Medication review / refill requested for: ${texts.join(', ')}.`);
      markRepresented(reviewEntities, 'MED_MGT_TEMPLATE_REVIEW');
    }

    // 2. Side effects / tolerance
    const seEntities = getEntities(graph, ['side effect', 'adverse', 'tolerance', 'tolerating']);
    if (seEntities.length > 0) {
      seEntities.forEach(se => {
        evidence.push(`${(se.display_text || se.canonical_name || '').charAt(0).toUpperCase() + (se.display_text || se.canonical_name || '').slice(1)}.`);
        markRepresented([se], 'MED_MGT_TEMPLATE_SE');
      });
    }

    // 3. Medications (grab medications associated with this problem's semantic group)
    const group = problem.semantic_group || 'GENERAL';
    const meds = (graph.clinical_entities || []).filter(e =>
      (e.entity_type === 'medication' || e.entity_type === 'medication_order' || e.entity_type === 'medication_decision') &&
      (e.semantic_group === group || group === 'GENERAL')
    );
    
    meds.forEach(med => {
      const name = med.medication || med.canonical_name || med.display_text || '';
      const dose = med.dose ? ` ${med.dose}` : '';
      const freq = med.frequency ? ` ${med.frequency}` : '';
      const action = (med.action || 'continue').toLowerCase();
      
      if (action === 'continue' || action === 'ongoing') {
        treatments_planned.push(`Continue ${name}${dose}${freq}.`);
      } else if (action === 'increase') {
        treatments_planned.push(`${name} dose increased to${dose}.`);
      } else if (action === 'start' || action === 'initiate') {
        treatments_planned.push(`Initiated ${name}${dose}${freq}.`);
      } else {
        treatments_planned.push(`${name}${dose}${freq} — ${action}.`);
      }
      markRepresented([med], 'MED_MGT_TEMPLATE_MEDS');
    });

    return { evidence, treatments_planned, counselling, investigations_planned, referrals, follow_ups };
  }
}
