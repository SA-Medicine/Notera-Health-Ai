/**
 * ProblemGeneratorEngine — DAS V30 ⭐⭐⭐⭐⭐
 *
 * Auto-detects implicit clinical problems from entity signal combinations.
 *
 * ProblemGraphBuilder creates problems only from explicit diagnosis entities.
 * ProblemGeneratorEngine creates problems from clinical signals — the same
 * reasoning a clinician applies: "PSA declined + family history → this patient
 * needs a Prostate cancer screening problem."
 *
 * All 10 rule families implemented (V30 Phase 1 — approved).
 *
 * Output: appends to graph.active_problems[] with:
 *   {
 *     problem: string,
 *     category: string,
 *     confidence: number (0.0–1.0),
 *     generator_rule: string,
 *     auto_generated: true,
 *     entity_ids: string[],   ← IDs of entities that triggered this rule
 *     semantic_group: string
 *   }
 *
 * Rules:
 *   1.  psa_screening        — PSA mention or prostate family history
 *   2.  trauma_injury        — trauma entity + pain in same/adjacent body site
 *   3.  derm_medication      — biologic/immunosuppressant + dermatologic condition
 *   4.  anemia               — Hb/ferritin/iron entities or low numeric Hb
 *   5.  weight_management    — BMI entity or weight loss medications
 *   6.  preventive_care      — vaccination, screening, pap smear, colonoscopy
 *   7.  diabetes             — A1c/glucose entities without explicit DM diagnosis
 *   8.  lipids               — cholesterol/LDL/statin without explicit diagnosis
 *   9.  hypertension         — BP entity or antihypertensive without explicit HTN dx
 *   10. mental_health        — mood/anxiety/depression/ADHD entities
 */

// ── Utility helpers ─────────────────────────────────────────────────────────

function entityText(e) {
  return ((e.display_text || '') + ' ' + (e.canonical_name || '') + ' ' + (e.source_quote || '')).toLowerCase();
}

function matchesKeywords(text, keywords) {
  return keywords.some(kw => text.includes(kw));
}

function findEntities(entities, keywords, types = []) {
  return entities.filter(e => {
    if (e.is_negative === true || e.clinical_role === 'negative_finding' || e.certainty === 'negated') return false;
    const text = entityText(e);
    const typeOk = types.length === 0 || types.includes(e.entity_type);
    return typeOk && matchesKeywords(text, keywords);
  });
}

function findNumerics(numerics, labelKeywords) {
  return numerics.filter(n => {
    const label = (n.test_name || '').toLowerCase();
    return labelKeywords.some(kw => label.includes(kw));
  });
}

function problemExists(activeProblems, problemName) {
  const nameLower = problemName.toLowerCase();
  return activeProblems.some(p => {
    const existingLower = (p.problem || '').toLowerCase();
    return existingLower === nameLower ||
      existingLower.includes(nameLower) ||
      nameLower.includes(existingLower);
  });
}

function makeProblem(name, category, confidence, rule, entityIds, semanticGroup) {
  return {
    problem: name,
    category,
    confidence,
    generator_rule: rule,
    auto_generated: true,
    entity_ids: entityIds,
    semantic_group: semanticGroup,
    diagnosis_ids: [],
    symptom_ids:   [],
    medication_ids:[],
    investigation_ids:[],
    referral_ids:  [],
    followup_ids:  [],
    treatment_ids: [],
    treatment_instruction_ids: [],
  };
}

// ── Rule implementations ─────────────────────────────────────────────────────

/** Rule 1: PSA/Prostate cancer screening */
function rulePSAScreening(entities, _numerics, activeProblems) {
  const psaEntities = findEntities(entities, ['psa', 'prostate-specific antigen']);
  const prostateHistory = findEntities(entities,
    ['prostate cancer', 'prostate carcinoma'],
    ['family_history', 'pmh']
  );

  if (psaEntities.length === 0 && prostateHistory.length === 0) return null;
  if (problemExists(activeProblems, 'Prostate cancer screening')) return null;

  const confidence = psaEntities.length > 0 ? 0.95 : 0.75;
  const ids = [...psaEntities, ...prostateHistory].map(e => e.id).filter(Boolean);

  return makeProblem(
    'Prostate cancer screening',
    'screening',
    confidence,
    'psa_screening',
    ids,
    'SCREENING'
  );
}

