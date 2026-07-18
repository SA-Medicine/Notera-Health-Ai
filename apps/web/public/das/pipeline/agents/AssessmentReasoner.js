/**
 * AssessmentReasoner — DAS V31
 *
 * Core engine for building Assessment & Plan problem blocks.
 * Runs after ClinicalStoryLLMAgent (HeidiSlotFillerAgent).
 *
 * V31 CRITICAL CHANGES:
 *   - ALL clinical reasoning prose REMOVED ("The clinical presentation of...")
 *   - Strict Heidi 6-field output per problem ONLY
 *   - Templates still run for standard-of-care data lookups
 *   - AssessmentReasoner AUGMENTS the SlotFiller's problem list
 *     by injecting template-derived investigation/treatment data
 *   - Never adds text that wasn't in the transcript
 */

import { DiabetesTemplate } from './engines/templates/DiabetesTemplate.js';
import { AnemiaTemplate } from './engines/templates/AnemiaTemplate.js';
import { WeightLossTemplate } from './engines/templates/WeightLossTemplate.js';
import { MusculoskeletalTemplate } from './engines/templates/MusculoskeletalTemplate.js';
import { DermatologyTemplate } from './engines/templates/DermatologyTemplate.js';
import { MentalHealthTemplate } from './engines/templates/MentalHealthTemplate.js';
import { ADHDTemplate } from './engines/templates/ADHDTemplate.js';
import { GynecologyTemplate } from './engines/templates/GynecologyTemplate.js';
import { PediatricsTemplate } from './engines/templates/PediatricsTemplate.js';
import { MedicationManagementTemplate } from './engines/templates/MedicationManagementTemplate.js';
import { GenericTemplate } from './engines/templates/GenericTemplate.js';

function detectSemanticGroup(problem) {
  if (problem.semantic_group) return problem.semantic_group;
  const p = (problem.problem || problem.title || '').toLowerCase();
  
  if (p.includes('diabet')) return 'DIABETES';
  if (p.includes('anemia') || p.includes('anaemia')) return 'ANEMIA';
  if (p.includes('weight') || p.includes('obes')) return 'WEIGHT_MANAGEMENT';
  if (p.includes('pain') || p.includes('injury') || p.includes('fracture') || p.includes('sprain') || p.includes('musculoskel') || p.includes('osteoarth') || p.includes('swelling') || p.includes('hip') || p.includes('knee') || p.includes('foot') || p.includes('hand') || p.includes('shoulder') || p.includes('back')) return 'MUSCULOSKELETAL';
  if (p.includes('derm') || p.includes('skin') || p.includes('rash') || p.includes('psoriasis') || p.includes('eczema')) return 'DERMATOLOGY';
  if (p.includes('depress') || p.includes('anxi') || p.includes('mental') || p.includes('bipolar') || p.includes('ptsd')) return 'MENTAL_HEALTH';
  if (p.includes('adhd') || p.includes('attention')) return 'ADHD';
  if (p.includes('preg') || p.includes('gyn') || p.includes('menstru') || p.includes('contra') || p.includes('pap')) return 'GYNECOLOGY';
  if (p.includes('pediat') || p.includes('child') || p.includes('infant') || p.includes('milestone')) return 'PEDIATRICS';
  if (p.includes('medication') || p.includes('refill') || p.includes('script')) return 'MEDICATION';
  
  return 'GENERAL';
}

function mergeUnique(arr1, arr2) {
  const merged = [...(arr1 || [])];
  (arr2 || []).forEach(item => {
    if (item && typeof item === 'string' && !merged.some(m => typeof m === 'string' && m.toLowerCase().trim() === item.toLowerCase().trim())) {
      merged.push(item);
    }
  });
  return merged;
}

/**
 * V31: Build strict 6-field problem output from fact graph.
 * Never adds reasoning prose.
 * Never adds text not in the transcript.
 */

