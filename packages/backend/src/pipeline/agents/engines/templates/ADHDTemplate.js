/**
 * ADHDTemplate — DAS V30
 * Evidence: Control on current regimen, stimulant tolerance, side effects.
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

export class ADHDTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    // 1. Control status
    const controlEntities = getEntities(graph, ['controlled', 'stable', 'focus improved', 'improving']);
    const uncontrolledEntities = getEntities(graph, ['uncontrolled', 'poor focus', 'worsening', 'distracted']);
    if (controlEntities.length > 0) {
      evidence.push('ADHD symptoms controlled on current regimen.');
      markRepresented(controlEntities, 'ADHD_TEMPLATE_CONTROL');
    } else if (uncontrolledEntities.length > 0) {
      evidence.push('ADHD symptoms poorly controlled.');
      markRepresented(uncontrolledEntities, 'ADHD_TEMPLATE_FLARE');
    }

    // 2. Stimulant medications
    const ADHD_MEDS = ['methylphenidate', 'amphetamine', 'dexamphetamine', 'lisdexamfetamine',
      'ritalin', 'concerta', 'adderall', 'vyvanse', 'dexedrine', 'strattera', 'atomoxetine',
      'guanfacine', 'intuniv', 'clonidine'];
    const adhdMeds = getEntities(graph, ADHD_MEDS, ['medication', 'medication_order', 'medication_decision']);
    adhdMeds.forEach(med => {
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
      markRepresented([med], 'ADHD_TEMPLATE_MEDS');
    });

    // 3. Side effects (sleep/appetite common with stimulants)
    const seEntities = getEntities(graph, ['insomnia', 'sleep', 'appetite', 'weight loss', 'tachycardia', 'palpitations']);
    seEntities.forEach(se => {
      evidence.push(`${(se.display_text || se.canonical_name || '').charAt(0).toUpperCase() + (se.display_text || se.canonical_name || '').slice(1)} noted.`);
      markRepresented([se], 'ADHD_TEMPLATE_SE');
    });

    // 4. Psychiatry / psychology referral
    const referralsEntities = getEntities(graph, ['psychiatry', 'psychiatrist', 'psychology', 'psychologist', 'cbt'],
      ['referral', 'administrative', 'follow_up']);
    referralsEntities.forEach(r => {
      referrals.push(`${(r.display_text || r.canonical_name || 'Psychiatry').charAt(0).toUpperCase() + (r.display_text || r.canonical_name || 'Psychiatry').slice(1)} referral.`);
      markRepresented([r], 'ADHD_TEMPLATE_REFERRAL');
    });

    // 5. Follow-up (e.g. script renewals)
    const followUps = getEntities(graph, ['follow.up', 'script', 'prescription renewal', 'review'], ['follow_up', 'administrative']);
    followUps.forEach(f => { follow_ups.push(`${f.display_text || f.canonical_name || 'Follow-up for prescription renewal'}.`); markRepresented([f], 'ADHD_TEMPLATE_FOLLOWUP'); });

    return { evidence, treatments_planned, counselling, investigations_planned, referrals, follow_ups };
  }
}
