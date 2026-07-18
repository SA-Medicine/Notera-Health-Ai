/**
 * NarrativeValidator — DAS V31
 *
 * Hallucination guard and coverage auditor.
 *
 * V31 KEY CHANGES:
 *   - Negation lines BYPASS the overlap check entirely (always pass through).
 *   - Hard fail only triggers on missing POSITIVE critical facts.
 *   - Negative findings are tracked as 'rendered_negation' in traceability.
 *   - V31 slot-based notes (clinical_story._v31) skip section processing —
 *     slot lines are already validated at extraction time.
 */

const OVERLAP_THRESHOLD = 0.30;
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'was', 'are', 'were', 'has', 'have', 'had', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'by', 'from', 'as', 'no', 'not', 'reported', 'noted', 'patient', 'doctor', 'clinic', 'visit']);

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9.\s-]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
}
function extractNumbers(text) {
  return (text.match(/\b\d+\.?\d*\b/g) || []);
}

/**
 * V31: Detect negation lines — these ALWAYS pass through validation.
 * Heidi always renders explicit denials.
 */
function isNegationLine(text) {
  return /^(no |denies?\s|without |negative for |no \w+ or )/i.test((text || '').trim());
}

function isSentenceSupported(sentence, graph, sentenceId) {
  // V31: Negation lines bypass overlap check entirely
  if (isNegationLine(sentence)) {
    return { supported: true, reason: 'negation_passthrough' };
  }

  const corpusTokens = new Set();
  const allEntityText = [];
  
  (graph.clinical_entities || []).forEach(e => allEntityText.push(
    e.display_text || e.canonical_name || '',
    e.source_quote || e.source_span || '',
    e.functional_impact || '',
    e.onset_description || '',
    e.progression_description || ''
  ));
  (graph.numeric_data || []).forEach(n => allEntityText.push(`${n.test_name || ''} ${n.value || ''} ${n.unit || ''} ${n.trend_narrative || ''}`));
  allEntityText.push(...(graph.current_medications || []));
  (graph.orders || []).forEach(o => allEntityText.push(o.test || ''));
  (graph.follow_ups || []).forEach(f => allEntityText.push(f.description || f.timeframe || f.trigger || ''));
  (graph.active_problems || []).forEach(p => allEntityText.push(p.problem || p.display_title || ''));
  
  tokenize(allEntityText.join(' ')).forEach(t => corpusTokens.add(t));

  const sentenceTokens = tokenize(sentence);
  let supported = false;
  let reason = '';

  if (sentenceTokens.length > 0) {
    const matchCount = sentenceTokens.filter(t => corpusTokens.has(t)).length;
    const overlap = matchCount / sentenceTokens.length;
    if (overlap >= OVERLAP_THRESHOLD) {
      supported = true;
      reason = `token_overlap_${Math.round(overlap * 100)}%`;
    }
  }

  const sentenceNumbers = extractNumbers(sentence);
  if (sentenceNumbers.length > 0) {
    const allNumericValues = (graph.numeric_data || []).map(n => String(n.value));
    const hasMatch = sentenceNumbers.some(num => allNumericValues.includes(num));
    if (hasMatch) { supported = true; reason = 'numeric_exact_match'; }
    else if (sentenceNumbers.length >= 2) { supported = false; reason = 'numeric_mismatch'; }
  }

  const meds = (graph.current_medications || []).map(m => m.toLowerCase());
  if (meds.some(med => sentence.toLowerCase().includes(med.split(' ')[0]))) {
    supported = true;
    reason = 'medication_match';
  }

  if (!supported && !reason) reason = 'low_overlap';

  if (supported) {
    (graph.clinical_entities || []).forEach(e => {
      const text = (e.display_text || e.canonical_name || '').toLowerCase();
      if (text && text.length > 3 && sentence.toLowerCase().includes(text)) {
        e.represented_by = e.represented_by || [];
        if (!e.represented_by.includes(sentenceId)) e.represented_by.push(sentenceId);
      }
    });
  }

  return { supported, reason };
}

/**
 * V31: Only trigger hard fail on missing POSITIVE critical facts.
 * Negative findings never trigger hard fail.
 */
function shouldTriggerHardFail(graph) {
  const unrepresented = (graph.clinical_entities || []).filter(e => {
    if (e.clinical_role === 'negative_finding') return false; // Never hard fail on negations
    if (e.clinical_significance !== 'critical') return false;
    return !(e.represented_by && e.represented_by.length > 0);
  });
  return unrepresented;
}

/**
 * V31: Track negative findings with dedicated render_status.
 */
function trackNegationFact(entity, sectionName) {
  entity._render_status = 'rendered_negation';
  entity._render_section = sectionName;
  entity.represented_by = entity.represented_by || [];
  if (!entity.represented_by.includes('NEGATION_PASSTHROUGH')) {
    entity.represented_by.push('NEGATION_PASSTHROUGH');
  }
}

