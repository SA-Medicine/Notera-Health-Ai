// ─────────────────────────────────────────────────────────────────────────────
// heidiStoryEngine — full-transcript Heidi note composer (the "story engine").
//
// Reads the ENTIRE transcript (sole source of truth) plus the deterministic note as
// a grounding scaffold, and writes the complete Heidi SOAP note in one intelligent,
// step-by-step pass: richer, flowing prose; problems RANKED primary→incidental with
// COMPLETE diagnosis titles; Objective/PMH organised by problem when several exist.
//
// Freedom with rails:
//   • Grounding — only facts explicitly in the transcript. No invention, ever.
//   • Anti-hallucination — a mere mention is NOT a problem; a problem whose title words
//     are absent from the transcript is dropped after generation.
//   • Completeness — scaffold facts (numbers/meds) are never lost: if the engine output
//     is empty/invalid or drops the plan, we fall back to the scaffold note.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
import { emptyNote, emptyIssue, validateNote } from '../../../schema/index.js';
import { collectMeds } from './structureNote.js';

const S = () => ({ type: 'STRING' });
const A = () => ({ type: 'ARRAY', items: { type: 'STRING' } });

const NOTE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    subjective: { type: 'OBJECT', properties: {
      reason_for_visit: S(), hpi_details: S(), aggravating_relieving_factors: S(),
      symptom_progression: S(), previous_episodes: S(), functional_impact: S(), associated_symptoms: S() } },
    past_medical_history: { type: 'OBJECT', properties: {
      medical_surgical: S(), social: S(), family: S(), exposure: S(), immunisation: S(), other: S() } },
    objective: { type: 'OBJECT', properties: { vital_signs: S(), examination: S(), completed_investigations: S() } },
    assessment_and_plan: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      issue: S(), diagnosis: S(), assessment: S(), differential_diagnoses: A(),
      investigations_planned: S(), treatment_planned: S(), referrals: S() } } },
    medications_mentioned: A(),
  },
  required: ['subjective', 'past_medical_history', 'objective', 'assessment_and_plan'],
};

