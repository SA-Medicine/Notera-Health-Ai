/**
 * ProblemGraphBuilder — DAS V31
 *
 * Builds the active problem list from extracted entities.
 *
 * V31 changes:
 *   1. Adds `certainty` field per problem (confirmed | suspected | rule_out)
 *   2. mergeDifferentialsByBodyRegion(): groups suspected/rule_out diagnoses
 *      sharing a body region into one combined Heidi-style problem title.
 *   3. sortByTranscriptOrder(): problems appear in transcript first-mention order
 *      (NOT clinical priority order).
 */

/**
 * Parse "M:SS" timestamp strings → total seconds.
 */
function parseTimestamp(ts = '0:00') {
  const parts = String(ts).split(':').map(Number);
  if (parts.length === 2) return (parts[0] * 60) + (parts[1] || 0);
  if (parts.length === 1) return parts[0] || 0;
  return 0;
}

/**
 * Format region label for Heidi-style title.
 * E.g. "right hip" → "Right hip/leg", "left knee" → "Left knee"
 */
function formatRegionLabel(site) {
  const s = site.toLowerCase();
  if (s.includes('hip') && !s.includes('leg')) return capitalise(s.replace('hip', 'hip/leg'));
  return capitalise(s);
}

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Map entity status → certainty field.
 */
function mapCertainty(entity) {
  const status = (entity.status || '').toLowerCase();
  const text = ((entity.display_text || '') + ' ' + (entity.canonical_name || '')).toLowerCase();
  if (status === 'ruled_out') return 'rule_out';
  if (status === 'suspected' || /\bpossible\b|\bprobable\b|\blikely\b|\bsuspect/i.test(text)) return 'suspected';
  if (entity.certainty === 'rule_out' || /\brule.?out\b|\bexclude\b|\br\/o\b/i.test(text)) return 'rule_out';
  if (entity.certainty === 'suspected') return 'suspected';
  // Default to confirmed for explicit diagnoses unless markers say otherwise
  return 'confirmed';
}

/**
 * Merge differentials that explain the same symptom complex.
 * Confirmed diagnoses are kept as separate entries.
 */
function mergeDifferentialsBySymptomComplex(problems) {
  const confirmed = problems.filter(p => p.certainty === 'confirmed');
  const unconfirmed = problems.filter(p =>
    p.certainty === 'suspected' || p.certainty === 'rule_out'
  );

  const groups = [];

  for (const prob of unconfirmed) {
    let addedToGroup = false;
    for (const group of groups) {
      // Check if they share any symptoms
      const shareSymptom = prob.symptom_ids && prob.symptom_ids.some(id => group.symptom_ids.has(id));
      
      // Check if they share a body site AND are temporally close in the transcript (e.g. within 15 seconds)
      const sameSite = prob.body_site && group.body_site && prob.body_site.toLowerCase() === group.body_site.toLowerCase();
      const temporallyClose = Math.abs((prob.earliest_transcript_timestamp || 0) - (group.earliest_transcript_timestamp || 0)) <= 15;
      
      if (shareSymptom || (sameSite && temporallyClose)) {
        group.problems.push(prob);
        if (prob.symptom_ids) prob.symptom_ids.forEach(id => group.symptom_ids.add(id));
        addedToGroup = true;
        break;
      }
    }
    if (!addedToGroup) {
      groups.push({
        problems: [prob],
        body_site: prob.body_site,
        symptom_ids: new Set(prob.symptom_ids || []),
        earliest_transcript_timestamp: prob.earliest_transcript_timestamp
      });
    }
  }

  const merged = [];
  for (const group of groups) {
    if (group.problems.length === 1) {
      merged.push(group.problems[0]);
      continue;
    }

    const possibles = group.problems.filter(p => p.certainty === 'suspected').map(p => p.problem);
    const ruleOuts = group.problems.filter(p => p.certainty === 'rule_out').map(p => p.problem);

    const site = group.body_site || 'unknown';
    const regionLabel = formatRegionLabel(site);
    let title = `${regionLabel} issue`;
    if (group.symptom_ids.size > 0) title = `${regionLabel} symptom complex`;
    if (possibles.length) title += ` - possible ${possibles.join(', ')}`;
    if (ruleOuts.length) title += `, rule out ${ruleOuts.join(', ')}`;

    const base = group.problems[0];
    merged.push({
      ...base,
      problem: title,
      display_title: title,
      certainty: 'differential',
      constituent_diagnoses: group.problems.map(p => p.problem),
      diagnosis_ids: group.problems.flatMap(p => p.diagnosis_ids || []),
      symptom_ids: group.problems.flatMap(p => p.symptom_ids || []),
      exam_ids: group.problems.flatMap(p => p.exam_ids || []),
      investigation_ids: group.problems.flatMap(p => p.investigation_ids || []),
      medication_ids: group.problems.flatMap(p => p.medication_ids || []),
      treatment_ids: group.problems.flatMap(p => p.treatment_ids || []),
      referral_ids: group.problems.flatMap(p => p.referral_ids || []),
      followup_ids: group.problems.flatMap(p => p.followup_ids || []),
      earliest_transcript_timestamp: Math.min(
        ...group.problems.map(p => p.earliest_transcript_timestamp || Infinity)
      ),
    });
  }

  return [...confirmed, ...merged];
}

