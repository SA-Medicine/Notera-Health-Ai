/**
 * DeterministicFallbackComposer — DAS V26
 *
 * Graceful degradation layer. Called if ClinicalStoryLLMAgent fails.
 *
 * Fallback order (as approved):
 *   1. ClinicalStoryLLMAgent (LLM) — primary
 *   2. DeterministicFallbackComposer (this file) — V25 deterministic logic
 *   3. Raw entity renderer in TemplateAssemblyAgent.renderLegacy() — last resort
 *
 * Uses the EncounterNarrativeBuilder's proven deterministic logic to initialise
 * clinical_story from the graph. Produces entity-list output (V25 quality),
 * not narrative quality — but always produces SOMETHING.
 *
 * Importantly: sets story._v26 = false so NarrativeValidator and renderV26()
 * know to treat this as a degraded output.
 */

import { EncounterNarrativeBuilder } from './engines/EncounterNarrativeBuilder.js';
import { HPIComposer } from './engines/HPIComposer.js';
import { MedicationNarrativeComposer } from './engines/MedicationNarrativeComposer.js';
import { AssessmentComposer } from './engines/AssessmentComposer.js';
import { NarrativeDeduplicator } from './engines/NarrativeDeduplicator.js';

export class DeterministicFallbackComposer {
  static execute(graph) {
    console.warn('[DeterministicFallbackComposer] Running V25 deterministic fallback...');

    try {
      // Run the full V25 synthesis chain
      graph = EncounterNarrativeBuilder.execute(graph);
      graph = HPIComposer.execute(graph);
      graph = MedicationNarrativeComposer.execute(graph);
      graph = AssessmentComposer.execute(graph);
      graph = NarrativeDeduplicator.execute(graph);

      // Adapt clinical_story to V26 schema shape so renderV26() can still render it
      // by mapping from V25 field names to V26 field names
      if (graph.clinical_story) {
        const s = graph.clinical_story.subjective;
        if (s) {
          // V26 uses presenting_complaints and history_presenting_complaint
          // V25 uses reason_for_visit and history_presenting_illness
          s.presenting_complaints = s.reason_for_visit
            ? [s.reason_for_visit]
            : (s.presenting_complaints || []);
          s.history_presenting_complaint = s.history_presenting_illness || [];
          // Copy across other V25 arrays that overlap
          // associated_symptoms stays same
          // disease_management stays same
        }

        // Map objective: V25 labs → investigations_with_results
        const o = graph.clinical_story.objective;
        if (o && !o.investigations_with_results) {
          o.investigations_with_results = (o.labs || []).map(l =>
            l.trend_narrative || `${l.label || ''}${l.value ? `: ${l.value}` : ''}${l.unit ? ` ${l.unit}` : ''}`
          );
          // Vitals: convert from object to string for renderV26
          o.vitals = (o.vitals || []).map(v =>
            v.trend_narrative || `${v.label || ''}: ${v.value || ''}${v.unit ? ` ${v.unit}` : ''}`
          );
        }

        // Mark as fallback (not V26 quality)
        graph.clinical_story._v26 = false;
        graph.clinical_story._fallback = true;
      }

      console.warn('[DeterministicFallbackComposer] Fallback complete. Output is V25 quality.');
    } catch (fallbackErr) {
      console.error('[DeterministicFallbackComposer] Fallback also failed:', fallbackErr);
      // At this point PipelineEngine's final catch will invoke renderLegacy()
      throw fallbackErr;
    }

    return graph;
  }
}
