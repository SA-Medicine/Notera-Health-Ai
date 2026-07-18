/**
 * AssessmentComposer — DAS V25 ⭐
 * DEPRECATED V26 — Replaced by ClinicalStoryLLMAgent assessment section.
 * TOMBSTONED: kept for DeterministicFallbackComposer. Do NOT call in active V26 pipeline.
 * Deterministic synthesis engine. For each active problem in assessment_plan[],
 * generates structured clinical evidence narratives.
 *
 * Heidi assessment formula:
 *   Diagnosis + Evidence + Clinical Course + Decision = Assessment Narrative
 *
 * Example (Diabetes):
 *   "HbA1c 6.2, improved from previous but remains above target (<6).
 *    Home glucose readings acceptable.
 *    No diabetic complications reported."
 *
 * Rules are DETERMINISTIC — no LLM involved.
 * Each rule set is keyed by semantic_group.
 */

// ── Utility helpers ─────────────────────────────────────────────────────────

function cap(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getNumeric(graph, ...keys) {
  const numerics = graph.numeric_data || [];
  for (const key of keys) {
    const match = numerics.find(n => {
      const name = (n.test_name || '').toLowerCase();
      return key.split('|').some(k => name.includes(k));
    });
    if (match) return match;
  }
  return null;
}

function getEntitiesByGroup(graph, semanticGroup) {
  return (graph.clinical_entities || []).filter(e =>
    e.semantic_group === semanticGroup
  );
}

function getEntitiesByType(graph, ...types) {
  return (graph.clinical_entities || []).filter(e => types.includes(e.entity_type));
}

function markRepresented(entities, tag) {
  entities.forEach(e => {
    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes(tag)) e.represented_by.push(tag);
  });
}

// ── Diagnosis-specific evidence composers ───────────────────────────────────

function composeDiabetesEvidence(graph, ap) {
  const evidence = [];
  const entities = getEntitiesByGroup(graph, 'DIABETES');

  // A1c
  const a1c = getNumeric(graph, 'a1c|hba1c');
  if (a1c) {
    const val = a1c.value;
    const prev = a1c.previous_value;
    const trend = a1c.trend;
    let line = `HbA1c ${val}`;
    if (prev && String(prev) !== String(val)) {
      line += trend === 'falling'
        ? `, improved from ${prev}`
        : trend === 'rising'
          ? `, increased from ${prev}`
          : `, unchanged from ${prev}`;
    }
    // Target check
    const numVal = parseFloat(val);
    if (!isNaN(numVal)) {
      line += numVal < 7.0
        ? ' — within target'
        : numVal < 8.0
          ? ' — above target (<7)'
          : ' — significantly above target';
    }
    line += '.';
    evidence.push(cap(line));
    markRepresented([a1c], 'ASSESSMENT_DIABETES');
  }

  // Glucose readings
  const glucoseEntity = entities.find(e =>
    (e.display_text || '').toLowerCase().includes('glucose') ||
    (e.display_text || '').toLowerCase().includes('sugar')
  );
  if (glucoseEntity) {
    evidence.push(cap(glucoseEntity.display_text || '') + '.');
    markRepresented([glucoseEntity], 'ASSESSMENT_DIABETES');
  }

  // Complications
  const hasComplications = entities.some(e =>
    (e.display_text || '').toLowerCase().match(/neuropath|nephropathy|retinopathy|complication/i)
  );
  if (!hasComplications) {
    evidence.push('No diabetic complications reported.');
  }

  return evidence;
}

