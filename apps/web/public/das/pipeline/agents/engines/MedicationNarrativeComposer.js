/**
 * MedicationNarrativeComposer — DAS V25 ⭐
 * DEPRECATED V26 — Replaced by ClinicalStoryLLMAgent (medication narratives now generated in disease_management and treatments_planned sections).
 * TOMBSTONED: kept for DeterministicFallbackComposer. Do NOT call in active V26 pipeline.
 *
 * Transforms raw medication entities into clinical narrative sentences using:
 *   Medication + Dose + Frequency + Tolerance + Decision = Narrative
 *
 * Current DAS:  "Continue Metformin"
 * Heidi output: "Continue metformin 500mg twice daily — tolerating well without nausea."
 *
 * Action verbs:
 *   continue  → "Continue {drug} {dose} — tolerating well."
 *   start     → "Initiated {drug} {dose} {freq}."
 *   stop      → "{drug} discontinued."
 *   increase  → "{drug} dose increased to {dose}."
 *   decrease  → "{drug} dose reduced to {dose}."
 *   discuss   → "Dose escalation discussed; patient considering."
 *   hold      → "{drug} held temporarily."
 *
 * Writes to:
 *   graph.clinical_story.subjective.disease_management[]  (ongoing meds)
 *   graph.clinical_story.assessment_plan[i].treatments_planned[]  (new decisions)
 */

const ACTION_TEMPLATES = {
  continue: (med, dose, freq, tolerance, sideEffects) => {
    let s = `Continue ${med}`;
    if (dose) s += ` ${dose}`;
    if (freq) s += ` ${freq}`;
    if (tolerance || sideEffects) {
      s += ` — tolerating`;
      if (tolerance) s += ` ${tolerance}`;
      if (sideEffects) s += ` without ${sideEffects}`;
    }
    return s + '.';
  },
  start: (med, dose, freq) => {
    let s = `Initiated ${med}`;
    if (dose) s += ` ${dose}`;
    if (freq) s += ` ${freq}`;
    return s + '.';
  },
  initiate: (med, dose, freq) => {
    let s = `Initiated ${med}`;
    if (dose) s += ` ${dose}`;
    if (freq) s += ` ${freq}`;
    return s + '.';
  },
  stop: (med) => `${med} discontinued.`,
  discontinue: (med) => `${med} discontinued.`,
  hold: (med) => `${med} held temporarily.`,
  increase: (med, dose) => `${med} dose increased${dose ? ` to ${dose}` : ''}.`,
  decrease: (med, dose) => `${med} dose reduced${dose ? ` to ${dose}` : ''}.`,
  reduce: (med, dose) => `${med} dose reduced${dose ? ` to ${dose}` : ''}.`,
  adjust: (med, dose) => `${med} dose adjusted${dose ? ` to ${dose}` : ''}.`,
  discuss: (med) => `Dose escalation for ${med} discussed; patient considering.`,
  switch: (med, dose) => `Switched to ${med}${dose ? ` ${dose}` : ''}.`,
  add: (med, dose, freq) => {
    let s = `${med} added`;
    if (dose) s += ` at ${dose}`;
    if (freq) s += ` ${freq}`;
    return s + '.';
  },
};

function composeMedNarrative(entity) {
  const med = (entity.medication || entity.canonical_name || entity.display_text || '').trim();
  if (!med) return null;

  const dose = entity.dose || entity.dosage || null;
  const freq = entity.frequency || entity.route || null;
  const action = (entity.action || entity.medication_action || 'continue').toLowerCase();
  const tolerance = entity.tolerance || null;
  const sideEffects = entity.side_effects || null;

  // Look up template
  const templateFn = ACTION_TEMPLATES[action] || ACTION_TEMPLATES.continue;

  let narrative;
  try {
    narrative = templateFn(med, dose, freq, tolerance, sideEffects);
  } catch {
    narrative = `${med}${dose ? ` ${dose}` : ''}${freq ? ` ${freq}` : ''}.`;
  }

  return narrative.charAt(0).toUpperCase() + narrative.slice(1);
}

export class MedicationNarrativeComposer {
  static execute(graph) {
    const entities = graph.clinical_entities || [];
    const story = graph.clinical_story;

    if (!story) return graph; // EncounterNarrativeBuilder must run first

    const medEntities = entities.filter(e =>
      e.entity_type === 'medication' ||
      e.entity_type === 'medication_order' ||
      e.entity_type === 'medication_decision'
    );

    // Group by canonical drug name to detect duplicates
    const drugGroups = {};
    medEntities.forEach(e => {
      const key = (e.medication || e.canonical_name || '').toLowerCase().trim();
      if (!key) return;
      if (!drugGroups[key]) drugGroups[key] = [];
      drugGroups[key].push(e);
    });

    // Compose narratives
    const ongoingNarratives = [];   // Disease management (continue/hold)
    const decisionNarratives = {};  // Keyed by problem index

    Object.values(drugGroups).forEach(group => {
      // If multiple entries for same drug, compose per entry
      group.forEach(entity => {
        const narrative = composeMedNarrative(entity);
        if (!narrative) return;

        // Determine where this narrative belongs
        const action = (entity.action || entity.medication_action || 'continue').toLowerCase();
        const isNewDecision = ['start', 'initiate', 'stop', 'discontinue', 'increase', 'decrease',
          'reduce', 'adjust', 'switch', 'add', 'discuss'].includes(action);

        // Link to the right assessment_plan entry via semantic_group
        const group = entity.semantic_group || 'GENERAL';
        const problemIdx = (story.assessment_plan || []).findIndex(ap =>
          ap._problem_ref?.semantic_group === group ||
          (ap.diagnosis || '').toLowerCase().includes(
            (entity.indication || entity.canonical_name || '').toLowerCase()
          )
        );

        entity.medication_narrative = narrative;
        entity.represented_by = entity.represented_by || [];
        if (!entity.represented_by.includes('MED_NARRATIVE')) entity.represented_by.push('MED_NARRATIVE');

        if (isNewDecision && problemIdx >= 0) {
          // New decision → Assessment/Plan
          if (!decisionNarratives[problemIdx]) decisionNarratives[problemIdx] = [];
          decisionNarratives[problemIdx].push(narrative);
          if (!entity.represented_by.includes('PLAN_TREATMENT')) entity.represented_by.push('PLAN_TREATMENT');
        } else {
          // Ongoing → Disease management
          ongoingNarratives.push(narrative);
          if (!entity.represented_by.includes('SUBJECTIVE_DISEASE_MGT')) entity.represented_by.push('SUBJECTIVE_DISEASE_MGT');
        }
      });
    });

    // Write disease management (replace raw entity dump from EncounterNarrativeBuilder)
    if (ongoingNarratives.length > 0) {
      story.subjective.disease_management = ongoingNarratives;
    }

    // Write medication decisions to the relevant assessment_plan entry
    Object.entries(decisionNarratives).forEach(([idx, narratives]) => {
      const plan = story.assessment_plan[parseInt(idx)];
      if (plan) {
        plan.treatments_planned = [
          ...plan.treatments_planned,
          ...narratives,
        ];
      }
    });

    // Also write all medication decisions to the fallback first plan if unmatched
    const unmatchedDecisions = Object.entries(decisionNarratives)
      .filter(([idx]) => !story.assessment_plan[parseInt(idx)])
      .flatMap(([, narratives]) => narratives);

    if (unmatchedDecisions.length > 0 && story.assessment_plan.length > 0) {
      story.assessment_plan[0].treatments_planned = [
        ...story.assessment_plan[0].treatments_planned,
        ...unmatchedDecisions,
      ];
    }

    return graph;
  }
}
