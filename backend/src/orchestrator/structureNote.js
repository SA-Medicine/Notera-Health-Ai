// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Structure a generated note into schema v2.0.0 (Heidi template)
//
// Primary  : Gemini structured-output constrained to the exact template + rules.
// Fallback : deterministic heading parser (runs with no API key — dev/tests).
//
// STRICT RULES (baked into the prompt): only populate a field if explicitly
// mentioned in the transcript/context/clinical note; otherwise leave it blank.
// Never infer, summarise into, or invent content. Do not write "not mentioned".
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { emptyNote, emptyIssue, SCHEMA_VERSION } from '../../../schema/index.js';

const S = (t) => ({ type: 'STRING' });
const GEMINI_NOTE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    note_type: { type: 'STRING' },
    specialty: { type: 'STRING' },
    subjective: {
      type: 'OBJECT',
      properties: {
        reason_for_visit: S(), hpi_details: S(), aggravating_relieving_factors: S(),
        symptom_progression: S(), previous_episodes: S(), functional_impact: S(), associated_symptoms: S(),
      },
    },
    past_medical_history: {
      type: 'OBJECT',
      properties: { medical_surgical: S(), social: S(), family: S(), exposure: S(), immunisation: S(), other: S() },
    },
    objective: {
      type: 'OBJECT',
      properties: { vital_signs: S(), examination: S(), completed_investigations: S() },
    },
    assessment_and_plan: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          issue: S(), diagnosis: S(),
          differential_diagnoses: { type: 'ARRAY', items: { type: 'STRING' } },
          investigations_planned: S(), treatment_planned: S(), referrals: S(),
        },
      },
    },
    medications_mentioned: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['subjective', 'past_medical_history', 'objective', 'assessment_and_plan'],
};

const SYS = `You are Notera's clinical note structuring service. Convert the clinician's note into strict JSON matching the Heidi template (schema v${SCHEMA_VERSION}).

TEMPLATE & FIELD MEANINGS:
Subjective:
- reason_for_visit: reasons for presentation such as requests, symptom complaints, or discussion points.
- hpi_details: duration, timing, location, quality, severity and context of the presenting complaint.
- aggravating_relieving_factors: factors that worsen or alleviate symptoms, including self-treatment attempts and their effectiveness.
- symptom_progression: progression of symptoms over time (changes in frequency, severity, pattern since onset).
- previous_episodes: previous episodes of similar symptoms including management and outcomes.
- functional_impact: impact of symptoms on daily activities, work or social functioning.
- associated_symptoms: associated symptoms, both focal and systemic.
Past Medical History:
- medical_surgical: past medical and surgical history relevant to the visit.
- social: relevant social history (lifestyle, occupation, living situation, substance use, social determinants).
- family: relevant family history (genetic/familial/hereditary).
- exposure: exposure history (environmental, occupational, infectious, toxic).
- immunisation: immunisation history and status.
- other: any other relevant subjective information.
Objective:
- vital_signs: measured or reported vital signs (HR, BP, temp, RR, SpO2).
- examination: physical or mental state examination findings, including system-specific exams.
- completed_investigations: ONLY completed investigations with explicitly mentioned results. Do NOT include planned/ordered tests here.
Assessment & Plan: an ARRAY, one object per issue/request/problem explicitly identified. For each:
- issue: issue, request, problem or condition name.
- diagnosis: diagnosis ONLY if explicitly stated by the clinician. Do NOT infer, summarise or create a diagnosis.
- differential_diagnoses: ONLY if differentials were explicitly listed. Do NOT generate possibilities.
- investigations_planned: tests the clinician stated will be arranged.
- treatment_planned: therapies/medications/interventions the clinician explicitly stated will be initiated.
- referrals: referrals to specialists/allied health/community services explicitly stated.

ABSOLUTE RULES:
1. Only populate a field if the information is EXPLICITLY present in the note/transcript/context. Otherwise leave it as an empty string "" (or empty array []).
2. Never come up with your own patient details, assessment, plan, interventions or diagnoses. Use only the source.
3. Do NOT write phrases like "not mentioned", "N/A", "none documented" — just leave the field blank.
4. Use as many lines/bullets as needed within a field to capture all relevant information (separate lines with \\n).
5. Also fill "medications_mentioned": a flat list of every medication name you wrote anywhere in the note (for safety cross-checking). If none, use [].`;

