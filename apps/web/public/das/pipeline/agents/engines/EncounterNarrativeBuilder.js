/**
 * EncounterNarrativeBuilder — DAS V25 ⭐ MOST IMPORTANT
 * DEPRECATED V26 — Replaced by ClinicalStoryLLMAgent (hybrid LLM narrative from transcript+graph).
 * TOMBSTONED: kept for DeterministicFallbackComposer. Do NOT call in active V26 pipeline.
 * Reads graph.clinical_entities + graph.active_problems and populates
 * graph.clinical_story.subjective with a structured narrative.
 *
 * This is the core "clinician cognition" layer that transforms fact lists
 * into clinical storytelling — the primary gap between DAS and Heidi.
 *
 * Output: graph.clinical_story (initialises the V25 data model)
 */

// Semantic group assignment rules — maps entity characteristics to groups
const SEMANTIC_GROUP_RULES = [
  { keywords: ['diabetes', 'a1c', 'glucose', 'insulin', 'metformin', 'ozempic', 'wegovy', 'hba1c'], group: 'DIABETES' },
  { keywords: ['anemia', 'anaemia', 'hemoglobin', 'haemoglobin', 'iron', 'ferritin', 'b12', 'folate'], group: 'ANEMIA' },
  { keywords: ['hypertension', 'blood pressure', 'bp', 'lisinopril', 'amlodipine', 'ramipril'], group: 'HYPERTENSION' },
  { keywords: ['lipid', 'cholesterol', 'ldl', 'hdl', 'statin', 'rosuvastatin', 'atorvastatin', 'triglyceride'], group: 'LIPIDS' },
  { keywords: ['weight', 'bmi', 'obesity', 'wegovy', 'ozempic', 'zepbound', 'semaglutide'], group: 'WEIGHT_MANAGEMENT' },
  { keywords: ['fall', 'fracture', 'sprain', 'injury', 'trauma', 'laceration', 'bruise', 'twist'], group: 'ACUTE_INJURY' },
  { keywords: ['knee', 'hip', 'back', 'shoulder', 'wrist', 'elbow', 'ankle', 'foot', 'musculoskeletal', 'arthritis', 'osteoarthritis'], group: 'MUSCULOSKELETAL' },
  { keywords: ['depression', 'anxiety', 'adhd', 'bipolar', 'schizophrenia', 'mental health', 'mood', 'psychiatric'], group: 'MENTAL_HEALTH' },
  { keywords: ['thyroid', 'tsh', 'hypothyroid', 'hyperthyroid', 'levothyroxine'], group: 'THYROID' },
  { keywords: ['skin', 'rash', 'lesion', 'eczema', 'psoriasis', 'dermatitis', 'acne'], group: 'DERMATOLOGY' },
];

function assignSemanticGroup(entity) {
  if (entity.semantic_group) return; // already assigned
  const text = ((entity.display_text || '') + ' ' + (entity.canonical_name || '')).toLowerCase();
  for (const rule of SEMANTIC_GROUP_RULES) {
    if (rule.keywords.some(kw => text.includes(kw))) {
      entity.semantic_group = rule.group;
      return;
    }
  }
  entity.semantic_group = 'GENERAL';
}

// Reason for Visit priority — picks the best entity as chief complaint
const RFV_PRIORITY = ['symptom', 'diagnosis', 'medication', 'follow_up', 'administrative'];

