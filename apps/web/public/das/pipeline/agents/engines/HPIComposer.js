/**
 * HPIComposer — DAS V25 ⭐
 * DEPRECATED V26 — Replaced by ClinicalStoryLLMAgent.
 * This file is TOMBSTONED: kept for reference and used by DeterministicFallbackComposer.
 * Do NOT call this in the active V26 pipeline.
 *
 * V25 role: Enriched graph.clinical_story.subjective.history_presenting_illness[]
 * with properly ordered, medically phrased sentences from extracted entities.
 *
 * V26 equivalent: ClinicalStoryLLMAgent generates full narrative HPI from transcript + graph,
 * preserving mechanism, chronology, and context that entity extraction alone cannot capture.
 *
 * Progression rules:
 *   worsening → "has been worsening"
 *   resolved   → "has resolved"
 *   persistent → "persists"
 *   improving  → "is improving"
 *   stable     → "remains stable"
 *
 * Only runs for encounter types in HPI_ENCOUNTER_TYPES.
 */

// Encounter types that get a full HPI narrative
const HPI_ENCOUNTER_TYPES = new Set([
  'acute_injury',
  'musculoskeletal',
  'diabetes',
  'hypertension',
  'weight_loss',
  'anemia',
  'gynecology',
  'mental_health',
  'dermatology',
  'general_followup',
  'general_primary_care',
  'lipids',
  'pediatrics',
]);

const PROGRESSION_MAP = {
  worsening:  'has been worsening',
  worsened:   'has worsened',
  resolved:   'has resolved',
  resolving:  'is resolving',
  persistent: 'persists',
  persisting: 'persists',
  improving:  'is improving',
  improved:   'has improved',
  stable:     'remains stable',
  unchanged:  'is unchanged',
  fluctuating:'is fluctuating',
  recurring:  'is recurring',
};

const TEMPORAL_QUALIFIERS = [
  'onset', 'duration', 'since', 'started', 'began', 'ago',
  'month', 'week', 'day', 'year', 'yesterday', 'last',
];

function isTemporalEntity(entity) {
  const text = (entity.display_text || entity.canonical_name || '').toLowerCase();
  return (
    entity.entity_type === 'temporal_event' ||
    entity.entity_type === 'temporal_reference' ||
    TEMPORAL_QUALIFIERS.some(q => text.includes(q))
  );
}

function buildSymptomSentence(entity) {
  let parts = [];

  // Location prefix
  const lateral = entity.laterality || '';
  const site = entity.body_site || entity.anatomical_location || '';
  const symptomText = entity.display_text || entity.canonical_name || '';

  let subjectText = symptomText;
  if (site && !symptomText.toLowerCase().includes(site.toLowerCase())) {
    subjectText = lateral ? `${lateral} ${site} ${symptomText}` : `${site} ${symptomText}`;
  } else if (lateral && !symptomText.toLowerCase().includes(lateral.toLowerCase())) {
    subjectText = `${lateral} ${symptomText}`;
  }

  subjectText = subjectText.charAt(0).toUpperCase() + subjectText.slice(1);

  // Onset
  if (entity.onset) {
    parts.push(`${subjectText} onset ${entity.onset}`);
  } else {
    parts.push(subjectText);
  }

  // Quality
  if (entity.quality) parts.push(`quality: ${entity.quality}`);

  // Severity
  if (entity.severity) parts.push(`severity ${entity.severity}`);

  // Aggravating factors
  if (entity.aggravating_factors) {
    parts.push(`worsens with ${entity.aggravating_factors}`);
  }

  // Relieving factors
  if (entity.relieving_factors) {
    parts.push(`improves with ${entity.relieving_factors}`);
  }

  // Progression
  if (entity.progression) {
    const prog = PROGRESSION_MAP[entity.progression?.toLowerCase()];
    if (prog) parts.push(prog);
  }

  let sentence = parts.join('; ');
  // Capitalise and terminate
  sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  if (!sentence.endsWith('.')) sentence += '.';
  return sentence;
}