/**
 * Sort problems by transcript first-mention order.
 * Heidi orders problems by when they first appeared in the transcript,
 * NOT by clinical severity.
 */
function sortByTranscriptOrder(problems) {
  return [...problems].sort(
    (a, b) => (a.earliest_transcript_timestamp || 0) - (b.earliest_transcript_timestamp || 0)
  );
}

export class ProblemGraphBuilder {
  static execute(graph) {
    const activeProblems = [];
    const entities = graph.clinical_entities || [];
    const relationships = graph.resolved_relationships || [];

    // Find all diagnoses and clinical impressions, plus incidental findings explicitly monitored
    const diagnoses = entities.filter(e => {
      // UNIVERSAL DENIAL GUARD (type-agnostic, all encounter types): a denied/negated
      // fact can NEVER become a problem node. e.g. "No Type 2 Diabetes" ("Two diabetes.
      // No.") must not be promoted to a numbered problem.
      if (e.is_negative === true || e.clinical_role === 'negative_finding' || e.certainty === 'negated') return false;

      // PMH GUARD: a fact routed to Past Medical History (resolved/chronic condition
      // reviewed but not managed this visit, or a historical procedure) must not ALSO
      // become a numbered A&P problem.
      if (e.clinical_role === 'past_history' || e.rendered_section === 'Past Medical History') return false;

      if (e.entity_type === 'diagnosis') return true;
      if (e.entity_type === 'clinical_impression' && e.clinical_role !== 'negative_finding') return true;
      
      // Explicit logic permitting a minor incidental finding to become its own numbered problem
      // when the clinician discussed monitoring it (e.g. Patient 7's IV-site-mark).
      if (e.entity_type === 'physical_exam' || e.entity_type === 'observation' || e.entity_type === 'symptom') {
        const isMonitored = relationships.some(r => 
          (r.source === e.id || r.target === e.id) && 
          ['monitored_by', 'investigated_by', 'followed_by'].includes(r.relationship)
        );
        if (isMonitored) return true;
      }
      return false;
    });

    for (const diagnosis of diagnoses) {
      const certainty = mapCertainty(diagnosis);
      
      // Extract body site from entity or its relationships
      const bodyPart = diagnosis.body_part || diagnosis.body_site || diagnosis.anatomical_location || null;
      const anatomicalRegion = bodyPart;

      const problemObj = {
        problem: diagnosis.display_text || diagnosis.canonical_name,
        display_title: diagnosis.display_text || diagnosis.canonical_name,
        certainty,
        body_site: anatomicalRegion,
        anatomical_region: anatomicalRegion,
        category: diagnosis.category || null,
        status: diagnosis.status || 'active',
        // Timestamp for transcript-order sorting
        earliest_transcript_timestamp: diagnosis.earliest_transcript_timestamp ||
          (diagnosis.transcript_span?.start != null ? diagnosis.transcript_span.start * 0.05 : 0),
        diagnosis_ids: [diagnosis.id],
        symptom_ids: [],
        exam_ids: [],
        investigation_ids: [],
        medication_ids: [],
        treatment_ids: [],
        treatment_instruction_ids: [],
        referral_ids: [],
        followup_ids: [],
        entity_ids: [diagnosis.id],
      };

      // Find all relationships involving this diagnosis
      for (const rel of relationships) {
        if (rel.source === diagnosis.id || rel.target === diagnosis.id) {
          const otherId = rel.source === diagnosis.id ? rel.target : rel.source;
          const otherEntity = entities.find(e => e.id === otherId);

          if (otherEntity) {
            problemObj.entity_ids.push(otherId);
            switch (otherEntity.entity_type) {
              case 'symptom':
                problemObj.symptom_ids.push(otherId);
                // Inherit body site from symptom if not on diagnosis
                if (!problemObj.body_site && (otherEntity.body_part || otherEntity.body_site)) {
                  problemObj.body_site = otherEntity.body_part || otherEntity.body_site;
                  problemObj.anatomical_region = problemObj.body_site;
                }
                break;
              case 'physical_exam':
                problemObj.exam_ids.push(otherId);
                break;
              case 'investigation':
              case 'lab_result':
                problemObj.investigation_ids.push(otherId);
                break;
              case 'medication':
              case 'medication_order':
                problemObj.medication_ids.push(otherId);
                break;
              case 'treatment':
              case 'procedure_history':
                problemObj.treatment_ids.push(otherId);
                break;
              case 'treatment_instruction':
              case 'administrative_action':
                problemObj.treatment_instruction_ids.push(otherId);
                break;
              case 'referral':
                problemObj.referral_ids.push(otherId);
                break;
              case 'follow_up':
                problemObj.followup_ids.push(otherId);
                break;
            }
          }
        }
      }

      activeProblems.push(problemObj);
    }

    // V31: Merge differentials sharing a symptom complex
    let mergedProblems = mergeDifferentialsBySymptomComplex(activeProblems);

    // V31: Sort by transcript first-mention order
    mergedProblems = sortByTranscriptOrder(mergedProblems);

    console.log(`[ProblemGraphBuilder] Built ${activeProblems.length} initial problems → ${mergedProblems.length} after merge + sort`);

    return { active_problems: mergedProblems };
  }
}