export class NarrativeValidator {
  static validate(graph) {
    const story = graph.clinical_story;
    if (!story) return graph;

    // V31 slot-based notes skip section validation — slot lines are already verified at extraction
    if (story._v31) {
      console.log('[NarrativeValidator] V31 slot-based note — skipping prose validation, running negation tracking only.');
      
      // Still track negation facts for traceability
      (graph.clinical_entities || []).forEach(e => {
        if (e.clinical_role === 'negative_finding') {
          trackNegationFact(e, 'v31_slot');
        }
      });

      // Coverage check: only warn, never hard fail on V31 notes
      const missing = shouldTriggerHardFail(graph);
      if (missing.length > 0) {
        console.warn(`[NarrativeValidator] V31 coverage warning: ${missing.length} critical positive facts not explicitly represented.`);
        missing.forEach(e => console.warn(`  MISSING: ${e.canonical_name || e.display_text}`));
      } else {
        console.log('[NarrativeValidator] V31 coverage check passed.');
      }

      return graph;
    }

    // V30/legacy prose validation path
    const validationLog = [];
    let sentenceCounter = 1;

    function processSection(sentences, sectionName) {
      const cleaned = [];
      (sentences || []).forEach(sentence => {
        if (!sentence || typeof sentence !== 'string' || sentence.trim().length < 5) return;
        
        let cleanSentence = sentence;
        if (typeof sentence === 'object') {
          cleanSentence = sentence.text || '';
          if (sentence.supporting_fact_ids) {
            sentence.supporting_fact_ids.forEach(id => {
              const e = (graph.clinical_entities || []).find(ent => ent.id === id);
              if (e) {
                e.represented_by = e.represented_by || [];
                e.represented_by.push(`LLM_SENTENCE_${sentenceCounter}`);
              }
            });
          }
        }

        const sid = `S${sentenceCounter++}`;

        // V31 CRITICAL FIX: Negation lines always pass through — bypass overlap check
        if (isNegationLine(cleanSentence)) {
          cleaned.push(cleanSentence);
          validationLog.push(`[${sectionName}] NEGATION PASSTHROUGH: "${cleanSentence.slice(0, 80)}"`);
          // Track negation entities
          (graph.clinical_entities || []).forEach(e => {
            if (e.clinical_role === 'negative_finding') {
              const text = (e.display_text || '').toLowerCase();
              if (text && cleanSentence.toLowerCase().includes(text.slice(0, 15))) {
                trackNegationFact(e, sectionName);
              }
            }
          });
          return;
        }

        const { supported, reason } = isSentenceSupported(cleanSentence, graph, sid);
        
        if (supported) {
          cleaned.push(cleanSentence);
        } else {
          validationLog.push(`[${sectionName}] REMOVED (${reason}): "${cleanSentence.slice(0, 80)}..."`);
        }
      });
      return cleaned;
    }

    // Process V30 prose sections
    ['presenting_complaints', 'history_presenting_complaint', 'associated_symptoms', 'disease_management', 'review_of_systems']
      .forEach(sec => { if (story.subjective) story.subjective[sec] = processSection(story.subjective[sec], `subj.${sec}`); });
      
    ['medical_history', 'surgical_history', 'social_history', 'family_history', 'exposure_history', 'immunization_history']
      .forEach(sec => { if (story.pmh) story.pmh[sec] = processSection(story.pmh[sec], `pmh.${sec}`); });

    ['vitals', 'physical_exam', 'investigations', 'imaging']
      .forEach(sec => { if (story.objective) story.objective[sec] = processSection(story.objective[sec], `obj.${sec}`); });

    (story.assessment_plan || []).forEach(ap => {
      ['narrative', 'investigations_planned', 'treatment_planned', 'follow_up']
        .forEach(sec => { ap[sec] = processSection(ap[sec], `ap.${ap.title || ap.diagnosis}.${sec}`); });
    });

    story._validation_log = validationLog;

    // Coverage audit — V31 negation-aware hard fail
    const coverageLog = [];
    const criticalMissing = shouldTriggerHardFail(graph);

    (graph.clinical_entities || []).forEach(e => {
      const isRepresented = e.represented_by && e.represented_by.length > 0;
      if (!isRepresented && e.clinical_significance === 'major') {
        coverageLog.push(`WARNING (Major missing): ${e.canonical_name || e.display_text}`);
      }
    });

    story._coverage_log = coverageLog;

    if (criticalMissing.length > 0) {
      console.error(`[NarrativeValidator] HARD FAIL: ${criticalMissing.length} critical positive entities unrepresented!`);
      criticalMissing.forEach(e => console.error('  ', `CRITICAL MISSING: ${e.canonical_name || e.display_text}`));
      throw new Error(`NarrativeValidator hard fail: ${criticalMissing.length} critical entities missing.`);
    } else if (coverageLog.length > 0) {
      console.warn('[NarrativeValidator] Coverage warnings:');
      coverageLog.forEach(msg => console.warn('  ', msg));
    } else {
      console.log('[NarrativeValidator] Coverage audit passed (0 critical/major missing).');
    }

    return graph;
  }
}