function isMedicationCompatibleWithProblem(medName, probName) {
  const med = (medName || '').toLowerCase();
  const prob = (probName || '').toLowerCase();
  if (/(metformin|insulin|ozempic|wegovy|glipizide|jardiance|farxiga)/i.test(med)) {
    return /(diabet|sugar|glucose|a1c|weight|obes|metabolic)/i.test(prob);
  }
  if (/(lisinopril|amlodipine|ramipril|losartan|metoprolol|bisoprolol)/i.test(med)) {
    return /(hypertension|blood pressure|htn)/i.test(prob);
  }
  if (/(atorvastatin|rosuvastatin|simvastatin|crestor|lipitor)/i.test(med)) {
    return /(lipid|cholesterol)/i.test(prob);
  }
  if (/(sertraline|fluoxetine|escitalopram|venlafaxine)/i.test(med)) {
    return /(depress|anxi|mood|mental)/i.test(prob);
  }
  if (/(ilumya|baricitinib|zoryve|vtama|otezla|tremfya|skyrizi|cosentyx|taltz|siliq)/i.test(med)) {
    return /(psoriasis|plaque|skin|derm)/i.test(prob);
  }
  return true; // Unrestricted drugs (like Tylenol) are compatible with anything
}

function isExplicitlySystemicDrug(medName) {
  const med = (medName || '').toLowerCase();
  return /(metformin|insulin|ozempic|wegovy|glipizide|jardiance|farxiga|lisinopril|amlodipine|ramipril|losartan|metoprolol|bisoprolol|atorvastatin|rosuvastatin|simvastatin|crestor|lipitor|sertraline|fluoxetine|escitalopram|venlafaxine|ilumya|baricitinib|zoryve|vtama|otezla|tremfya|skyrizi|cosentyx|taltz|siliq)/i.test(med);
}

function scrubAndReassignMedications(activeProblems, graph) {
  const entities = graph.clinical_entities || [];
  
  // 1. Strip incompatible medications from problems
  activeProblems.forEach(prob => {
    const probName = (prob.display_title || prob.problem || '').toLowerCase();
    
    const arrs = ['entity_ids', 'medication_ids', 'treatment_ids'];
    arrs.forEach(arrName => {
      if (!prob[arrName]) return;
      prob[arrName] = prob[arrName].filter(id => {
        const e = entities.find(x => x.id === id);
        if (e && e.category === 'medication') {
          const medName = e.text || e.medication || e.display_text || '';
          if (!isMedicationCompatibleWithProblem(medName, probName)) {
            return false; // Strip it
          }
        }
        return true;
      });
    });
  });
  
  // 2. Actively re-attach orphaned systemic drugs to a compatible active problem
  const medEntities = entities.filter(e => e.category === 'medication');
  medEntities.forEach(med => {
    const medName = med.text || med.medication || med.display_text || '';
    if (!isExplicitlySystemicDrug(medName)) return; // Only re-attach recognized systemic drugs
    
    let isAssignedToCompatible = false;
    activeProblems.forEach(prob => {
      if ((prob.entity_ids || []).includes(med.id) || (prob.medication_ids || []).includes(med.id)) {
        isAssignedToCompatible = true;
      }
    });
    
    if (!isAssignedToCompatible) {
      for (const prob of activeProblems) {
        const probName = (prob.display_title || prob.problem || '').toLowerCase();
        if (isMedicationCompatibleWithProblem(medName, probName)) {
           if (!prob.entity_ids) prob.entity_ids = [];
           if (!prob.entity_ids.includes(med.id)) prob.entity_ids.push(med.id);
           break;
        }
      }
    }
  });
}