function composeAnemiaEvidence(graph, ap) {
  const evidence = [];
  const entities = getEntitiesByGroup(graph, 'ANEMIA');

  // Hemoglobin
  const hb = getNumeric(graph, 'hemoglobin|haemoglobin|hb');
  if (hb) {
    let line = `Hemoglobin ${hb.value}`;
    if (hb.unit) line += ` ${hb.unit}`;
    if (hb.previous_value && String(hb.previous_value) !== String(hb.value)) {
      line += ` (previously ${hb.previous_value} ${hb.unit || ''})`.trim();
    }
    if (hb.normal_value) line += `, normal ${hb.normal_value} ${hb.unit || ''}`.trim();
    evidence.push(cap(line) + '.');
    markRepresented([hb], 'ASSESSMENT_ANEMIA');
  }

  // Ferritin / Iron
  const ferritin = getNumeric(graph, 'ferritin');
  if (ferritin) {
    evidence.push(`Ferritin ${ferritin.value}${ferritin.unit ? ` ${ferritin.unit}` : ''}.`);
    markRepresented([ferritin], 'ASSESSMENT_ANEMIA');
  }

  // Treatment response
  const onIron = entities.some(e =>
    (e.display_text || e.canonical_name || '').toLowerCase().includes('iron')
  );
  if (onIron) {
    const refractory = entities.some(e =>
      (e.display_text || '').toLowerCase().match(/refractor|not respond|failing/i)
    );
    evidence.push(refractory
      ? 'Refractory to oral iron supplementation.'
      : 'Currently on oral iron supplementation.'
    );
  }

  markRepresented(entities.slice(0, 3), 'ASSESSMENT_ANEMIA');
  return evidence;
}

function composeHypertensionEvidence(graph, ap) {
  const evidence = [];

  const bp = getNumeric(graph, 'blood pressure|bp');
  if (bp) {
    let line = `Blood pressure ${bp.value}`;
    if (bp.unit) line += ` ${bp.unit}`;
    if (bp.trend_narrative) line = bp.trend_narrative;
    evidence.push(cap(line) + '.');
    markRepresented([bp], 'ASSESSMENT_HTN');
  }

  const entities = getEntitiesByGroup(graph, 'HYPERTENSION');
  const targetMet = entities.some(e =>
    (e.display_text || '').toLowerCase().match(/controlled|target|acceptable|normal/i)
  );
  if (targetMet) evidence.push('Blood pressure within target range.');

  markRepresented(entities.slice(0, 2), 'ASSESSMENT_HTN');
  return evidence;
}

function composeLipidsEvidence(graph, ap) {
  const evidence = [];

  const ldl = getNumeric(graph, 'ldl');
  if (ldl) {
    evidence.push(`LDL ${ldl.value}${ldl.unit ? ` ${ldl.unit}` : ''}${ldl.previous_value ? ` (previously ${ldl.previous_value})` : ''}.`);
    markRepresented([ldl], 'ASSESSMENT_LIPIDS');
  }

  const hdl = getNumeric(graph, 'hdl');
  if (hdl) {
    evidence.push(`HDL ${hdl.value}${hdl.unit ? ` ${hdl.unit}` : ''}.`);
    markRepresented([hdl], 'ASSESSMENT_LIPIDS');
  }

  const totalChol = getNumeric(graph, 'total cholesterol|cholesterol');
  if (totalChol) {
    evidence.push(`Total cholesterol ${totalChol.value}${totalChol.unit ? ` ${totalChol.unit}` : ''}.`);
    markRepresented([totalChol], 'ASSESSMENT_LIPIDS');
  }

  return evidence;
}

function composeWeightEvidence(graph, ap) {
  const evidence = [];

  const bmi = getNumeric(graph, 'bmi|body mass');
  const weight = getNumeric(graph, 'weight');

  if (weight) {
    let line = `Weight ${weight.value}${weight.unit ? ` ${weight.unit}` : ''}`;
    if (weight.previous_value) {
      const diff = parseFloat(weight.value) - parseFloat(weight.previous_value);
      if (!isNaN(diff)) {
        line += diff > 0
          ? ` (gained ${Math.abs(diff).toFixed(1)} ${weight.unit || 'kg'} from previous)`
          : ` (lost ${Math.abs(diff).toFixed(1)} ${weight.unit || 'kg'} from previous)`;
      }
    }
    evidence.push(cap(line) + '.');
    markRepresented([weight], 'ASSESSMENT_WEIGHT');
  }

  if (bmi) {
    const numBmi = parseFloat(bmi.value);
    let bmiClass = '';
    if (!isNaN(numBmi)) {
      if (numBmi < 18.5) bmiClass = ' — underweight';
      else if (numBmi < 25) bmiClass = ' — within healthy range';
      else if (numBmi < 30) bmiClass = ' — overweight';
      else bmiClass = ' — obese';
    }
    evidence.push(`BMI ${bmi.value}${bmiClass}.`);
    markRepresented([bmi], 'ASSESSMENT_WEIGHT');
  }

  return evidence;
}