const SYS = `You are Notera's Heidi Story Engine — an expert clinical scribe. You are given the
FULL consultation transcript (the ONLY source of truth) and a draft "scaffold" note of facts
already extracted from it. Write the COMPLETE Heidi SOAP note: intelligent, flowing, and MORE
complete than the scaffold — read the whole transcript and tell the clinical story step by step,
the way the encounter actually unfolded.

FIELD MEANINGS (Heidi template — fill only from the transcript, leave blank if truly absent):
Subjective — reason_for_visit; hpi_details (duration, timing, location, quality, severity,
context); aggravating_relieving_factors; symptom_progression; previous_episodes;
functional_impact; associated_symptoms (focal + systemic, including pertinent negatives).
Past Medical History — medical_surgical; social; family; exposure; immunisation; other.
Objective — vital_signs; examination (exam findings only); completed_investigations (results only,
never planned tests).
Assessment & Plan — one entry per real problem: issue, diagnosis (only if explicitly stated),
assessment (interpretation/status/response — NOT a retell of the history), differential_diagnoses
(only if explicitly listed), investigations_planned, treatment_planned, referrals.

HOW TO WRITE IT WELL:
1. STORY & FLOW: write natural, connected clinical prose — not disjoint fragments. Summarise
   intelligently; use as much text as needed to capture everything relevant (be thorough, not terse).
2. RANK PROBLEMS: order Assessment & Plan by clinical importance — the primary reason for the
   visit first, incidental items last.
3. COMPLETE DIAGNOSIS TITLES: always the most specific diagnosis the transcript supports —
   "Iron deficiency anaemia", NOT bare "Anaemia"; "Type 2 diabetes mellitus", NOT "Diabetes";
   include subtype/etiology when stated ("… secondary to gastric ulcer").
4. ORGANISE BY PROBLEM: when there are two or more problems, label the Objective findings and
   the relevant Past Medical History by the problem they belong to (e.g. begin the line with the
   complete issue title, "Iron deficiency anaemia: Hb 90 …"), so each problem's facts stay together.
5. BODY-PART GROUPING: for musculoskeletal / multi-region encounters, group the subjective story
   by body part (e.g. "Right Hip/Leg: …", "Right Hand: …").

PLACEMENT & CONSISTENCY (every fact in exactly one right place):
P1. NUMERIC LAB / VITAL VALUES (e.g. "Haemoglobin 88", "iron low", "BP 130/80") belong ONLY in
    Objective. Do NOT put a lab or vital VALUE in Subjective. Subjective may say a trend in words
    ("anaemia not improving") but must not carry the number.
P2. ONE VALUE PER MEASUREMENT: never state two different values for the same measurement. If the
    transcript gives a current and a previous value, write it once, unambiguously, in Objective
    (e.g. "Haemoglobin 88 (previously 87), normal 120"). Never contradict yourself across sections.
P3. REFERRALS belong ONLY in the Assessment & Plan "referrals" field — never in Subjective.
P4. Do NOT repeat NORMAL lab results inside Assessment & Plan. Normal results live in Objective;
    the assessment interprets, it does not relist normals. Only cite an abnormal result in an
    assessment when tying it to the clinical impression ("Hb not improving despite oral iron").
P5. GROUP a problem's own medications under that problem — do not leave a related drug (e.g. the
    stomach/ulcer pills) as a separate orphan item.
P6. PRESERVE QUALIFIERS exactly as stated: timing ("last year", "~1 month ago"), etiology
    ("secondary to gastric ulcer"), and specific denials ("denies bleeding from the pills", not
    just "denies bleeding"). Do not generalise a specific denial into a vague one.

ANTI-HALLUCINATION (critical):
A. A thing merely MENTIONED in passing is NOT automatically a problem. Only create a numbered
   problem for something the clinician actually ASSESSED or ACTED ON (diagnosis, work-up,
   medication/management decision, screening discussed).
B. An incidental symptom the patient says is already handled by another clinician is CONTEXT,
   not a problem — do not create a problem, plan or referral for it, and do not let it displace
   the real reason for the visit (e.g. a refill request).
C. NEVER invent a disease, medication, dose, value, referral or diagnosis not in the transcript.
   Distinguish what is important from what is minor; do not manufacture problems to fill space.

ABSOLUTE: use only the transcript. Do not write "not mentioned"/"N/A"/"none". Keep every fact from
the scaffold that the transcript supports. Also return "medications_mentioned": every medication
name you used. Return STRICT JSON matching the given schema.`;

