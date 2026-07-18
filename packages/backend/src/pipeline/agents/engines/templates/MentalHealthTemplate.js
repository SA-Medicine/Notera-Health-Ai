/**
 * MentalHealthTemplate — DAS V30
 * Evidence: mood/affect, PHQ-9/GAD-7 scores, current medication tolerance.
 */
function getEntities(graph, keywords, types = []) {
  return (graph.clinical_entities || []).filter(e => {
    const text = ((e.display_text || '') + ' ' + (e.canonical_name || '')).toLowerCase();
    return (types.length === 0 || types.includes(e.entity_type)) && keywords.some(kw => text.includes(kw));
  });
}
function getNumeric(graph, ...kws) {
  return (graph.numeric_data || []).find(n => kws.some(kw => (n.test_name || '').toLowerCase().includes(kw))) || null;
}
function markRepresented(entities, tag) {
  entities.forEach(e => { e.represented_by = e.represented_by || []; if (!e.represented_by.includes(tag)) e.represented_by.push(tag); });
}

export class MentalHealthTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    // 1. Mood/affect status
    const moodEntities = getEntities(graph, ['mood', 'affect', 'euthymic', 'depressed mood', 'anxious', 'low mood', 'stable mood']);
    moodEntities.slice(0, 2).forEach(m => {
      evidence.push(`${(m.display_text || m.canonical_name || '').charAt(0).toUpperCase() + (m.display_text || m.canonical_name || '').slice(1)}.`);
      markRepresented([m], 'MH_TEMPLATE_MOOD');
    });

    // 2. PHQ-9 / GAD-7 / mental health scores
    const phq = getNumeric(graph, 'phq', 'phq-9', 'patient health questionnaire');
    const gad = getNumeric(graph, 'gad', 'gad-7', 'generalised anxiety');
    if (phq) { evidence.push(`PHQ-9 score: ${phq.value}.`); markRepresented([phq], 'MH_TEMPLATE_PHQ'); }
    if (gad)  { evidence.push(`GAD-7 score: ${gad.value}.`); markRepresented([gad], 'MH_TEMPLATE_GAD'); }

    // 3. Current medications
    const MH_MEDS = ['sertraline', 'fluoxetine', 'escitalopram', 'citalopram', 'venlafaxine',
      'desvenlafaxine', 'mirtazapine', 'bupropion', 'quetiapine', 'olanzapine', 'aripiprazole',
      'lithium', 'valproate', 'lamotrigine', 'clonazepam', 'diazepam', 'alprazolam'];
    const mhMeds = getEntities(graph, MH_MEDS, ['medication', 'medication_order', 'medication_decision']);
    mhMeds.forEach(med => {
      const name = med.medication || med.canonical_name || med.display_text || '';
      const dose = med.dose ? ` ${med.dose}` : '';
      const freq = med.frequency ? ` ${med.frequency}` : '';
      const action = (med.action || 'continue').toLowerCase();
      const tolerance = med.tolerance ? ` — tolerating ${med.tolerance}` : ' — tolerating well';
      if (action === 'continue' || action === 'ongoing') {
        treatments_planned.push(`Continue ${name}${dose}${freq}${tolerance}.`);
      } else if (action === 'increase') {
        treatments_planned.push(`${name} dose increased to${dose}.`);
      } else if (action === 'start' || action === 'initiate') {
        treatments_planned.push(`Initiated ${name}${dose}${freq}.`);
      } else {
        treatments_planned.push(`${name}${dose}${freq} — ${action}.`);
      }
      markRepresented([med], 'MH_TEMPLATE_MEDS');
    });

    // 4. Therapy / psychology referral
    const therapyReferrals = getEntities(graph, ['psychology', 'psychologist', 'psychiatry', 'psychiatrist', 'counselling', 'cbt', 'therapy', 'mental health nurse'],
      ['referral', 'administrative', 'follow_up']);
    therapyReferrals.forEach(r => {
      referrals.push(`${(r.display_text || r.canonical_name || 'Psychology').charAt(0).toUpperCase() + (r.display_text || r.canonical_name || 'Psychology').slice(1)} referral.`);
      markRepresented([r], 'MH_TEMPLATE_REFERRAL');
    });

    // 5. Safety assessment (if mentioned)
    const safetyEntities = getEntities(graph, ['suicidal', 'self-harm', 'safety plan', 'risk assessment', 'passive ideation']);
    safetyEntities.forEach(s => {
      evidence.push(`${(s.display_text || s.canonical_name || '').charAt(0).toUpperCase() + (s.display_text || s.canonical_name || '').slice(1)} — safety assessed.`);
      markRepresented([s], 'MH_TEMPLATE_SAFETY');
    });

    // 6. Counselling
    if (mhMeds.length > 0 || therapyReferrals.length > 0) {
      counselling.push('Mental health management plan discussed with patient.');
    }

    return { evidence, treatments_planned, counselling, investigations_planned, referrals, follow_ups };
  }
}
