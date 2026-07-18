export class JSValidatorLayer {
  static validate(transcript, extractedData, finalNote) {
    const transcriptLower = transcript.toLowerCase();
    const noteLower = finalNote.toLowerCase();
    const errors = [];
    
    // 1. Numeric Validator (Smart checking against extracted objects, not raw transcript)
    const numericData = extractedData.numeric_data || [];
    for (const num of numericData) {
       // Only validate numerics that had source text (skip hallucinations)
       if (num.value && num.source_text) {
          if (!noteLower.includes(num.value)) {
             errors.push(`Missing Numeric: ${num.test_name} (${num.value}) was extracted but not rendered.`);
          }
       }
    }

    // 2. Medication Validator (HARD FAIL)
    const meds = [
      ...(extractedData.current_medications || []),
      ...(extractedData.medication_decisions || []).map(m => m.medication)
    ];
    for (const med of meds) {
      if (med && !noteLower.includes(med.toLowerCase())) {
        errors.push(`[HARD FAIL] Missing Medication: ${med}`);
      }
    }

    // 3. Clinical Entity Traceability — only CLINICALLY ESSENTIAL facts are required.
    // Background/admin/contextual facts (pharmacy names, social history, normal findings,
    // "vision for arm", reasoning, denials) are not required verbatim and were causing
    // every note to FAIL and trigger the expensive deep-QA step.
    const entities = extractedData.clinical_entities || [];
    const NONESSENTIAL_TYPES = new Set([
      'administrative_action', 'social_history', 'clinical_context', 'normal_finding',
      'temporal_reference', 'temporal_event', 'contextual_activity', 'clinician_reasoning',
      'medication_tolerance', 'shared_decision_making'
    ]);
    const isEssential = (e) => {
      if (e.render_required !== true) return false;
      if (e.render_priority === 'background' || e.clinical_priority === 'background' || e.clinical_priority === 'low') return false;
      if (e.is_negative || e.clinical_role === 'negative_finding') return false;
      if (NONESSENTIAL_TYPES.has(e.entity_type)) return false;
      return true;
    };
    // Lenient presence: match the entity's key content words, not the verbose display_text.
    const present = (text) => {
      const t = (text || '').toLowerCase();
      if (!t) return true;
      if (noteLower.includes(t)) return true;
      const words = t.replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
        .filter(w => w.length > 3 && !['with', 'from', 'this', 'that', 'left', 'right', 'history'].includes(w));
      if (!words.length) return true;
      const hit = words.filter(w => noteLower.includes(w)).length;
      return hit / words.length >= 0.6;   // most key words present → considered rendered
    };
    for (const entity of entities.filter(isEssential)) {
       const text = entity.display_text || entity.canonical_name;
       if (!present(text)) {
          errors.push(`Missing Required Entity [${entity.entity_type}]: ${text}`);
       }
    }

    // 4. Diagnosis Recall Validator (HARD FAIL if missing)
    const diagnoses = entities.filter(e => e.entity_type === "diagnosis");
    for (const diag of diagnoses) {
      const text = diag.display_text || diag.canonical_name;
      if (text && !noteLower.includes(text.toLowerCase())) {
        errors.push(`[HARD FAIL] Missing Diagnosis Node: ${text}`);
      }
    }

    // 5. Procedure Recall Validator
    const procedures = entities.filter(e => e.entity_type === "procedure_history");
    for (const proc of procedures) {
      const text = proc.display_text || proc.canonical_name;
      if (text && !noteLower.includes(text.toLowerCase())) {
        errors.push(`Missing Procedure: ${text}`);
      }
    }

    // 6. Care Barrier Recall Validator
    const barriers = entities.filter(e => e.entity_type === "care_barrier");
    for (const bar of barriers) {
      const text = bar.display_text || bar.canonical_name;
      if (text && !noteLower.includes(text.toLowerCase())) {
        errors.push(`Missing Care Barrier: ${text}`);
      }
    }

    // 7. Temporal Recall Validator
    const temporals = entities.filter(e => e.entity_type === "temporal_reference");
    for (const temp of temporals) {
      const text = temp.display_text;
      if (text && !noteLower.includes(text.toLowerCase())) {
        errors.push(`Missing Temporal Reference: ${text}`);
      }
    }

    // 8. Laterality Validator
    for (const entity of entities) {
      if (entity.laterality) {
        if (!noteLower.includes(entity.laterality.toLowerCase())) {
          errors.push(`Missing Laterality (${entity.laterality}) for ${entity.display_text}`);
        }
      }
    }

    // 9. Body Site / Location Recall (HARD FAIL)
    for (const entity of entities) {
      if (entity.body_site) {
        if (!noteLower.includes(entity.body_site.toLowerCase())) {
          errors.push(`[HARD FAIL] Missing Body Site (${entity.body_site}) for ${entity.display_text}`);
        }
      }
      if (entity.anatomical_location) {
        if (!noteLower.includes(entity.anatomical_location.toLowerCase())) {
          errors.push(`[HARD FAIL] Missing Anatomical Location (${entity.anatomical_location}) for ${entity.display_text}`);
        }
      }
    }

    // 10. Follow-up Validator — soft. A vague trigger phrase ("ASAP", "couple weeks") often
    // doesn't appear verbatim even when a follow-up line IS rendered, so only WARN, and skip
    // entirely if the note already has any follow-up/return line.
    const followups = extractedData.follow_ups || [];
    const noteHasFollowup = /\brtc\b|follow[\s-]?up|return|review|see you|call (the )?office/i.test(noteLower);
    for (const f of followups) {
       const text = f.timeframe || f.trigger;
       if (text && !present(text) && !noteHasFollowup) {
          errors.push(`[WARNING] Missing Follow-up: ${text}`);
       }
    }

    // 11. Context / Trend Warnings
    const contextEntities = entities.filter(e => e.entity_type === "clinical_context");
    for (const ctx of contextEntities) {
       const text = ctx.display_text;
       if (text && !present(text)) {
          errors.push(`[WARNING] Missing Clinical Context: ${text}`);
       }
    }

    // FAIL only on genuine, clinically-essential misses (HARD FAIL or non-warning errors).
    // Pure WARNING-level gaps do not trigger the expensive deep QA.
    const hasHardFail = errors.some(e => e.includes("[HARD FAIL]"));
    const realErrors = errors.filter(e => !e.includes("[WARNING]"));
    const status = (hasHardFail || realErrors.length > 0) ? "FAIL" : "PASS";
    return { status, errors };
  }
}