function selectReasonForVisit(entities) {
  // Sort by clinical role priority
  const active = entities.filter(e =>
    e.clinical_role === 'active_problem' ||
    e.temporality === 'current' ||
    e.clinical_priority === 'critical' ||
    e.clinical_priority === 'high'
  );

  for (const type of RFV_PRIORITY) {
    const match = active.find(e => e.entity_type === type);
    if (match) {
      const text = match.canonical_name || match.display_text || '';
      // Never use administrative text as chief complaint
      if (type === 'administrative') return 'Follow-up visit';
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }

  // Fallback to encounter type
  return null;
}

// Build HPI story sentences from temporal events + current symptoms
function buildHPISentences(entities) {
  const sentences = [];

  // 1. Extract temporal events (onset, mechanism, date)
  const temporalEvents = entities.filter(e =>
    e.entity_type === 'temporal_event' ||
    (e.entity_type === 'symptom' && e.onset) ||
    (e.entity_type === 'symptom' && e.temporal_qualifier)
  );

  temporalEvents.forEach(e => {
    const text = e.display_text || e.canonical_name;
    if (!text) return;
    const cap = text.charAt(0).toUpperCase() + text.slice(1);
    if (!cap.endsWith('.')) sentences.push(cap + '.');
    else sentences.push(cap);
    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes('SUBJECTIVE_HPI')) e.represented_by.push('SUBJECTIVE_HPI');
  });

  // 2. Active current symptoms (excluding those already captured)
  const currentSymptoms = entities.filter(e =>
    e.entity_type === 'symptom' &&
    (e.temporality === 'current' || !e.temporality) &&
    e.clinical_role !== 'negative_finding' &&
    e.clinical_role !== 'past_history' &&
    !temporalEvents.includes(e)
  );

  currentSymptoms.forEach(e => {
    let sentence = e.display_text || e.canonical_name || '';
    if (!sentence) return;

    // Add body site if not already in the text
    if (e.body_site && !sentence.toLowerCase().includes(e.body_site.toLowerCase())) {
      sentence = `${e.body_site} ${sentence}`;
    }
    // Add laterality
    if (e.laterality && !sentence.toLowerCase().includes(e.laterality.toLowerCase())) {
      sentence = `${e.laterality} ${sentence}`;
    }
    // Add symptom characteristic
    if (e.symptom_characteristic) {
      sentence += ` — ${e.symptom_characteristic}`;
    }
    // Add progression
    if (e.progression) {
      const progressionMap = {
        worsening: 'has been worsening',
        worsened: 'has worsened',
        resolved: 'has resolved',
        persistent: 'persists',
        improving: 'is improving',
        improved: 'has improved',
        stable: 'remains stable',
        unchanged: 'is unchanged',
      };
      const prog = progressionMap[e.progression?.toLowerCase()];
      if (prog) sentence += ` — ${prog}`;
    }

    const cap = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    sentences.push(cap.endsWith('.') ? cap : cap + '.');
    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes('SUBJECTIVE_HPI')) e.represented_by.push('SUBJECTIVE_HPI');
  });

  return sentences;
}

// Build associated symptoms list
function buildAssociatedSymptoms(entities) {
  return entities
    .filter(e =>
      e.entity_type === 'symptom' &&
      e.clinical_role !== 'active_problem' &&
      e.clinical_role !== 'negative_finding' &&
      e.clinical_role !== 'past_history' &&
      (e.clinical_priority === 'medium' || e.clinical_priority === 'low' || !e.clinical_priority)
    )
    .map(e => {
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('SUBJECTIVE_ASSOCIATED')) e.represented_by.push('SUBJECTIVE_ASSOCIATED');
      return e.display_text || e.canonical_name || '';
    })
    .filter(Boolean);
}

// Build disease management context (existing treatment before this visit)
function buildDiseaseManagement(entities) {
  const mgmt = [];

  // Historical/ongoing medications used for disease management
  entities
    .filter(e =>
      e.entity_type === 'medication' &&
      (e.temporality === 'current' || e.temporality === 'historical') &&
      e.action !== 'start' // "start" goes to Plan, not Disease Management
    )
    .forEach(e => {
      let line = e.medication || e.canonical_name || e.display_text || '';
      if (e.dose) line += ` ${e.dose}`;
      if (e.frequency) line += ` ${e.frequency}`;
      if (e.tolerance) line += ` — ${e.tolerance}`;
      if (line) mgmt.push(line.trim());
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('SUBJECTIVE_DISEASE_MGT')) e.represented_by.push('SUBJECTIVE_DISEASE_MGT');
    });

  return mgmt;
}

// Build negatives list
function buildNegatives(entities) {
  return entities
    .filter(e => e.clinical_role === 'negative_finding' || e.entity_type === 'negative_finding')
    .map(e => {
      const text = e.display_text || e.canonical_name || '';
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('SUBJECTIVE_NEGATIVES')) e.represented_by.push('SUBJECTIVE_NEGATIVES');
      // Strip double-negatives like "No no pain"
      return text.replace(/^no no /i, 'No ').replace(/^denies denies /i, 'Denies ');
    })
    .filter(Boolean);
}

// Build PMH sections
function buildPMH(entities) {
  const pmh = {
    medical_history: [],
    surgical_history: [],
    family_history: [],
    social_history: [],
    exposure_history: [],
    immunization_history: [],
  };

  entities.forEach(e => {
    const text = e.display_text || e.canonical_name || '';
    if (!text) return;
    const tag = 'PMH';
    e.represented_by = e.represented_by || [];

    if (e.entity_type === 'pmh' || (e.entity_type === 'diagnosis' && e.clinical_role === 'past_history')) {
      if (e.entity_type === 'surgical_history' || (e.display_text || '').toLowerCase().includes('surg')) {
        pmh.surgical_history.push(text);
      } else {
        pmh.medical_history.push(text);
      }
      e.represented_by.push('PMH_MEDICAL');
    } else if (e.entity_type === 'family_history') {
      pmh.family_history.push(text);
      e.represented_by.push('PMH_FAMILY');
    } else if (e.entity_type === 'social_history') {
      pmh.social_history.push(text);
      e.represented_by.push('PMH_SOCIAL');
    } else if (e.entity_type === 'exposure_history') {
      pmh.exposure_history.push(text);
      e.represented_by.push('PMH_EXPOSURE');
    } else if (e.entity_type === 'immunization' || e.entity_type === 'immunisation') {
      pmh.immunization_history.push(text);
      e.represented_by.push('PMH_IMMUNIZATION');
    }
  });

  return pmh;
}

