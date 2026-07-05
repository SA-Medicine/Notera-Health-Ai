/**
 * NarrativeDeduplicator — DAS V25
 *
 * Runs immediately before the renderer. Merges redundant narrative lines
 * within graph.clinical_story to ensure clean, non-repetitive output.
 *
 * Algorithms:
 *   mergeNegatives()       — "Denies pain." + "Denies bleeding." → "Denies pain or bleeding."
 *   mergeDiseaseManagement() — Remove meds already in treatments_planned
 *   removeSubsumedFacts()  — Remove sentence Y if sentence X contains all of Y's key words
 *   deduplicateSection()   — Case-insensitive exact-duplicate removal within each array
 */

// Extract the negated thing from a "Denies X" or "No X" sentence
function extractNegated(sentence) {
  const lower = sentence.toLowerCase().trim().replace(/\.$/, '');
  const deniesPat = /^denies\s+(.+)$/i;
  const noPat = /^no\s+(.+)$/i;
  const negativelyPat = /(.+)\s+not\s+reported$/i;

  let match = lower.match(deniesPat);
  if (match) return { prefix: 'Denies', thing: match[1] };
  match = lower.match(noPat);
  if (match) return { prefix: 'No', thing: match[1] };
  match = lower.match(negativelyPat);
  if (match) return { prefix: 'No', thing: match[1] };
  return null;
}

function mergeNegatives(sentences) {
  if (!sentences || sentences.length === 0) return sentences;

  const groups = {}; // prefix → [things]
  const nonNegative = [];

  sentences.forEach(s => {
    const parsed = extractNegated(s);
    if (parsed) {
      if (!groups[parsed.prefix]) groups[parsed.prefix] = [];
      // Split "pain and bleeding" into individual items for proper merging
      const items = parsed.thing.split(/\s+(?:and|or)\s+/i).map(i => i.trim()).filter(Boolean);
      items.forEach(item => {
        if (!groups[parsed.prefix].includes(item)) {
          groups[parsed.prefix].push(item);
        }
      });
    } else {
      nonNegative.push(s);
    }
  });

  const merged = [];
  for (const [prefix, things] of Object.entries(groups)) {
    if (things.length === 0) continue;
    if (things.length === 1) {
      merged.push(`${prefix} ${things[0]}.`);
    } else if (things.length === 2) {
      merged.push(`${prefix} ${things[0]} or ${things[1]}.`);
    } else {
      const last = things[things.length - 1];
      const rest = things.slice(0, -1).join(', ');
      merged.push(`${prefix} ${rest} or ${last}.`);
    }
  }

  return [...nonNegative, ...merged];
}

// Remove subsumed sentences: if sentence A's key words are all in sentence B, remove A
function removeSubsumedFacts(sentences) {
  if (!sentences || sentences.length <= 1) return sentences;

  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'has', 'have', 'had',
    'been', 'be', 'to', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'but', 'not', 'no', 'for',
    'it', 'its', 'this', 'that', 'as', 'by', 'from', 'will', 'would', 'could', 'should', 'may']);

  function keyWords(s) {
    return new Set(
      s.toLowerCase()
        .replace(/[.,!?;:]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w))
    );
  }

  const result = [];
  for (let i = 0; i < sentences.length; i++) {
    const wordsI = keyWords(sentences[i]);
    if (wordsI.size === 0) {
      result.push(sentences[i]);
      continue;
    }
    let subsumed = false;
    for (let j = 0; j < sentences.length; j++) {
      if (i === j) continue;
      const wordsJ = keyWords(sentences[j]);
      // i is subsumed by j if all of i's keywords are in j AND j is longer
      if (wordsI.size < wordsJ.size) {
        const allIn = [...wordsI].every(w => wordsJ.has(w));
        if (allIn) {
          subsumed = true;
          break;
        }
      }
    }
    if (!subsumed) result.push(sentences[i]);
  }
  return result;
}