function scaffoldSummary(note) {
  const parts = [];
  const sub = note.subjective || {};
  for (const [k, v] of Object.entries(sub)) if (String(v).trim()) parts.push(`  ${k}: ${v.replace(/\n/g, ' | ')}`);
  const pmh = note.past_medical_history || {};
  const ph = Object.entries(pmh).filter(([, v]) => String(v).trim()).map(([k, v]) => `  ${k}: ${v.replace(/\n/g, ' | ')}`);
  const obj = note.objective || {};
  const ob = Object.entries(obj).filter(([, v]) => String(v).trim()).map(([k, v]) => `  ${k}: ${v.replace(/\n/g, ' | ')}`);
  const ap = (note.assessment_and_plan || []).map((i, n) => `  ${n + 1}. ${i.issue} — ${i.assessment || ''} ${i.treatment_planned || ''}`.trim());
  return [
    'SUBJECTIVE:', parts.join('\n') || '  (none)',
    'PAST MEDICAL HISTORY:', ph.join('\n') || '  (none)',
    'OBJECTIVE:', ob.join('\n') || '  (none)',
    'ASSESSMENT & PLAN:', ap.join('\n') || '  (none)',
  ].join('\n');
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
const contentWords = (s) => norm(s).split(' ').filter((w) => w.length > 3);

export async function composeStory(scaffoldNote, opts = {}) {
  const { llm = null, transcript = '', meta = {} } = opts;
  if (!llm || !transcript.trim() || !scaffoldNote) return scaffoldNote;

  let out;
  try {
    const raw = await llm.generateContent(
      SYS,
      `TRANSCRIPT (sole source of truth):\n"""\n${transcript}\n"""\n\nSCAFFOLD (facts already extracted — keep all that the transcript supports, and add what it missed):\n${scaffoldSummary(scaffoldNote)}\n\nWrite the complete Heidi note. Return ONLY JSON.`,
      NOTE_SCHEMA,
      { timeoutMs: 180000, retries: 1, maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536, thinkingBudget: 0 }
    );
    out = JSON.parse(String(raw).replace(/^```(json)?/i, '').replace(/```$/, '').trim());
  } catch (e) {
    console.warn('[heidiStoryEngine] failed, using scaffold note:', e.message);
    return scaffoldNote;
  }

  // Build a candidate note from the engine output, guarded against loss/hallucination.
  const tnums = new Set(String(transcript).match(/\d+(?:\.\d+)?/g) || []);
  const tWordSet = new Set(contentWords(transcript));
  const note = emptyNote(meta);
  note.specialty = scaffoldNote.specialty;
  note.metadata = scaffoldNote.metadata;

  const groundNumbers = (text, fallback) => {
    const t = String(text || '').trim();
    if (!t) return fallback || '';
    for (const n of (t.match(/\d+(?:\.\d+)?/g) || [])) if (!tnums.has(n)) return fallback || t; // ungrounded number → prefer scaffold
    return t;
  };
  const keepBest = (engineVal, scaffoldVal) => {
    const e = groundNumbers(engineVal, scaffoldVal);
    // never lose scaffold content words
    if (scaffoldVal && String(scaffoldVal).trim()) {
      const sw = contentWords(scaffoldVal); const eset = new Set(contentWords(e));
      const kept = sw.filter((w) => eset.has(w)).length;
      if (!e.trim() || (sw.length && kept / sw.length < 0.7)) return scaffoldVal; // engine dropped too much
    }
    return e || scaffoldVal || '';
  };

  for (const k of Object.keys(note.subjective)) note.subjective[k] = keepBest(out.subjective?.[k], scaffoldNote.subjective[k]);
  for (const k of Object.keys(note.past_medical_history)) note.past_medical_history[k] = keepBest(out.past_medical_history?.[k], scaffoldNote.past_medical_history[k]);
  for (const k of Object.keys(note.objective)) note.objective[k] = keepBest(out.objective?.[k], scaffoldNote.objective[k]);

  // Assessment & Plan: take engine problems, drop hallucinated titles, keep at least scaffold.
  const engineAP = Array.isArray(out.assessment_and_plan) ? out.assessment_and_plan : [];
  const cleaned = [];
  for (const p of engineAP) {
    const title = String(p.issue || '').trim();
    if (!title) continue;
    // title must be grounded: a significant word of the title appears in the transcript
    const tw = contentWords(title);
    if (tw.length && !tw.some((w) => tWordSet.has(w))) continue; // hallucinated problem → drop
    const issue = emptyIssue();
    issue.issue = title;
    issue.diagnosis = groundNumbers(p.diagnosis, '');
    issue.assessment = groundNumbers(p.assessment, '');
    issue.differential_diagnoses = Array.isArray(p.differential_diagnoses) ? p.differential_diagnoses.filter(Boolean) : [];
    issue.investigations_planned = groundNumbers(p.investigations_planned, '');
    issue.treatment_planned = groundNumbers(p.treatment_planned, '');
    issue.referrals = groundNumbers(p.referrals, '');
    cleaned.push(issue);
  }
  note.assessment_and_plan = cleaned.length ? cleaned : scaffoldNote.assessment_and_plan;
  note.metadata.medications_mentioned = collectMeds(note);

  // Final safety: engine note must be schema-valid and not lose the plan entirely.
  const { valid } = validateNote(note);
  if (!valid || (scaffoldNote.assessment_and_plan.length && !note.assessment_and_plan.length)) {
    console.warn('[heidiStoryEngine] guard tripped, using scaffold note');
    return scaffoldNote;
  }
  return note;
}
