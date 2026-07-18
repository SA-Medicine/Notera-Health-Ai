/**
 * GynecologyTemplate — DAS V30
 * Evidence: LMP, cycle details, contraception status, cervical screening.
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

export class GynecologyTemplate {
  static execute(problem, graph) {
    const evidence = [];
    const treatments_planned = [];
    const counselling = [];
    const investigations_planned = [];
    const referrals = [];
    const follow_ups = [];

    // 1. Menstrual history
    const lmpEntities = getEntities(graph, ['lmp', 'last menstrual period']);
    if (lmpEntities.length > 0) {
      const lmp = lmpEntities[0];
      const date = lmp.observation_date || lmp.timeframe || '';
      evidence.push(`LMP${date ? ` ${date}` : ' noted'}.`);
      markRepresented(lmpEntities, 'GYN_TEMPLATE_LMP');
    }

    const cycleEntities = getEntities(graph, ['menorrhagia', 'dysmenorrhea', 'heavy bleeding', 'irregular periods', 'cycle']);
    cycleEntities.forEach(c => {
      if (c.menstrual_cycle_history && c.menstrual_cycle_history.length > 0) {
        c.menstrual_cycle_history.forEach(hist => {
          let line = 'Cycle:';
          if (hist.start_date) line += ` started ${hist.start_date}`;
          if (hist.end_date) line += ` ended ${hist.end_date}`;
          if (hist.duration_days) line += ` lasting ${hist.duration_days} days`;
          evidence.push(line);
        });
      }
      evidence.push(`${(c.display_text || c.canonical_name || '').charAt(0).toUpperCase() + (c.display_text || c.canonical_name || '').slice(1)}.`);
      markRepresented([c], 'GYN_TEMPLATE_CYCLE');
    });

    // 2. Contraception
    const contraEntities = getEntities(graph, ['contraception', 'ocp', 'iud', 'mirena', 'implanon', 'condoms', 'nexplanon', 'pill', 'birth control']);
    if (contraEntities.length > 0) {
      const texts = contraEntities.map(e => e.display_text || e.canonical_name || '').filter(Boolean);
      evidence.push(`Current contraception: ${texts.join(', ')}.`);
      markRepresented(contraEntities, 'GYN_TEMPLATE_CONTRA');
    }

    // 3. Cervical screening (Pap smear)
    const papEntities = getEntities(graph, ['pap smear', 'cervical screening', 'cst', 'hpv']);
    papEntities.forEach(p => {
      const type = p.entity_type;
      const text = p.display_text || p.canonical_name || 'Cervical screening';
      if (type === 'investigation' || type === 'order') {
        investigations_planned.push(`${text.charAt(0).toUpperCase() + text.slice(1)} planned.`);
      } else if (type === 'administrative' || type === 'follow_up') {
        follow_ups.push(`${text.charAt(0).toUpperCase() + text.slice(1)} due.`);
      } else {
        evidence.push(`${text.charAt(0).toUpperCase() + text.slice(1)} discussed.`);
      }
      markRepresented([p], 'GYN_TEMPLATE_PAP');
    });

    // 4. Pregnancy / parity (if mentioned)
    const pregEntities = getEntities(graph, ['pregnant', 'pregnancy', 'gravida', 'para', 'g p ']);
    pregEntities.forEach(p => {
      evidence.push(`${(p.display_text || p.canonical_name || '').charAt(0).toUpperCase() + (p.display_text || p.canonical_name || '').slice(1)}.`);
      markRepresented([p], 'GYN_TEMPLATE_PREG');
    });

    // 5. Gynecology referrals
    const gynReferrals = getEntities(graph, ['gynecologist', 'gynaecologist', 'gynecology', 'gynaecology', 'obstetrics', 'obgyn'], ['referral', 'administrative', 'follow_up']);
    gynReferrals.forEach(r => {
      referrals.push(`${(r.display_text || r.canonical_name || 'Gynaecology').charAt(0).toUpperCase() + (r.display_text || r.canonical_name || 'Gynaecology').slice(1)} referral.`);
      markRepresented([r], 'GYN_TEMPLATE_REFERRAL');
    });

    return { evidence, treatments_planned, counselling, investigations_planned, referrals, follow_ups };
  }
}
