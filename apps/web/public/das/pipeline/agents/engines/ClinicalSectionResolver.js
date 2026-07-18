/**
 * FROZEN — DAS V25
 *
 * ClinicalSectionResolver has been moved to deprecated/.
 * This file is a tombstone. Do NOT import from this path.
 * Import from: '../deprecated/ClinicalSectionResolver.js'
 *
 * This engine is NOT called in the V25 pipeline.
 * Section routing is now handled by EncounterNarrativeBuilder.
 */

export class ClinicalSectionResolver {
  static execute(graph) {
    console.warn('[DAS V25] ClinicalSectionResolver is frozen. Section routing is in EncounterNarrativeBuilder.');
    return graph;
  }
}
