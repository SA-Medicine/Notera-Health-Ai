/**
 * FROZEN — DAS V25
 *
 * NarrativeQualityScorer has been moved to deprecated/.
 * This file is a tombstone. Do NOT import from this path.
 * Import from: '../deprecated/NarrativeQualityScorer.js'
 *
 * This engine is NOT called in the V25 pipeline.
 * Replaced by: StoryCoverageValidator (entity-level coverage tracking).
 */

export class NarrativeQualityScorer {
  static evaluate(note) {
    console.warn('[DAS V25] NarrativeQualityScorer is frozen. Use StoryCoverageValidator instead.');
    return { narrative_quality_score: 0, sentence_flow_score: 0, entity_dump_score: 0, duplication_score: 0 };
  }
}