export async function structureNote(noteText, opts = {}) {
  const { specialty = 'general_primary_care', noteType = 'consultation', llm = null, generatedBy = 'notera-pipeline' } = opts;

  if (llm) {
    try {
      const raw = await llm.generateContent(
        SYS,
        `SPECIALTY: ${specialty}\nNOTE TYPE: ${noteType}\n\nCLINICIAN NOTE / TRANSCRIPT-DERIVED CONTENT:\n${noteText}\n\nReturn ONLY the JSON.`,
        GEMINI_NOTE_SCHEMA,
        { timeoutMs: 60000, maxOutputTokens: 8192 }
      );
      const parsed = JSON.parse(stripFences(raw));
      return normalize(parsed, { specialty, noteType, generatedBy });
    } catch (err) {
      console.warn('[structureNote] Gemini structuring failed, using heading parser:', err.message);
    }
  }
  return headingParser(noteText, { specialty, noteType, generatedBy });
}

// ── Deterministic heading parser (no-key fallback) ───────────────────────────
function headingParser(text, meta) {
  const note = emptyNote(meta);
  const sections = splitSections(String(text || ''));
  const get = (...keys) => { for (const k of keys) if (sections[k]) return sections[k].trim(); return ''; };

  note.subjective.reason_for_visit = get('chief complaint', 'cc', 'presenting complaint', 'reason for visit');
  note.subjective.hpi_details = get('history of present illness', 'hpi', 'history', 'subjective', 'history of presenting complaint');
  note.subjective.associated_symptoms = get('review of systems', 'ros', 'associated symptoms');
  note.subjective.functional_impact = get('functional impact', 'impact');

  note.past_medical_history.medical_surgical = get('past medical history', 'pmh', 'past medical and surgical history', 'medical history');
  note.past_medical_history.social = get('social history', 'social');
  note.past_medical_history.family = get('family history', 'family');
  note.past_medical_history.immunisation = get('immunisation', 'immunization', 'vaccination history');

  note.objective.vital_signs = get('vitals', 'vital signs');
  note.objective.examination = get('examination', 'exam', 'physical exam', 'objective', 'o/e', 'mental state examination');
  note.objective.completed_investigations = get('investigations', 'results', 'labs', 'completed investigations');

  // Build a single A&P issue from assessment/plan text if present.
  const assessment = get('assessment', 'impression', 'assessment and plan', 'assessment & plan', 'a&p');
  const plan = get('plan', 'management');
  const meds = get('medications', 'medications prescribed', 'current medications', 'prescriptions', 'rx');
  const diffs = toList(get('differential diagnosis', 'differentials', 'ddx'));
  const referrals = get('referrals', 'referral');
  const invest = get('investigations planned', 'plan investigations');
  if (assessment || plan || meds || diffs.length || referrals) {
    const issue = emptyIssue();
    issue.issue = firstLine(assessment) || 'Clinical issue';
    issue.diagnosis = assessment;
    issue.differential_diagnoses = diffs;
    issue.investigations_planned = invest;
    issue.treatment_planned = [plan, meds].filter(Boolean).join('\n');
    issue.referrals = referrals;
    note.assessment_and_plan.push(issue);
  }
  // If no headings matched at all, keep the whole note in hpi_details so nothing is lost.
  if (!note.subjective.hpi_details && !note.assessment_and_plan.length && text) {
    note.subjective.hpi_details = String(text).trim();
  }
  note.metadata.medications_mentioned = collectMeds(note);
  return note;
}

function splitSections(text) {
  const out = {};
  const lines = text.replace(/\r/g, '').split('\n');
  let cur = null, buf = [];
  const flush = () => { if (cur) out[cur] = (out[cur] ? out[cur] + '\n' : '') + buf.join('\n').trim(); buf = []; };
  const headingRe = /^\s*#{0,4}\s*\**\s*([A-Za-z/&' -]{2,40})\s*\**\s*:?\s*$/;
  for (const line of lines) {
    const m = line.match(headingRe);
    const key = m && m[1] ? m[1].toLowerCase().replace(/\s+/g, ' ').trim() : null;
    if (key && key.length <= 40 && !/[.]/.test(line)) { flush(); cur = key; }
    else buf.push(line);
  }
  flush();
  return out;
}