function composeMusculoskeletalEvidence(graph, ap) {
  const evidence = [];
  const entities = getEntitiesByGroup(graph, 'MUSCULOSKELETAL');

  // Mechanism / trauma
  const traumaEntity = (graph.clinical_entities || []).find(e =>
    e.semantic_group === 'ACUTE_INJURY' ||
    (e.display_text || '').toLowerCase().match(/fall|trauma|mechanism|injury|fracture|sprain|twist/i)
  );
  if (traumaEntity) {
    const txt = traumaEntity.display_text || traumaEntity.canonical_name || '';
    evidence.push(cap(txt) + '.');
    markRepresented([traumaEntity], 'ASSESSMENT_MSK');
  }

  // Active findings
  entities.slice(0, 4).forEach(e => {
    const txt = e.display_text || e.canonical_name || '';
    if (!txt || evidence.some(ev => ev.toLowerCase().includes(txt.toLowerCase()))) return;
    evidence.push(cap(txt) + '.');
    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes('ASSESSMENT_MSK')) e.represented_by.push('ASSESSMENT_MSK');
  });

  // Exam findings
  const examFindings = getEntitiesByType(graph, 'physical_exam')
    .filter(e => (e.semantic_group === 'MUSCULOSKELETAL' || e.semantic_group === 'ACUTE_INJURY'))
    .slice(0, 2);

  examFindings.forEach(e => {
    const txt = e.display_text || '';
    if (txt) evidence.push(cap(txt) + '.');
    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes('ASSESSMENT_MSK')) e.represented_by.push('ASSESSMENT_MSK');
  });

  return evidence;
}

function composeGenericEvidence(graph, ap) {
  const evidence = [];
  const problem = ap._problem_ref;
  if (!problem) return evidence;

  const diagEntities = (graph.clinical_entities || []).filter(e =>
    (problem.diagnosis_ids || []).includes(e.id) ||
    (problem.supporting_fact_ids || []).includes(e.id)
  );

  diagEntities.slice(0, 4).forEach(e => {
    const txt = e.display_text || e.canonical_name || '';
    if (!txt) return;
    evidence.push(cap(txt) + '.');
    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes('ASSESSMENT_GENERIC')) e.represented_by.push('ASSESSMENT_GENERIC');
  });

  return evidence;
}

// ── Main dispatchers ─────────────────────────────────────────────────────────

const SEMANTIC_COMPOSERS = {
  DIABETES: composeDiabetesEvidence,
  ANEMIA: composeAnemiaEvidence,
  HYPERTENSION: composeHypertensionEvidence,
  LIPIDS: composeLipidsEvidence,
  WEIGHT_MANAGEMENT: composeWeightEvidence,
  MUSCULOSKELETAL: composeMusculoskeletalEvidence,
  ACUTE_INJURY: composeMusculoskeletalEvidence,
};

function detectProblemSemanticGroup(ap, graph) {
  const diag = (ap.diagnosis || '').toLowerCase();
  for (const [group] of Object.entries(SEMANTIC_COMPOSERS)) {
    const groupEntities = getEntitiesByGroup(graph, group);
    if (groupEntities.length > 0) {
      // Check if diagnosis name matches group keywords
      const lGroup = group.toLowerCase().replace('_', ' ');
      if (diag.includes(lGroup.split('_')[0].toLowerCase())) return group;
    }
  }
  // Fallback: check the problem's supporting entities
  const prob = ap._problem_ref;
  if (prob) {
    const allEntities = graph.clinical_entities || [];
    const supporting = allEntities.filter(e =>
      (prob.supporting_fact_ids || []).includes(e.id)
    );
    const firstGroup = supporting.find(e => e.semantic_group && e.semantic_group !== 'GENERAL')?.semantic_group;
    if (firstGroup && SEMANTIC_COMPOSERS[firstGroup]) return firstGroup;
  }
  return 'GENERAL';
}