/** Rule 2: Trauma + pain → injury problem */
function ruleTraumaInjury(entities, _numerics, activeProblems) {
  const INJURY_KEYWORDS = ['fall', 'fell', 'trauma', 'injury', 'fracture', 'sprain',
    'twist', 'twisted', 'laceration', 'struck', 'impact', 'collision', 'accident'];
  const PAIN_KEYWORDS = ['pain', 'ache', 'discomfort', 'tenderness', 'sore'];

  const traumaEntities = findEntities(entities, INJURY_KEYWORDS,
    ['symptom', 'temporal_event', 'diagnosis', 'administrative']);
  const painEntities = findEntities(entities, PAIN_KEYWORDS, ['symptom']);

  if (traumaEntities.length === 0 || painEntities.length === 0) return null;

  // Determine body site from pain entity
  const painEntity = painEntities[0];
  const site = painEntity.body_site || painEntity.laterality
    ? `${painEntity.laterality || ''} ${painEntity.body_site || ''}`.trim()
    : 'post-traumatic';

  const problemName = site && site !== 'post-traumatic'
    ? `${site.charAt(0).toUpperCase() + site.slice(1)} pain post-injury`
    : 'Post-traumatic pain';

  if (problemExists(activeProblems, problemName)) return null;
  if (problemExists(activeProblems, 'musculoskeletal') ||
      problemExists(activeProblems, 'injury') ||
      problemExists(activeProblems, 'pain')) {
    // Don't duplicate if a musculoskeletal/injury problem already exists
    return null;
  }

  const ids = [...traumaEntities, ...painEntities].map(e => e.id).filter(Boolean);
  return makeProblem(problemName, 'injury', 0.90, 'trauma_injury', ids, 'ACUTE_INJURY');
}

/** Rule 3: Dermatology + biologic/immunosuppressant → medication management */
function ruleDermMedication(entities, _numerics, activeProblems) {
  const DERM_KEYWORDS = ['psoriasis', 'eczema', 'dermatitis', 'atopic', 'plaque', 'skin condition'];
  const BIOLOGIC_KEYWORDS = ['ilumya', 'humira', 'tremfya', 'skyrizi', 'cosentyx',
    'taltz', 'biologics', 'dupixent', 'adalimumab', 'secukinumab', 'tildrakizumab',
    'risankizumab', 'ixekizumab', 'ustekinumab'];

  const dermEntities = findEntities(entities, DERM_KEYWORDS);
  const biologicEntities = findEntities(entities, BIOLOGIC_KEYWORDS, ['medication', 'medication_order']);

  if (dermEntities.length === 0 || biologicEntities.length === 0) return null;

  const condition = dermEntities[0];
  const conditionName = condition.canonical_name || condition.display_text || 'Dermatological condition';

  if (problemExists(activeProblems, conditionName)) return null;

  const ids = [...dermEntities, ...biologicEntities].map(e => e.id).filter(Boolean);
  return makeProblem(
    conditionName.charAt(0).toUpperCase() + conditionName.slice(1),
    'medication_management',
    0.90,
    'derm_medication',
    ids,
    'DERMATOLOGY'
  );
}

