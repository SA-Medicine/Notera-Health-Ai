/**
 * FROZEN — DAS V25
 *
 * ClinicalSummaryEngine has been moved to deprecated/.
 * This file is a tombstone. Do NOT import from this path.
 * Import from: '../deprecated/ClinicalSummaryEngine.js'
 *
 * This engine is NOT called in the V25 pipeline.
 * Replaced by: EncounterNarrativeBuilder + AssessmentComposer
 */

export class ClinicalSummaryEngine {
  static execute(graph) {
    console.warn('[DAS V25] ClinicalSummaryEngine is frozen. Use EncounterNarrativeBuilder instead.');
    return graph;
  }
}
