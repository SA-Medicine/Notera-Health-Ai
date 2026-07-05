/**
 * ClinicalLexiconEngine — DAS V25
 *
 * Normalises colloquial and informal clinical phrases into professional
 * medical language before narrative synthesis begins.
 *
 * Lexicon is loaded from clinical_lexicon.json (categorised: labs, medications,
 * symptoms, negatives). No code changes needed to extend the lexicon.
 *
 * Runs on: graph.clinical_entities[].display_text
 *           graph.numeric_data[].test_name
 *           graph.current_medications[]
 */

// Load lexicon inline — import assertions (assert { type: 'json' }) are NOT supported
// in Chrome MV3 service workers or extension pages. We import the JSON file by
// re-exporting it as a plain JS module from a thin wrapper instead.
// The canonical source of truth remains clinical_lexicon.json;
// copy any edits there into this constant, or use a build step to sync.
import { CLINICAL_LEXICON } from './clinical_lexicon_data.js';

// V31: Preserved shorthand — these are NEVER expanded by the lexicon
const PRESERVE_SHORTHAND = new Set([
  'rtc', 'prn', 'bilateral', 'b/l', 'approx', 'hx', 'dx',
  'rx', 'fx', 'bx', 'od', 'bd', 'tds', 'qid', 'tid', 'rt'
]);

// V31: Follow-up phrase normalizations — applied after lexicon pass
const FOLLOW_UP_NORMALIZATIONS = [
  {
    pattern: /i(?:'ll)?\s+see\s+you\s+after\s+(?:these\s+)?(?:things\s+are\s+)?done/gi,
    replacement: 'after investigations completed'
  },
  {
    pattern: /(?:follow[- ]?up|review)\s+after\s+(?:all\s+)?(?:current\s+)?investigations?\s+(?:are\s+)?(?:completed?|done)/gi,
    replacement: 'after investigations completed'
  },
  {
    pattern: /return\s+to\s+clinic\s+(?:once|when|after)\s+/gi,
    replacement: 'rtc '
  },
  {
    pattern: /return\s+to\s+clinic/gi,
    replacement: 'rtc'
  }
];

/**
 * V31: Normalize laterality in order strings.
 * "X-ray of both hands" → "X-ray bilateral hands"
 */
export function normalizeLateralityInOrder(orderText, laterality) {
  if (!orderText) return orderText;
  if (!laterality || laterality === 'unilateral') return orderText;
  if (laterality === 'bilateral') {
    return orderText
      .replace(/x[-\s]?ray\s+of\s+(?:both\s+)?(?:the\s+)?(\w+)/i, 'X-ray bilateral $1')
      .replace(/x[-\s]?ray\s+(?:both\s+)(\w+)/i, 'X-ray bilateral $1')
      .replace(/x[-\s]?ray\s+(?:the\s+)?(\w+)\s+(?:bilaterally|both\s+sides)/i, 'X-ray bilateral $1');
  }
  return orderText;
}

// Flatten all categories into a single lookup map (case-insensitive)
const FLAT_LEXICON = {};
for (const category of Object.values(CLINICAL_LEXICON)) {
  for (const [phrase, replacement] of Object.entries(category)) {
    FLAT_LEXICON[phrase.toLowerCase().trim()] = replacement;
  }
}

export class ClinicalLexiconEngine {
  /**
   * Normalise a single string against the lexicon.
   * Performs whole-phrase matching first, then inline substitution.
   * @param {string} text
   * @returns {string}
   */
  static normalise(text) {
    if (!text || typeof text !== 'string') return text;

    const lower = text.toLowerCase().trim();

    // V31: Never expand preserved shorthands
    if (PRESERVE_SHORTHAND.has(lower)) return text;

    // 1. Exact whole-phrase match (skip if the entire phrase is a preserved shorthand)
    if (FLAT_LEXICON[lower] && !PRESERVE_SHORTHAND.has(lower)) return FLAT_LEXICON[lower];

    // 2. Inline substitution — replace any matching phrase within the text
    let result = text;
    for (const [phrase, replacement] of Object.entries(FLAT_LEXICON)) {
      // V31: Skip any lexicon entry that would expand a preserved shorthand
      if (PRESERVE_SHORTHAND.has(phrase.toLowerCase())) continue;
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      result = result.replace(regex, replacement);
    }

    // V31: Apply follow-up normalizations after lexicon pass
    for (const { pattern, replacement } of FOLLOW_UP_NORMALIZATIONS) {
      result = result.replace(pattern, replacement);
    }

    return result;
  }

  /**
   * Execute on the full graph — normalises display_text on all entities,
   * medication names, and numeric data test names.
   * @param {object} graph
   * @returns {object}
   */
  static execute(graph) {
    const entities = graph.clinical_entities || [];

    entities.forEach(entity => {
      if (entity.display_text) {
        entity.display_text = ClinicalLexiconEngine.normalise(entity.display_text);
      }
      if (entity.canonical_name) {
        // Only normalise if not locked (diagnoses are locked)
        if (!entity.locked) {
          entity.canonical_name = ClinicalLexiconEngine.normalise(entity.canonical_name);
        }
      }
      if (entity.symptom_characteristic) {
        entity.symptom_characteristic = ClinicalLexiconEngine.normalise(entity.symptom_characteristic);
      }
    });

    // Normalise medication display names (not the canonical drug name)
    if (Array.isArray(graph.current_medications)) {
      graph.current_medications = graph.current_medications.map(med => {
        if (typeof med === 'string') return ClinicalLexiconEngine.normalise(med);
        if (med?.display_name) med.display_name = ClinicalLexiconEngine.normalise(med.display_name);
        return med;
      });
    }

    // Normalise numeric data test names
    if (Array.isArray(graph.numeric_data)) {
      graph.numeric_data.forEach(n => {
        if (n.test_name) n.test_name = ClinicalLexiconEngine.normalise(n.test_name);
      });
    }

    return graph;
  }
}