function buildProgressionSentences(entities) {
  const progressionSentences = [];
  entities.forEach(e => {
    if (!e.progression) return;
    const prog = PROGRESSION_MAP[e.progression?.toLowerCase()];
    if (!prog) return;

    const name = e.canonical_name || e.display_text || '';
    if (!name) return;

    const lateral = e.laterality ? `${e.laterality} ` : '';
    const site = e.body_site ? `${e.body_site} ` : '';
    const subject = `${lateral}${site}${name}`.trim();
    const cap = subject.charAt(0).toUpperCase() + subject.slice(1);
    const sentence = `${cap} ${prog}.`;
    progressionSentences.push(sentence);

    e.represented_by = e.represented_by || [];
    if (!e.represented_by.includes('SUBJECTIVE_PROGRESSION')) {
      e.represented_by.push('SUBJECTIVE_PROGRESSION');
    }
  });
  return progressionSentences;
}

function buildModifierSentences(entities) {
  const modifiers = [];
  entities.forEach(e => {
    const hasModifier = e.aggravating_factors || e.relieving_factors || e.context;
    if (!hasModifier) return;

    const name = (e.body_site ? `${e.body_site} ` : '') + (e.display_text || e.canonical_name || '');
    let sentence = '';

    if (e.aggravating_factors && e.relieving_factors) {
      sentence = `${name.trim()} worsens with ${e.aggravating_factors} and improves with ${e.relieving_factors}.`;
    } else if (e.aggravating_factors) {
      sentence = `${name.trim()} worsens with ${e.aggravating_factors}.`;
    } else if (e.relieving_factors) {
      sentence = `${name.trim()} improves with ${e.relieving_factors}.`;
    } else if (e.context) {
      sentence = `Context: ${e.context}.`;
    }

    if (sentence) {
      modifiers.push(sentence.charAt(0).toUpperCase() + sentence.slice(1));
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('SUBJECTIVE_MODIFIERS')) {
        e.represented_by.push('SUBJECTIVE_MODIFIERS');
      }
    }
  });
  return modifiers;
}

export class HPIComposer {
  static execute(graph) {
    const encounterType = graph.encounter_type || graph.encounterType || 'general_primary_care';

    // Only run for encounter types that warrant a full HPI
    if (!HPI_ENCOUNTER_TYPES.has(encounterType)) {
      // For skipped types, ensure reason_for_visit is set cleanly
      if (!graph.clinical_story?.subjective?.reason_for_visit) {
        if (graph.clinical_story?.subjective) {
          graph.clinical_story.subjective.reason_for_visit = 'Follow-up visit.';
        }
      }
      return graph;
    }

    const story = graph.clinical_story;
    if (!story) return graph; // EncounterNarrativeBuilder must run first

    const entities = graph.clinical_entities || [];

    // Active current symptoms — the HPI subjects
    const activeSymptoms = entities.filter(e =>
      e.entity_type === 'symptom' &&
      e.clinical_role !== 'negative_finding' &&
      e.clinical_role !== 'past_history' &&
      (e.temporality === 'current' || !e.temporality)
    );

    // Sort by clinical priority: critical > high > medium > low
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, background: 4 };
    activeSymptoms.sort((a, b) => {
      const pa = priorityOrder[a.clinical_priority] ?? 5;
      const pb = priorityOrder[b.clinical_priority] ?? 5;
      return pa - pb;
    });

    // Build symptom characteristic sentences
    const characteristics = [];
    activeSymptoms.forEach(e => {
      const sentence = buildSymptomSentence(e);
      characteristics.push(sentence);
      e.represented_by = e.represented_by || [];
      if (!e.represented_by.includes('SUBJECTIVE_HPI')) {
        e.represented_by.push('SUBJECTIVE_HPI');
      }
    });

    // Deduplicate against existing HPI sentences
    const existingHPI = new Set(story.subjective.history_presenting_illness.map(s => s.toLowerCase()));
    const newCharacteristics = characteristics.filter(s => !existingHPI.has(s.toLowerCase()));

    // Merge: existing EncounterNarrativeBuilder sentences + HPI characteristics
    story.subjective.history_presenting_illness = [
      ...story.subjective.history_presenting_illness,
      ...newCharacteristics,
    ];

    // Symptom modifiers (aggravating/relieving factors)
    story.subjective.symptom_modifiers = buildModifierSentences(activeSymptoms);

    // Symptom progression statements
    story.subjective.symptom_progression = buildProgressionSentences(activeSymptoms);

    return graph;
  }
}
