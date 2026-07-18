/**
 * DermatologyTemplate — DAS V30
 * Evidence: biologic therapy control, topical agents for flares, skin findings.
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

export class DermatologyTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    // 1. Condition control status
    const controlEntities = getEntities(graph, ['controlled', 'well-controlled', 'stable', 'clear', 'cleared', 'improved']);
    const uncontrolledEntities = getEntities(graph, ['uncontrolled', 'flare', 'flaring', 'worsening', 'active disease']);
    if (controlEntities.length > 0) {
      evidence.push('Condition currently well controlled.');
      markRepresented(controlEntities, 'DERM_TEMPLATE_CONTROL');
    } else if (uncontrolledEntities.length > 0) {
      evidence.push('Condition currently flaring.');
      markRepresented(uncontrolledEntities, 'DERM_TEMPLATE_FLARE');
    }

    // 2. Biologic therapy
    const BIOLOGICS = ['ilumya', 'tildrakizumab', 'humira', 'adalimumab', 'cosentyx', 'secukinumab',
      'tremfya', 'guselkumab', 'skyrizi', 'risankizumab', 'taltz', 'ixekizumab',
      'dupixent', 'dupilumab', 'stelara', 'ustekinumab'];
    const biologicMeds = getEntities(graph, BIOLOGICS, ['medication', 'medication_order', 'medication_decision']);
    biologicMeds.forEach(med => {
      const name = med.medication || med.canonical_name || med.display_text || '';
      const action = (med.action || 'continue').toLowerCase();
      if (action === 'continue' || action === 'maintained' || action === 'ongoing') {
        treatments_planned.push(`Continue ${name} — condition well controlled.`);
      } else {
        treatments_planned.push(`${name} — ${action}.`);
      }
      markRepresented([med], 'DERM_TEMPLATE_BIOLOGIC');
    });

    // 3. Topical treatments for flares
    const TOPICALS = ['topical', 'betamethasone', 'triamcinolone', 'hydrocortisone', 'mometasone', 'clobetasol', 'tacrolimus', 'pimecrolimus'];
    const topicalMeds = getEntities(graph, TOPICALS, ['medication', 'medication_order']);
    topicalMeds.forEach(med => {
      const name = med.medication || med.canonical_name || med.display_text || '';
      treatments_planned.push(`${name} for flares as required.`);
      markRepresented([med], 'DERM_TEMPLATE_TOPICAL');
    });

    // 4. Skin findings from exam
    const skinExam = getEntities(graph, ['plaques', 'erythema', 'scaling', 'lesion', 'rash', 'papules', 'excoriation'], ['physical_exam']);
    skinExam.forEach(ex => {
      evidence.push(`${(ex.display_text || ex.canonical_name || '').charAt(0).toUpperCase() + (ex.display_text || ex.canonical_name || '').slice(1)}.`);
      markRepresented([ex], 'DERM_TEMPLATE_EXAM');
    });

    // 4b. Care barriers
    const barriers = getEntities(graph, [], ['care_barrier']);
    barriers.forEach(b => {
      evidence.push(`${(b.display_text || b.canonical_name || '').charAt(0).toUpperCase() + (b.display_text || b.canonical_name || '').slice(1)}.`);
      markRepresented([b], 'DERM_TEMPLATE_BARRIER');
    });

    // 5. Dermatology referral
    const dermReferrals = getEntities(graph, ['dermatologist', 'dermatology', 'dermoscopy'], ['referral', 'administrative', 'follow_up']);
    dermReferrals.forEach(r => { referrals.push(`${r.display_text || 'Dermatology'} review.`); markRepresented([r], 'DERM_TEMPLATE_REFERRAL'); });

    // 6. Follow-up
    const followUps = getEntities(graph, ['follow.up', 'review', 'repeat'], ['follow_up', 'administrative']);
    followUps.forEach(f => { follow_ups.push(`${f.display_text || f.canonical_name || 'Follow-up as required'}.`); markRepresented([f], 'DERM_TEMPLATE_FOLLOWUP'); });

    return { evidence, treatments_planned, counselling, investigations_planned, referrals, follow_ups };
  }
}