function gatherFactsForProblem(problem, graph) {
  const entities = graph.clinical_entities || [];
  const existingIds = new Set([
    ...(problem.entity_ids || []),
    ...(problem.diagnosis_ids || []),
    ...(problem.symptom_ids || []),
    ...(problem.medication_ids || []),
    ...(problem.investigation_ids || []),
    ...(problem.treatment_ids || []),
    ...(problem.referral_ids || []),
    ...(problem.followup_ids || [])
  ]);

  const probName = (problem.display_title || problem.problem || '').toLowerCase();
  const probCategory = problem.category || '';

  entities.forEach(e => {
    if (existingIds.has(e.id)) return;
    
    // Contamination guard: if it has a problem_hint for something else, don't attach
    if (e.problem_hint && !probName.includes(e.problem_hint.toLowerCase()) && !e.problem_hint.toLowerCase().includes(probName)) {
      return;
    }

    let isCompatible = false;
    
    if (e.problem_hint && (probName.includes(e.problem_hint.toLowerCase()) || e.problem_hint.toLowerCase().includes(probName))) {
      isCompatible = true;
    }
    if (e.body_site && probName.includes(e.body_site.toLowerCase())) {
      isCompatible = true;
    }
    if (probCategory === 'screening' && e.category === 'screening_due') {
      isCompatible = true;
    }
    if (probName.includes('weight') && e.metric_type === 'weight') {
      isCompatible = true;
    }

    if (isCompatible) {
      existingIds.add(e.id);
      if (!problem.entity_ids) problem.entity_ids = [];
      if (!problem.entity_ids.includes(e.id)) problem.entity_ids.push(e.id);
    }
  });
}