function toList(s) {
  if (!s) return [];
  return s.split(/\n|;|,(?![^(]*\))/).map((x) => x.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean);
}
function firstLine(s) { return String(s || '').split('\n')[0].trim(); }
function stripFences(s) { return String(s).replace(/```json\n?|```/g, '').trim(); }

// Coerce a Gemini object into a fully schema-shaped v2 note.
function normalize(p, meta) {
  const n = emptyNote(meta);
  n.note_type = p.note_type || meta.noteType;
  n.specialty = p.specialty || meta.specialty;
  const s = p.subjective || {}, pmh = p.past_medical_history || {}, o = p.objective || {};
  const str = (x) => (typeof x === 'string' ? x : (x == null ? '' : String(x)));
  for (const k of Object.keys(n.subjective)) n.subjective[k] = str(s[k]);
  for (const k of Object.keys(n.past_medical_history)) n.past_medical_history[k] = str(pmh[k]);
  for (const k of Object.keys(n.objective)) n.objective[k] = str(o[k]);
  n.assessment_and_plan = Array.isArray(p.assessment_and_plan) ? p.assessment_and_plan.map((it) => {
    const e = emptyIssue();
    e.issue = str(it.issue); e.diagnosis = str(it.diagnosis);
    e.differential_diagnoses = Array.isArray(it.differential_diagnoses) ? it.differential_diagnoses.filter(Boolean) : (it.differential_diagnoses ? [str(it.differential_diagnoses)] : []);
    e.investigations_planned = str(it.investigations_planned);
    e.treatment_planned = str(it.treatment_planned);
    e.referrals = str(it.referrals);
    return e;
  }) : [];
  n.metadata.medications_mentioned = Array.isArray(p.medications_mentioned) && p.medications_mentioned.length
    ? p.medications_mentioned.filter(Boolean) : collectMeds(n);
  return n;
}

// Extract candidate medication names from treatment/plan text (fallback cross-check source).
function collectMeds(note) {
  const text = [
    ...note.assessment_and_plan.map((i) => i.treatment_planned),
    note.past_medical_history.medical_surgical,
  ].filter(Boolean).join('\n');
  const meds = new Set();
  const re = /\b([A-Z][a-z]{2,}(?:in|ol|ide|one|ine|am|pril|sartan|statin|azole|cillin|mycin|pam|zole))\b/g;
  let m;
  while ((m = re.exec(text))) meds.add(m[1]);
  // also grab "<drug> <dose>mg" patterns
  const re2 = /\b([A-Za-z][a-zA-Z-]{2,})\s+\d+\s?(?:mg|mcg|g|ml|units?)\b/gi;
  while ((m = re2.exec(text))) meds.add(m[1]);
  return [...meds];
}

// ─────────────────────────────────────────────────────────────────────────────
// storyToSchema — DETERMINISTIC map from the pipeline's clinical_story (V31 slots)
// into schema v2. Replaces the lossy 2nd Gemini pass: the pipeline already produced
// this structured data, so we map it directly (no LLM call, no loss, free, fast).
// ─────────────────────────────────────────────────────────────────────────────
const _slotText = (story, key) =>
  (story.subjective_slots?.[key]?.lines || [])
    .map((l) => (typeof l === 'string' ? l : l?.text))
    .filter(Boolean).join('\n');

const _joinLines = (a) =>
  (Array.isArray(a) ? a : a ? [a] : [])
    .map((x) => (typeof x === 'string' ? x : x?.text || ''))
    .filter(Boolean).join('\n');