/** Rule 4: Anaemia */
function ruleAnemia(entities, numerics, activeProblems) {
  if (problemExists(activeProblems, 'anaemia') || problemExists(activeProblems, 'anemia')) return null;

  // Real anaemia requires: an explicit anaemia diagnosis, an iron-deficiency finding, OR a
  // genuinely LOW haemoglobin value. CRITICAL: only count a numeric whose test name is
  // actually haemoglobin (not "HbA1c" — 'hb' must not substring-match A1c), and only when
  // the value is in the haemoglobin range and low. A normal/pristine iron panel is NOT anaemia.
  const dx = explicitDx(entities, ['anaemia', 'anemia']);
  const ironDef = findEntities(entities, ['iron deficiency', 'iron-deficiency', 'ferritin', 'low iron'])
    .filter(e => /\b(low|deficien)/i.test(entityText(e)));
  const hbNumerics = (numerics || []).filter(n => /h(a)?emoglobin|\bhgb\b/i.test(n.test_name || ''));
  const lowHb = hbNumerics.some(n => { const v = parseFloat(n.value); return !isNaN(v) && v >= 40 && v < 120; });

  if (dx.length === 0 && ironDef.length === 0 && !lowHb) return null;

  const ids = [...dx, ...ironDef].map(e => e.id).filter(Boolean);
  const name = ironDef.length > 0 ? 'Iron deficiency anaemia' : 'Anaemia';
  return makeProblem(name, 'chronic_disease', 0.95, 'anemia', ids, 'ANEMIA');
}

/** Rule 5: Weight management */
function ruleWeightManagement(entities, numerics, activeProblems) {
  if (problemExists(activeProblems, 'weight') || problemExists(activeProblems, 'obesity')) return null;

  const WEIGHT_MED_KEYWORDS = ['ozempic', 'wegovy', 'saxenda', 'zepbound', 'mounjaro',
    'semaglutide', 'tirzepatide', 'liraglutide', 'orlistat', 'contrave'];
  const WEIGHT_ENTITY_KEYWORDS = ['obesity', 'overweight', 'weight management', 'bariatric'];

  // Only consider active engagement for meds: must be medication_order or medication_active
  const weightMedEntities = entities.filter(e => {
    if (e.is_negative === true || e.clinical_role === 'negative_finding' || e.certainty === 'negated') return false;
    // Strict adherence to user instruction: only medication_order or medication_active counts
    if (e.entity_type !== 'medication_order' && e.entity_type !== 'medication_active' && e.entity_type !== 'treatment') return false;
    const text = entityText(e);
    return WEIGHT_MED_KEYWORDS.some(m => text.includes(m));
  });

  const weightEntities = findEntities(entities, WEIGHT_ENTITY_KEYWORDS);

  // We only trigger if there is ACTIVE engagement (medication ordered/active or explicit weight entities)
  // Mere BMI or mere mention of ozempic in passing doesn't count.
  const activeEngagement = weightMedEntities.length > 0 || weightEntities.length > 0;
  
  if (!activeEngagement) return null;

  const ids = [...weightEntities, ...weightMedEntities].map(e => e.id).filter(Boolean);
  return makeProblem('Weight management', 'chronic_disease', 0.90, 'weight_management', ids, 'WEIGHT_MANAGEMENT');
}

/** Rule 5b: Psoriasis */
function rulePsoriasis(entities, numerics, activeProblems) {
  if (problemExists(activeProblems, 'psoriasis')) return null;

  // Known psoriasis biologics and common transcript phonetic misspellings
  const PSORIASIS_MEDS = [
    'ilumya', 'alumnia', 'baricitinib', 'zoryve', 'zrint', 'vtama',
    'otezla', 'tremfya', 'skyrizi', 'cosentyx', 'taltz', 'siliq'
  ];
  
  // Use explicit denial guard on the meds
  const meds = entities.filter(e => {
    if (e.is_negative === true || e.clinical_role === 'negative_finding' || e.certainty === 'negated') return false;
    const text = entityText(e);
    return PSORIASIS_MEDS.some(m => text.includes(m));
  });

  const dermKeywords = ['psoriasis', 'plaque', 'skin'];
  const dermEntities = findEntities(entities, dermKeywords);

  if (meds.length === 0 && findEntities(entities, ['psoriasis']).length === 0) return null;
  
  // Aggressively pull in duration or characteristic facts for the narrative
  const durationFacts = entities.filter(e => {
    if (e.category === 'duration' || e.category === 'symptom_characteristic') {
       const text = entityText(e);
       // If it mentions skin/psoriasis, or if it's highly likely to be the psoriasis duration
       if (/(psoriasis|skin|plaque|rash|itch|year|month|week)/i.test(text)) {
         return true;
       }
    }
    return false;
  });

  const ids = [...meds, ...dermEntities, ...durationFacts].map(e => e.id).filter(Boolean);
  return makeProblem('Psoriasis', 'dermatology', 0.90, 'psoriasis', ids, 'DERMATOLOGY');
}