export class AssessmentComposer {
  static execute(graph) {
    const story = graph.clinical_story;
    if (!story || !story.assessment_plan?.length) return graph;

    story.assessment_plan.forEach((ap, idx) => {
      const diagText = ap.diagnosis || '';
      const diagLower = diagText.toLowerCase();

      // Detect semantic group for this problem
      let semanticGroup = 'GENERAL';
      for (const group of Object.keys(SEMANTIC_COMPOSERS)) {
        const groupEntities = getEntitiesByGroup(graph, group);
        if (groupEntities.length > 0) {
          // Check if the diagnosis name or supporting entities align
          const groupLower = group.toLowerCase().replace(/_/g, ' ');
          if (diagLower.includes(groupLower.split(' ')[0])) {
            semanticGroup = group;
            break;
          }
        }
      }

      // Fallback: infer from supporting entity semantic groups
      if (semanticGroup === 'GENERAL') {
        semanticGroup = detectProblemSemanticGroup(ap, graph);
      }

      // Run the appropriate composer
      const composerFn = SEMANTIC_COMPOSERS[semanticGroup] || composeGenericEvidence;
      const evidence = composerFn(graph, ap);

      // Populate evidence
      ap.evidence = evidence;

      // Clinical course (use existing if set by ClinicalCourseEngine, or generate)
      if (!ap.clinical_course && evidence.length >= 2) {
        ap.clinical_course = evidence[0]; // First evidence sentence as clinical course fallback
      }

      // Pull plans from the problem ref
      const prob = ap._problem_ref;
      if (prob) {
        const entities = graph.clinical_entities || [];

        // Investigations planned (ordered, pending)
        const investIds = prob.investigation_ids || [];
        const investEntities = entities.filter(e =>
          investIds.includes(e.id) &&
          (e.status === 'ordered' || e.status === 'pending')
        );
        ap.investigations_planned = investEntities.map(e => e.display_text || e.canonical_name || '').filter(Boolean);
        markRepresented(investEntities, `PLAN_INVEST_${idx}`);

        // Referrals
        const referralIds = prob.referral_ids || [];
        const referralEntities = entities.filter(e => referralIds.includes(e.id));
        ap.referrals = referralEntities.map(e => e.display_text || e.canonical_name || '').filter(Boolean);
        markRepresented(referralEntities, `PLAN_REFERRAL_${idx}`);

        // Follow-ups
        const followupIds = prob.followup_ids || [];
        const followupEntities = entities.filter(e => followupIds.includes(e.id));
        ap.follow_ups = followupEntities.map(e => {
          const trigger = e.trigger || e.display_text || '';
          const time = e.timeframe || '';
          return [trigger, time].filter(Boolean).join(' — ');
        }).filter(Boolean);
        markRepresented(followupEntities, `PLAN_FOLLOWUP_${idx}`);

        // Recommendations (care plans, counselling)
        const rec = entities.filter(e =>
          (prob.treatment_instruction_ids || []).includes(e.id) ||
          e.entity_type === 'care_plan_context' ||
          e.entity_type === 'counselling'
        );
        ap.recommendations = rec.map(e => cap(e.display_text || e.canonical_name || '')).filter(Boolean);
        markRepresented(rec, `PLAN_REC_${idx}`);
      }
    });

    // Pull global follow-ups and orders into the first problem if unassigned
    if (story.assessment_plan.length > 0) {
      const firstPlan = story.assessment_plan[0];

      // Global follow-ups
      const globalFollowUps = (graph.follow_ups || []).filter(f =>
        !story.assessment_plan.some(ap => ap.follow_ups.some(fu => fu.includes(f.trigger || '')))
      ).map(f => {
        const parts = [f.followup_type, f.trigger, f.timeframe].filter(Boolean);
        return parts.join(' — ');
      });
      firstPlan.follow_ups = [...firstPlan.follow_ups, ...globalFollowUps];

      // Global orders
      const globalOrders = (graph.orders || []).filter(o =>
        (o.status === 'ordered' || o.status === 'pending') &&
        !story.assessment_plan.some(ap => ap.investigations_planned.some(i => i.includes(o.test || '')))
      ).map(o => o.test || '').filter(Boolean);
      firstPlan.investigations_planned = [...firstPlan.investigations_planned, ...globalOrders];
    }

    return graph;
  }
}
