/**
 * GenericTemplate — DAS V30
 * Fallback for problems that don't match a specific disease template.
 * Renders any entities explicitly linked to this problem via entity_ids.
 */
function markRepresented(entities, tag) {
  entities.forEach(e => { e.represented_by = e.represented_by || []; if (!e.represented_by.includes(tag)) e.represented_by.push(tag); });
}

export class GenericTemplate {
  static execute(problem, graph) {
    const narrative = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    const entities = graph.clinical_entities || [];
    const problemIds = new Set([
      ...(problem.entity_ids || []),
      ...(problem.symptom_ids || []),
      ...(problem.exam_ids || []),
      ...(problem.investigation_ids || []),
      ...(problem.medication_ids || []),
      ...(problem.treatment_ids || []),
      ...(problem.treatment_instruction_ids || []),
      ...(problem.referral_ids || []),
      ...(problem.followup_ids || [])
    ]);

    const linkedEntities = entities.filter(e => problemIds.has(e.id));

    linkedEntities.forEach(e => {
      const text = e.display_text || e.canonical_name || '';
      if (!text) return;

      const sentence = text.charAt(0).toUpperCase() + text.slice(1) + '.';
      
      switch (e.entity_type) {
        case 'symptom':
        case 'physical_exam':
        case 'lab_result':
        case 'investigation':
        case 'diagnosis':
          narrative.push(sentence);
          markRepresented([e], 'GENERIC_TEMPLATE_EVIDENCE');
          break;
        case 'medication':
        case 'medication_order':
        case 'medication_decision':
        case 'treatment':
        case 'procedure_history':
        case 'treatment_instruction':
          treatments_planned.push(sentence);
          markRepresented([e], 'GENERIC_TEMPLATE_TREATMENT');
          break;
        case 'referral':
          referrals.push(sentence);
          markRepresented([e], 'GENERIC_TEMPLATE_REFERRAL');
          break;
        case 'follow_up':
        case 'administrative_action':
          follow_ups.push(sentence);
          markRepresented([e], 'GENERIC_TEMPLATE_FOLLOWUP');
          break;
        case 'counselling':
          counselling.push(sentence);
          markRepresented([e], 'GENERIC_TEMPLATE_COUNSELLING');
          break;
        default:
          narrative.push(sentence);
          markRepresented([e], 'GENERIC_TEMPLATE_OTHER');
          break;
      }
    });

    return { narrative, evidence: narrative, treatments_planned, counselling, investigations_planned, referrals, follow_ups };
  }
}