/** Rule 6: Preventive care */
function rulePreventiveCare(entities, _numerics, activeProblems) {
  const PREVENTIVE_KEYWORDS = ['vaccination', 'vaccine', 'immunisation', 'immunization',
    'pap smear', 'pap test', 'cervical screen', 'colonoscopy', 'mammogram',
    'mammography', 'bone density', 'dexa', 'preventive', 'preventative', 'flu shot', 'booster'];

  const preventiveEntities = findEntities(entities, PREVENTIVE_KEYWORDS,
    ['administrative', 'follow_up', 'investigation', 'order', 'immunization']);

  if (preventiveEntities.length === 0) return null;

  // Group into specific preventive items rather than one catch-all
  // For simplicity, create one "Preventive care" problem
  if (problemExists(activeProblems, 'Preventive care')) return null;

  const ids = preventiveEntities.map(e => e.id).filter(Boolean);
  return makeProblem('Preventive care', 'preventive_care', 0.85, 'preventive_care', ids, 'PREVENTIVE');
}

/** Rule 7: Diabetes (ensure problem exists if A1c/glucose entities present) */
// A diagnosis/active-problem entity (not a normal lab, not a passing mention) for a topic.
function explicitDx(entities, keywords) {
  return findEntities(entities, keywords).filter(e =>
    (e.entity_type === 'diagnosis' || e.clinical_role === 'active_problem') &&
    !/\b(normal|fine|good|stable|unremarkable|negative)\b/i.test(e.display_text || e.canonical_name || ''));
}

function ruleDiabetes(entities, numerics, activeProblems) {
  if (problemExists(activeProblems, 'diabetes')) return null;
  // Real diabetes requires: an explicit diagnosis, OR a specific glucose-lowering med
  // (NOT GLP-1s, which are also weight-loss), OR a diabetic-range A1c (>= 6.5). A normal
  // glucose reviewed in passing must NOT create a diabetes problem.
  const dx = explicitDx(entities, ['diabetes', 'diabetic']);
  const dmMeds = findEntities(entities,
    ['metformin', 'insulin', 'glipizide', 'gliclazide', 'glimepiride', 'jardiance', 'empagliflozin', 'farxiga', 'dapagliflozin', 'januvia', 'sitagliptin', 'glyburide'],
    ['medication', 'medication_order']);
  const highA1c = findNumerics(numerics, ['a1c', 'hba1c', 'haemoglobin a1c']).some(n => parseFloat(n.value) >= 6.5);
  if (dx.length === 0 && dmMeds.length === 0 && !highA1c) return null;

  const ids = [...dx, ...dmMeds].map(e => e.id).filter(Boolean);
  return makeProblem('Diabetes mellitus', 'chronic_disease', 0.95, 'diabetes', ids, 'DIABETES');
}

/** Rule 8: Lipids — only with an explicit diagnosis or a lipid-lowering medication. */
function ruleLipids(entities, numerics, activeProblems) {
  if (problemExists(activeProblems, 'lipid') ||
      problemExists(activeProblems, 'cholesterol') ||
      problemExists(activeProblems, 'dyslipidaemia') ||
      problemExists(activeProblems, 'dyslipidemia')) return null;

  // A normal/reviewed cholesterol panel is NOT a problem — require a stated diagnosis or a
  // statin/lipid medication being managed.
  const dx = explicitDx(entities, ['hyperlipid', 'dyslipid', 'high cholesterol', 'hypercholesterol']);
  const lipidMeds = findEntities(entities,
    ['statin', 'rosuvastatin', 'atorvastatin', 'simvastatin', 'pravastatin', 'crestor', 'lipitor', 'ezetimibe'],
    ['medication', 'medication_order']);
  if (dx.length === 0 && lipidMeds.length === 0) return null;

  const ids = [...dx, ...lipidMeds].map(e => e.id).filter(Boolean);
  return makeProblem('Hyperlipidaemia', 'chronic_disease', 0.90, 'lipids', ids, 'LIPIDS');
}