function buildProblemFields(problem, storyPlan, templateResult, graph) {
  // Field 1: issue_name — always present (use display_title or merged title)
  let issueName = problem.display_title || problem.problem || storyPlan.title || 'Unknown Problem';
  const certainty = problem.certainty || storyPlan.certainty || 'suspected';

  // Apply certainty hedging language if not confirmed
  if (certainty !== 'confirmed') {
    // Determine if it's a "named condition" hedge or a "vague symptom" hedge.
    // Never hedge a screening/management/monitoring/review item — "Suspected prostate
    // cancer screening" is wrong; it's a screening, not a suspected cancer.
    const isAdminItem = /screening|management|monitoring|review|prophylaxis|follow[\s-]?up|surveillance|refill/i.test(issueName);
    const isNamedCondition = /sciatica|syndrome|disease|pathology|cancer|infection|fracture/i.test(issueName);
    if (isNamedCondition && !isAdminItem && !/possible|suspected|query|rule out/i.test(issueName)) {
      issueName = `Suspected ${issueName.charAt(0).toLowerCase()}${issueName.slice(1)}`;
    }
  }

  // Apply layer 3 contamination guard to all text arrays
  const problemStr = issueName.toLowerCase();
  const filterArrayStrings = (arr) => {
    // Coerce non-strings (LLM can emit nested arrays/objects) to strings first so
    // downstream string ops never crash.
    return [...(arr || [])].map(t => {
      if (typeof t === 'string') return t;
      if (Array.isArray(t)) return t.filter(Boolean).join('; ');
      if (t && typeof t === 'object') return String(t.text ?? t.value ?? '');
      return t == null ? '' : String(t);
    }).filter(t => {
      if (typeof t !== 'string' || !t) return false;
      const tLower = t.toLowerCase();
      if (/(metformin|insulin|ozempic|wegovy|glipizide|jardiance|farxiga)/i.test(tLower)) {
        if (!/(diabet|sugar|glucose|a1c|weight|obes|metabolic)/i.test(problemStr)) return false;
      }
      if (/(lisinopril|amlodipine|ramipril|losartan|metoprolol|bisoprolol)/i.test(tLower)) {
        if (!/(hypertension|blood pressure|htn|cardiac|heart)/i.test(problemStr)) return false;
      }
      return true;
    });
  };

  const planActions = [];

  // Add investigations
  let investigationsPlanned = filterArrayStrings(storyPlan.investigations_planned);
  if (templateResult?.investigations_planned?.length) {
    investigationsPlanned = mergeUnique(investigationsPlanned, templateResult.investigations_planned);
  }
  investigationsPlanned.forEach(text => planActions.push({ text, field_type: 'investigations', timestamp: 0 }));

  // Add treatments
  let treatmentPlanned = filterArrayStrings(storyPlan.treatment_planned);
  let treatmentsPlanned = filterArrayStrings(storyPlan.treatments_planned);
  if (templateResult?.treatment_planned?.length) {
    treatmentPlanned = mergeUnique(treatmentPlanned, templateResult.treatment_planned);
  } else if (templateResult?.treatments_planned?.length) {
    treatmentPlanned = mergeUnique(treatmentPlanned, templateResult.treatments_planned);
  } else if (treatmentsPlanned.length > 0) {
    treatmentPlanned = mergeUnique(treatmentPlanned, treatmentsPlanned);
  }
  
  if (treatmentPlanned.length > 0) {
    treatmentPlanned.forEach(text => planActions.push({ text, field_type: 'treatment', timestamp: 0 }));
  } else if (storyPlan.treatment_discussed) {
    planActions.push({ text: 'None', field_type: 'treatment', timestamp: 0 });
  }

  // Add referrals
  const referralItems = filterArrayStrings(storyPlan.referrals);
  if (referralItems.length > 0) {
    referralItems.forEach(text => planActions.push({ text, field_type: 'referral', timestamp: 0 }));
  } else if (storyPlan.treatment_discussed) {
    planActions.push({ text: 'None', field_type: 'referral', timestamp: 0 });
  }

  // Add follow ups
  const followUp = filterArrayStrings(storyPlan.follow_up);
  followUp.forEach(text => planActions.push({ text, field_type: 'follow_up', timestamp: 0 }));

  // Anchor care barriers and administrative actions to this problem
  const adminIds = problem.treatment_instruction_ids || [];
  const entities = graph.clinical_entities || [];
  adminIds.forEach(id => {
    const e = entities.find(x => x.id === id);
    if (e && (e.entity_type === 'administrative_action' || e.clinical_role === 'care_barrier')) {
      planActions.push({ text: e.display_text, field_type: null, timestamp: e.earliest_transcript_timestamp || 0 });
    }
  });

  // Sort by timestamp if available, but keep standard fields first if no timestamp
  planActions.sort((a, b) => a.timestamp - b.timestamp);

  // narrative: from template (evidence/narrative for this problem's clinical detail)
  // NEVER add reasoning prose — only data from extracted facts
  let narrativeStrs = filterArrayStrings(storyPlan.narrative);
  const narrative = mergeUnique(
    templateResult?.narrative || templateResult?.evidence || [],
    narrativeStrs
  );

  // Certainty gate for the "Diagnosis:" line (template clause: "diagnosis explicitly
  // stated by the clinician... do not infer"). REQUIRE both:
  //   (a) the problem is backed by a true `diagnosis` entity — never a
  //       `clinical_impression` (e.g. "Weight loss management" must not emit a
  //       Diagnosis: line), and the entity is not negated; AND
  //   (b) certainty === 'confirmed'.
  const backedByDiagnosisEntity = [
    ...(problem.diagnosis_ids || []),
    ...(problem.entity_ids || []),
  ].some(id => {
    const e = (graph.clinical_entities || []).find(x => x.id === id);
    return e && e.entity_type === 'diagnosis'
      && !e.is_negative && e.clinical_role !== 'negative_finding' && e.certainty !== 'negated';
  });
  const isAdminProblem = /weight management|weight loss|medication refill|screening/i.test(issueName)
    || /weight management|weight loss|medication refill|screening|clinical_impression/i.test(problem.category || '');
  const emitDiagnosis = backedByDiagnosisEntity && certainty === 'confirmed' && !isAdminProblem;

  return {
    title: issueName,
    diagnosis: emitDiagnosis ? (problem.diagnosis || issueName) : null,
    certainty: certainty,
    narrative,
    plan_actions: planActions,
    treatment_discussed: storyPlan.treatment_discussed || false,
    problem_id: storyPlan.problem_id,
  };
}

