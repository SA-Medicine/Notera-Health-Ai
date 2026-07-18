export class HistoricalContextEngine {
  static execute(graph) {
    const entities = graph.clinical_entities || [];
    const rels = graph.resolved_relationships || [];

    // Drugs that, when present and active, indicate a condition IS being managed this
    // visit — so it must stay a numbered A&P problem rather than be demoted to PMH.
    const ACTIVE_MED_COMPAT = [
      [/diabet|glucose|a1c|sugar/i, /metformin|insulin|ozempic|wegovy|semaglutide|glipizide|gliclazide|jardiance|farxiga|trulicity/i],
      [/hypertension|blood pressure|htn/i, /lisinopril|amlodipine|ramipril|losartan|metoprolol|bisoprolol|perindopril|valsartan/i],
      [/lipid|cholesterol|hyperlip/i, /statin|atorvastatin|rosuvastatin|simvastatin|crestor|lipitor|ezetimibe/i],
      [/psoriasis|plaque|eczema|derm/i, /ilumya|otezla|tremfya|skyrizi|cosentyx|taltz|methotrexate|zoryve|dupixent/i],
      [/depress|anxi|mood/i, /sertraline|fluoxetine|escitalopram|venlafaxine|citalopram|duloxetine/i],
      [/thyroid/i, /levothyroxine|synthroid|methimazole/i],
      [/asthma|copd/i, /ventolin|salbutamol|symbicort|fluticasone|spiriva|albuterol/i],
    ];

    const text = (e) => (e.display_text || e.canonical_name || '').toLowerCase();

    // A condition counts as "actively managed this visit" if it links to a plan action,
    // declares its own plan, or a topically-compatible active medication is present.
    const hasActivePlan = (e) => {
      const planTypes = ['medication', 'medication_order', 'investigation', 'treatment', 'referral', 'follow_up'];
      const linked = rels
        .filter(r => r.source === e.id || r.target === e.id)
        .map(r => (r.source === e.id ? r.target : r.source))
        .some(id => {
          const t = entities.find(x => x.id === id);
          return t && planTypes.includes(t.entity_type) && !(t.is_negative || t.clinical_role === 'negative_finding');
        });
      if (linked) return true;

      const selfPlan = [
        ...(e.investigation_ids || []), ...(e.treatment_ids || []),
        ...(e.medication_ids || []), ...(e.referral_ids || []), ...(e.followup_ids || []),
      ].length > 0 || e.has_plan === true;
      if (selfPlan) return true;

      const name = text(e);
      return ACTIVE_MED_COMPAT.some(([dx, med]) => dx.test(name) && entities.some(x =>
        (x.entity_type === 'medication' || x.entity_type === 'medication_order') &&
        !(x.is_negative || x.clinical_role === 'negative_finding') &&
        med.test((x.medication || x.display_text || x.canonical_name || '').toLowerCase())));
    };

    // Established/chronic condition signals.
    const CHRONIC_RX = /(fibromyalgia|sleep apnea|osteoarthritis|hypothyroid|hyperthyroid|asthma|copd|gout|chronic pain|psoriasis|eczema|gerd|reflux|migraine|epilepsy|crohn|colitis|arthritis)/i;
    const ESTABLISHED_STATUS = ['resolved', 'chronic', 'stable', 'inactive', 'controlled', 'historical', 'past'];
    const shortReviewQuote = (e) => {
      const q = e.source_quote || (e.transcript_span && e.transcript_span.quote) || '';
      const words = String(q).trim().split(/\s+/).filter(Boolean).length;
      return words > 0 && words <= 6;
    };
    const isEstablished = (e) =>
      ESTABLISHED_STATUS.includes((e.status || '').toLowerCase()) ||
      e.temporality === 'historical' ||
      CHRONIC_RX.test(text(e)) ||
      shortReviewQuote(e);

    const toPmh = (entity) => {
      entity.rendered_section = "Past Medical History";
      entity.clinical_role = "past_history";
    };

    entities.forEach(entity => {
      // Never demote a denied/negated fact.
      if (entity.is_negative || entity.clinical_role === 'negative_finding' || entity.certainty === 'negated') return;

      // Existing rule: resolved diagnoses, historical procedures, resolved meds → PMH.
      if (
        (entity.entity_type === "diagnosis" && entity.status === "resolved") ||
        (entity.entity_type === "procedure_history") ||
        (entity.entity_type === "medication" && entity.status === "resolved")
      ) {
        toPmh(entity);
        return;
      }

      // New rule (template PMH clause: "chronic conditions... relevant to the current
      // presentation"): an established/chronic condition that is merely reviewed —
      // NOT actively managed this visit — belongs in PMH, not as its own A&P problem.
      if (entity.entity_type === "diagnosis" && isEstablished(entity) && !hasActivePlan(entity)) {
        toPmh(entity);
      }
    });

    return graph;
  }
}