/** Rule 9: Hypertension — only with an explicit diagnosis or an antihypertensive med. */
function ruleHypertension(entities, numerics, activeProblems) {
  if (problemExists(activeProblems, 'hypertension') ||
      problemExists(activeProblems, 'blood pressure')) return null;

  // A single BP reading (most encounters measure BP) is NOT hypertension — require a stated
  // diagnosis or an antihypertensive medication.
  const dx = explicitDx(entities, ['hypertension', 'htn', 'high blood pressure']);
  const htnMeds = findEntities(entities,
    ['lisinopril', 'amlodipine', 'ramipril', 'perindopril', 'valsartan', 'losartan', 'candesartan', 'metoprolol', 'bisoprolol', 'hydrochlorothiazide', 'indapamide'],
    ['medication', 'medication_order']);
  if (dx.length === 0 && htnMeds.length === 0) return null;

  const ids = [...dx, ...htnMeds].map(e => e.id).filter(Boolean);
  return makeProblem('Hypertension', 'chronic_disease', 0.90, 'hypertension', ids, 'HYPERTENSION');
}

/** Rule 10: Mental health / ADHD */
function ruleMentalHealth(entities, _numerics, activeProblems) {
  const MENTAL_KEYWORDS = ['depression', 'anxiety', 'adhd', 'attention deficit',
    'bipolar', 'schizophrenia', 'ptsd', 'ocd', 'mood', 'psychiatric',
    'sertraline', 'fluoxetine', 'escitalopram', 'venlafaxine', 'quetiapine',
    'methylphenidate', 'amphetamine', 'ritalin', 'concerta', 'adderall', 'vyvanse',
    'mental health', 'psychological'];

  const ADHD_KEYWORDS = ['adhd', 'attention deficit', 'methylphenidate', 'amphetamine',
    'ritalin', 'concerta', 'adderall', 'vyvanse', 'strattera', 'atomoxetine'];

  const mhEntities = findEntities(entities, MENTAL_KEYWORDS);
  if (mhEntities.length === 0) return null;

  // Determine if ADHD-specific or general mental health
  const hasADHD = findEntities(entities, ADHD_KEYWORDS).length > 0;

  if (hasADHD) {
    if (problemExists(activeProblems, 'adhd') || problemExists(activeProblems, 'attention')) return null;
    const ids = findEntities(entities, ADHD_KEYWORDS).map(e => e.id).filter(Boolean);
    return makeProblem('ADHD', 'chronic_disease', 0.90, 'mental_health_adhd', ids, 'ADHD');
  }

  // Check if any specific mental health problem already exists
  const specificProblems = ['depression', 'anxiety', 'bipolar', 'ptsd'];
  const alreadyExists = specificProblems.some(p => problemExists(activeProblems, p));
  if (alreadyExists) return null;

  if (problemExists(activeProblems, 'mental health')) return null;

  const ids = mhEntities.map(e => e.id).filter(Boolean);
  // Try to name it specifically
  const depressionEntities = findEntities(entities, ['depression', 'depressed']);
  const anxietyEntities = findEntities(entities, ['anxiety', 'anxious', 'panic']);

  let name = 'Mental health';
  let group = 'MENTAL_HEALTH';
  if (depressionEntities.length > 0 && anxietyEntities.length > 0) {
    name = 'Depression and anxiety';
  } else if (depressionEntities.length > 0) {
    name = 'Depression';
  } else if (anxietyEntities.length > 0) {
    name = 'Anxiety';
  }

  return makeProblem(name, 'chronic_disease', 0.85, 'mental_health', ids, group);
}

// ── Main engine ──────────────────────────────────────────────────────────────

const RULES = [
  ruleDiabetes,          // Most common — run first
  ruleHypertension,
  ruleLipids,
  ruleAnemia,
  ruleWeightManagement,
  ruleMentalHealth,
  rulePSAScreening,
  ruleTraumaInjury,
  ruleDermMedication,
  rulePsoriasis,
  rulePreventiveCare,
];