export function storyToSchema(story, graph = {}, meta = {}) {
  const note = emptyNote(meta);
  if (!story) return note;

  // ── Subjective (flow slots) ──
  note.subjective.reason_for_visit = _slotText(story, 'chief_complaint');
  note.subjective.hpi_details = _slotText(story, 'duration_timing');
  note.subjective.aggravating_relieving_factors = _slotText(story, 'aggravating_relieving');
  note.subjective.symptom_progression = _slotText(story, 'progression');
  note.subjective.previous_episodes = _slotText(story, 'previous_episodes');
  note.subjective.functional_impact = _slotText(story, 'functional_impact');
  note.subjective.associated_symptoms = _slotText(story, 'associated_symptoms');

  // ── PMH (classify the flat pmh_lines into family / social / medical) ──
  const pmh = (story.pmh_lines || []).map((l) => (typeof l === 'string' ? l : l?.text)).filter(Boolean);
  const fam = [], soc = [], med = [];
  for (const l of pmh) {
    if (/^family\s*(history|hx)?\s*[:-]/i.test(l) || /^family history/i.test(l)) fam.push(l.replace(/^family\s*(history|hx)?\s*[:\-]\s*/i, ''));
    else if (/\b(social|occupation|lives|living|smok|alcohol|drink|substance|tobacco)\b/i.test(l)) soc.push(l);
    else med.push(l);
  }
  note.past_medical_history.medical_surgical = med.join('\n');
  note.past_medical_history.social = soc.join('\n');
  note.past_medical_history.family = fam.join('\n');

  // ── Objective: vitals, exam (deduped + region prefix), labs ──
  note.objective.vital_signs = (story.objective_lines?.vitals || [])
    .map((v) => (typeof v === 'string' ? v : v?.text)).filter(Boolean).join('\n');

  const examSeen = new Set(); const exam = [];
  for (const f of (story.objective_lines?.exam_findings || [])) {
    const text = (typeof f === 'string' ? f : f?.text || '').trim();
    if (!text) continue;
    const region = (typeof f === 'object' && f.objective_region_label) || '';
    const line = region && !new RegExp('^' + region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text) ? `${region}: ${text}` : text;
    const n = line.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!n || examSeen.has(n)) continue; examSeen.add(n); exam.push(line);
  }
  note.objective.examination = exam.join('\n');

  const labs = []; const labSeen = new Set();
  const pushLab = (t) => { t = String(t || '').trim(); const n = t.toLowerCase().replace(/[^a-z0-9]/g, ''); if (t && !labSeen.has(n)) { labSeen.add(n); labs.push(t); } };
  const VITAL = /weight|height|bmi|blood\s*pressure|\bbp\b|pulse|heart\s*rate|\bhr\b|respirat|\brr\b|temp|spo2|o2\s*sat/i;
  for (const nd of (graph.numeric_data || [])) {
    const label = nd.test_name || nd.label || nd.metric_type || '';
    if (/\bage\b/i.test(label) || nd.numeric_type === 'age' || VITAL.test(label)) continue;
    if (nd.value != null && nd.value !== '') pushLab(label ? `${label}: ${nd.value}${nd.unit ? ' ' + nd.unit : ''}` : String(nd.value));
  }
  for (const e of (graph.clinical_entities || [])) {
    if ((e.category || e.entity_type) === 'lab_result') pushLab(e.display_text || e.canonical_name || '');
  }
  note.objective.completed_investigations = labs.join('\n');

  // ── Assessment & Plan (title-echo strip + duplicate-title merge) ──
  const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const _merge = (a, b) => [a, b].filter(Boolean).join('\n');
  const apByTitle = new Map();
  for (const p of (story.assessment_plan || [])) {
    const title = p.title || '';
    const titleN = _norm(title);
    const narrative = (Array.isArray(p.narrative) ? p.narrative : p.narrative ? [p.narrative] : [])
      .map((x) => (typeof x === 'string' ? x : x?.text || ''))
      .filter((t) => t && _norm(t) !== titleN)
      .join('\n');
    const key = titleN || `__${apByTitle.size}`;
    let issue = apByTitle.get(key);
    if (!issue) { issue = emptyIssue(); issue.issue = title; apByTitle.set(key, issue); }
    issue.assessment = _merge(issue.assessment, narrative);
    if (!issue.diagnosis && p.certainty === 'confirmed' && p.diagnosis) issue.diagnosis = p.diagnosis;
    if (Array.isArray(p.differential_diagnoses)) {
      issue.differential_diagnoses = [...new Set([...(issue.differential_diagnoses || []), ...p.differential_diagnoses.filter(Boolean)])];
    }
    issue.investigations_planned = _merge(issue.investigations_planned, _joinLines(p.investigations_planned));
    issue.treatment_planned = _merge(issue.treatment_planned, _joinLines(p.treatment_planned));
    issue.referrals = _merge(issue.referrals, _joinLines(p.referrals));
    const fu = _joinLines(p.follow_up);
    if (fu) issue.treatment_planned = _merge(issue.treatment_planned, fu);
  }
  note.assessment_and_plan = [...apByTitle.values()];

  note.metadata.medications_mentioned = collectMeds(note);
  return note;
}