export class AssessmentReasoner {
  static execute(graph) {
    const activeProblems = graph.active_problems || [];
    if (!graph.clinical_story) graph.clinical_story = {};
    if (!graph.clinical_story.assessment_plan) graph.clinical_story.assessment_plan = [];
    
    const storyPlans = graph.clinical_story.assessment_plan;
    
    // Scrub and actively re-attach medications across the entire problem list before building
    scrubAndReassignMedications(activeProblems, graph);

    const dispatchLog = {};
    const updatedPlans = [];

    activeProblems.forEach((problem, idx) => {
      // Gather and enrich facts for this problem to ensure equal depth
      // dispatch for GenericTemplate and specialized templates alike.
      gatherFactsForProblem(problem, graph);

      const group = detectSemanticGroup(problem);
      let templateResult = null;

      try {
        switch (group) {
          case 'DIABETES':          templateResult = DiabetesTemplate.execute(problem, graph); break;
          case 'ANEMIA':            templateResult = AnemiaTemplate.execute(problem, graph); break;
          case 'WEIGHT_MANAGEMENT': templateResult = WeightLossTemplate.execute(problem, graph); break;
          case 'DERMATOLOGY':       templateResult = DermatologyTemplate.execute(problem, graph); break;
          case 'MUSCULOSKELETAL':
          case 'ACUTE_INJURY':      templateResult = MusculoskeletalTemplate.execute(problem, graph); break;
          case 'MENTAL_HEALTH':     templateResult = MentalHealthTemplate.execute(problem, graph); break;
          case 'ADHD':              templateResult = ADHDTemplate.execute(problem, graph); break;
          case 'GYNECOLOGY':        templateResult = GynecologyTemplate.execute(problem, graph); break;
          case 'PEDIATRICS':        templateResult = PediatricsTemplate.execute(problem, graph); break;
          case 'MEDICATION':        templateResult = MedicationManagementTemplate.execute(problem, graph); break;
          default:                  templateResult = GenericTemplate.execute(problem, graph); break;
        }
        dispatchLog[problem.problem || problem.display_title] = group;
      } catch (e) {
        console.warn(`[AssessmentReasoner] Template failed for ${group}:`, e);
        dispatchLog[problem.problem || problem.display_title] = 'GENERIC (fallback)';
      }

      // Find matching entry in SlotFiller's assessment_plan (by title or index)
      let storyPlan = storyPlans[idx];
      const problemTitle = (problem.display_title || problem.problem || '').toLowerCase();
      
      if (!storyPlan || (storyPlan.title || '').toLowerCase() !== problemTitle) {
        const match = storyPlans.find(ap => (ap.title || '').toLowerCase() === problemTitle);
        if (match) {
          storyPlan = match;
        } else {
          // SlotFiller missed this problem — create a placeholder
          storyPlan = {
            title: problem.display_title || problem.problem,
            certainty: problem.certainty || 'suspected',
            problem_id: `P${String(idx + 1).padStart(3, '0')}`,
            narrative: [],
            investigations_planned: [],
            treatment_planned: [],
            referrals: [],
            follow_up: [],
            treatment_discussed: false,
          };
          storyPlans.push(storyPlan);
        }
      }

      // Build strict V31 6-field output — no reasoning prose added
      const builtPlan = buildProblemFields(problem, storyPlan, templateResult, graph);
      
      // Update storyPlan in-place
      Object.assign(storyPlan, builtPlan);
      updatedPlans.push(storyPlan);
    });

    graph.clinical_story.assessment_plan = updatedPlans;

    console.log('[AssessmentReasoner] Template dispatch map:', dispatchLog);
    graph._assessment_reasoner = { dispatch_log: dispatchLog };

    return graph;
  }
}