export class ProblemGeneratorEngine {
  static execute(graph) {
    const entities = graph.clinical_entities || [];
    const numerics = graph.numeric_data || [];
    const activeProblems = graph.active_problems || [];

    let generated = 0;

    for (const ruleFn of RULES) {
      try {
        const newProblem = ruleFn(entities, numerics, activeProblems);
        if (newProblem) {
          activeProblems.push(newProblem);
          generated++;
          console.log(
            `[ProblemGeneratorEngine] Auto-created: "${newProblem.problem}"`,
            `(rule: ${newProblem.generator_rule}, confidence: ${newProblem.confidence})`
          );
        }
      } catch (err) {
        console.warn(`[ProblemGeneratorEngine] Rule failed: ${ruleFn.name}`, err);
      }
    }

    const PRIORITY = {
      chronic_disease: 1,        // Diabetes, HTN, Lipids
      screening: 2,              // PSA, Colonoscopy
      acute_issue: 3,            // Injury, pain, acute illness
      injury: 3,
      dermatology: 4,            // Psoriasis
      medication_management: 4,
      preventive_care: 5,
      symptom_cluster: 6,
      procedure_followup: 7,
      default: 8
    };

    // Filter and enrich problems according to V30 Heidi rules
    let enrichedProblems = [];
    for (const p of activeProblems) {
      p.display_title = p.problem.charAt(0).toUpperCase() + p.problem.slice(1);
      p.render_style = "heidi";

      if (p.auto_generated) {
        if (p.confidence < 0.8) {
          p.render = false;
        } else {
          // Diagnosis exists OR >=2 supporting OR has_order OR has_followup
          const hasDiagnosis = (p.diagnosis_ids && p.diagnosis_ids.length > 0) || 
                               (p.entity_ids && p.entity_ids.some(id => {
                                 const ent = entities.find(e => e.id === id);
                                 return ent && ent.entity_type === 'diagnosis';
                               }));
          const supportingCount = (p.entity_ids || []).length;
          
          const hasOrder = p.entity_ids && p.entity_ids.some(id => {
             const ent = entities.find(e => e.id === id);
             return ent && ['investigation', 'referral', 'medication_order'].includes(ent.entity_type);
          });
          const hasFollowup = p.entity_ids && p.entity_ids.some(id => {
             const ent = entities.find(e => e.id === id);
             return ent && ent.entity_type === 'follow_up';
          });
          
          // A high-confidence rule match IS the encounter's primary problem (e.g.
          // "Weight management" for a weight_loss visit) — render it even with few
          // linked entities. Rule-based problems are deterministic, not hallucinated.
          p.render = hasDiagnosis || supportingCount >= 1 || hasOrder || hasFollowup || p.confidence >= 0.9;
        }
      } else {
        p.render = true;
      }
      enrichedProblems.push(p);
    }

    // Suppress generic problems by marking render = false
    enrichedProblems.forEach(p1 => {
      if (!p1.render) return;
      const name1 = p1.problem.toLowerCase();
      const isGeneric = enrichedProblems.some(p2 => {
        if (!p2.render || p1 === p2) return false;
        const name2 = p2.problem.toLowerCase();
        return name2 !== name1 && name2.includes(name1);
      });
      if (isGeneric) p1.render = false;
    });

    let finalProblems = enrichedProblems.filter(p => p.render);

    // Sort by PRIORITY
    finalProblems.sort((a, b) => {
      const prioA = PRIORITY[a.category] || PRIORITY['default'];
      const prioB = PRIORITY[b.category] || PRIORITY['default'];
      return prioA - prioB;
    });

    graph.active_problems = finalProblems;
    graph._problem_generator = {
      auto_generated_count: generated,
      total_problems: finalProblems.length,
    };

    console.log(`[ProblemGeneratorEngine] ${generated} problem(s) auto-generated. Total after filtering: ${finalProblems.length}`);
    return graph;
  }
}