// Build objective section
function buildObjective(graph) {
  const entities = graph.clinical_entities || [];
  const objective = {
    vitals: [],
    labs: [],
    physical_exam: [],
    imaging_results: [],
    normal_findings: [],
  };

  // Vitals from numeric_data (non-aggregated)
  (graph.numeric_data || []).forEach(n => {
    if (n.render_status === 'aggregated') return;
    const isVital = ['BP', 'WEIGHT', 'BMI', 'HR', 'TEMP', 'SAT', 'RR'].some(v =>
      (n.test_name || '').toUpperCase().includes(v)
    );
    const entry = {
      label: n.test_name,
      value: n.value,
      unit: n.unit,
      trend_narrative: n.trend_narrative,
      represented_by_key: (n.represented_by || [])[0] || null,
    };
    n.represented_by = n.represented_by || [];
    if (!n.represented_by.includes('OBJECTIVE_VITALS')) n.represented_by.push('OBJECTIVE_VITALS');
    if (isVital) {
      objective.vitals.push(entry);
    } else {
      objective.labs.push(entry);
    }
  });

  // Physical exam entities
  entities
    .filter(e => e.entity_type === 'physical_exam')
    .forEach(e => {
      const text = e.display_text || e.canonical_name || '';
      if (!text) return;
      objective.physical_exam.push(text);
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('OBJECTIVE_EXAM')) e.represented_by.push('OBJECTIVE_EXAM');
    });

  // Completed investigations (not planned/ordered)
  entities
    .filter(e =>
      e.entity_type === 'investigation' &&
      (e.status === 'reviewed' || e.status === 'completed' || e.status === 'historical')
    )
    .forEach(e => {
      const text = e.display_text || e.canonical_name || '';
      if (!text) return;
      objective.labs.push({ label: text, value: e.result || null, unit: null, trend_narrative: null });
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('OBJECTIVE_LABS')) e.represented_by.push('OBJECTIVE_LABS');
    });

  // Normal findings
  entities
    .filter(e => e.entity_type === 'normal_finding')
    .forEach(e => {
      const text = e.display_text || e.canonical_name || '';
      if (!text) return;
      objective.normal_findings.push(text);
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('OBJECTIVE_NORMAL')) e.represented_by.push('OBJECTIVE_NORMAL');
    });

  return objective;
}

export class EncounterNarrativeBuilder {
  static execute(graph) {
    const entities = graph.clinical_entities || [];

    // Step 1: assign semantic groups to all entities
    entities.forEach(e => assignSemanticGroup(e));

    // Step 2: initialise clinical_story if not already present
    if (!graph.clinical_story) {
      graph.clinical_story = {
        subjective: {
          reason_for_visit: '',
          history_presenting_illness: [],
          symptom_characteristics: [],
          symptom_modifiers: [],
          symptom_progression: [],
          associated_symptoms: [],
          disease_management: [],
          negatives: [],
        },
        pmh: {
          medical_history: [],
          surgical_history: [],
          family_history: [],
          social_history: [],
          exposure_history: [],
          immunization_history: [],
        },
        objective: {
          vitals: [],
          labs: [],
          physical_exam: [],
          imaging_results: [],
          normal_findings: [],
        },
        assessment_plan: [],
      };
    }

    const story = graph.clinical_story;

    // Step 3: Reason for Visit
    story.subjective.reason_for_visit =
      graph.reason_for_visit ||
      selectReasonForVisit(entities) ||
      '';

    // Step 4: History of Presenting Illness (basic — HPIComposer enriches further)
    story.subjective.history_presenting_illness = buildHPISentences(entities);

    // Step 5: Associated symptoms
    story.subjective.associated_symptoms = buildAssociatedSymptoms(entities);

    // Step 6: Disease management
    story.subjective.disease_management = buildDiseaseManagement(entities);

    // Step 7: Negatives
    story.subjective.negatives = buildNegatives(entities);

    // Step 8: PMH
    story.pmh = buildPMH(entities);

    // Step 9: Objective
    story.objective = buildObjective(graph);

    // Step 10: Scaffold assessment_plan from active_problems (content filled by AssessmentComposer)
    const problems = graph.active_problems || [];
    story.assessment_plan = problems.map(p => ({
      diagnosis: p.problem || '',
      evidence: [],
      clinical_course: p.clinical_course || '',
      differential: p.differentials || [],
      recommendations: [],
      investigations_planned: [],
      treatments_planned: [],
      referrals: [],
      follow_ups: [],
      _problem_ref: p, // internal link for AssessmentComposer
    }));

    return graph;
  }
}