// Exact-duplicate removal (case-insensitive)
function deduplicateSection(sentences) {
  if (!sentences) return sentences;
  const seen = new Set();
  return sentences.filter(s => {
    const key = s.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Remove ongoing meds from disease_management that are already in any treatments_planned
function mergeDiseaseManagement(story) {
  if (!story.assessment_plan?.length) return;

  const allTreatments = new Set(
    story.assessment_plan.flatMap(ap => ap.treatments_planned || []).map(t => t.toLowerCase().trim())
  );

  story.subjective.disease_management = (story.subjective.disease_management || []).filter(dm => {
    const key = dm.toLowerCase().trim();
    // Remove if any treatment entry contains the first 20 chars of this management line
    return ![...allTreatments].some(t => t.includes(key.slice(0, 20)) || key.includes(t.slice(0, 20)));
  });
}


// ── V31 slot-based cross-section de-duplication (no repeat anywhere) ──────────
// Guarantees every fact appears in exactly one section, keeps exam findings to
// clinician exam only, and routes symptom/lab-looking lines out of exam.
function _v31Norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Patient-reported / history phrasing that is NOT an exam finding.
const _V31_SUBJECTIVE_PAT = /\b(reports?|complain(?:s|ing)?|denies|feels?|felt|states?|c\/o|the patient|onset|duration|worse (?:at|when|over)|since|for the last|history of|hx of)\b/i;
// Lab / imaging RESULT phrasing that belongs in investigations, not exam.
const _V31_LAB_PAT = /\b(a1c|hba1c|h(?:a)?emoglobin|ldl|hdl|cholesterol|glucose|sugar|sodium|potassium|creatinine|egfr|tsh|ferritin|iron studies|cbc|wbc|platelets?|bilirubin|result|mmol|mg\/dl|ng\/ml|urinalysis|x-ray|ultrasound|ct scan|mri)\b/i;

function _v31Dedupe(arr, seen, textOf) {
  const out = [];
  for (const item of (arr || [])) {
    const n = _v31Norm(textOf ? textOf(item) : item);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(item);
  }
  return out;
}

function dedupeV31(story) {
  // 1. Subjective slots — dedupe within each slot AND across all slots.
  const subjSeen = new Set();
  const slots = story.subjective_slots || {};
  for (const key of Object.keys(slots)) {
    if (slots[key] && Array.isArray(slots[key].lines)) {
      slots[key].lines = _v31Dedupe(slots[key].lines, subjSeen, (x) => x && x.text);
    }
  }

  // 2. Exam findings — dedupe, drop anything already in Subjective, drop symptom/lab lines.
  const obj = story.objective_lines || {};
  const examSeen = new Set();
  obj.exam_findings = (obj.exam_findings || []).filter((f) => {
    const n = _v31Norm(f && f.text);
    if (!n || examSeen.has(n)) return false;
    if (subjSeen.has(n)) return false;                          // already stated in Subjective
    if (_V31_LAB_PAT.test(f.text)) return false;               // lab/imaging result → not exam
    if (!f.is_negative && _V31_SUBJECTIVE_PAT.test(f.text)) return false; // patient-reported → not exam
    examSeen.add(n);
    return true;
  });
  obj.vitals = _v31Dedupe(obj.vitals, new Set(), (x) => (typeof x === 'string' ? x : (x && x.text) || JSON.stringify(x)));

  // 3. PMH lines — dedupe (handle string or {text}).
  if (Array.isArray(story.pmh_lines)) {
    story.pmh_lines = _v31Dedupe(story.pmh_lines, new Set(), (x) => (typeof x === 'string' ? x : x && x.text));
  }

  // 4. Assessment & Plan — dedupe each field within each problem.
  (story.assessment_plan || []).forEach((ap) => {
    ap.narrative = _v31Dedupe(ap.narrative, new Set());
    ap.investigations_planned = _v31Dedupe(ap.investigations_planned, new Set());
    ap.treatment_planned = _v31Dedupe(ap.treatment_planned, new Set());
    ap.referrals = _v31Dedupe(ap.referrals, new Set());
    ap.follow_up = _v31Dedupe(ap.follow_up, new Set());
  });

  return story;
}

export class NarrativeDeduplicator {
  static execute(graph) {
    const story = graph.clinical_story;
    if (!story) return graph;

    // V31: slot-based notes — run cross-section de-duplication so no fact repeats.
    if (story._v31) {
      dedupeV31(story);
      return graph;
    }

    const subj = story.subjective;
    if (!subj) return graph;

    // 1. Merge and dedup negatives
    subj.negatives = mergeNegatives(deduplicateSection(subj.negatives || []));

    // 2. Dedup HPI
    subj.history_presenting_illness = deduplicateSection(subj.history_presenting_illness || []);

    // 3. Remove HPI sentences that are fully subsumed by longer HPI sentences
    subj.history_presenting_illness = removeSubsumedFacts(subj.history_presenting_illness);

    // 4. Dedup symptom characteristics and modifiers
    subj.symptom_characteristics = deduplicateSection(subj.symptom_characteristics || []);
    subj.symptom_modifiers = deduplicateSection(subj.symptom_modifiers || []);
    subj.symptom_progression = deduplicateSection(subj.symptom_progression || []);

    // 5. Dedup associated symptoms
    subj.associated_symptoms = deduplicateSection(subj.associated_symptoms || []);

    // 6. Remove disease management lines that duplicate treatments_planned
    mergeDiseaseManagement(story);
    subj.disease_management = deduplicateSection(subj.disease_management || []);

    // 7. Dedup PMH sections
    const pmh = story.pmh || {};
    pmh.medical_history = deduplicateSection(pmh.medical_history || []);
    pmh.surgical_history = deduplicateSection(pmh.surgical_history || []);
    pmh.family_history = deduplicateSection(pmh.family_history || []);
    pmh.social_history = deduplicateSection(pmh.social_history || []);

    // 8. Dedup each assessment_plan entry
    (story.assessment_plan || []).forEach(ap => {
      ap.evidence = deduplicateSection(removeSubsumedFacts(ap.evidence || []));
      ap.recommendations = deduplicateSection(ap.recommendations || []);
      ap.investigations_planned = deduplicateSection(ap.investigations_planned || []);
      ap.treatments_planned = deduplicateSection(ap.treatments_planned || []);
      ap.referrals = deduplicateSection(ap.referrals || []);
      ap.follow_ups = deduplicateSection(ap.follow_ups || []);
    });

    // 9. Dedup objective sections
    const obj = story.objective || {};
    obj.physical_exam = deduplicateSection(obj.physical_exam || []);
    obj.normal_findings = deduplicateSection(obj.normal_findings || []);

    return graph;
  }
}
