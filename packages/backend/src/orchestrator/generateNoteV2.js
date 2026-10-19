// ─────────────────────────────────────────────────────────────────────────────
// generateNoteV2 — the fast path (PIPELINE_MODE=v2).
//
//   transcript ──┬─► WRITER      one structured-output call  → full SOAP JSON      (~10-25 s)
//                └─► CHECKLIST   one tiny call (in parallel) → meds/results/orders (~3-6 s)
//                       │
//                deterministic merge (adds only what the transcript really says)
//                       │
//                VERIFIER      one tiny call → unsupported + duplicate line ids    (~3-6 s)
//                       │      (the model PROPOSES, code CONFIRMS before deleting)
//                deterministic stages: reconcile · guardrails · condense · dedupe · render
//
// 3 LLM calls (2 in parallel) instead of 6-10 in series; every call has its own deadline,
// at most one retry on 429/5xx, and there is NO fallback chain: if the writer fails the job
// errors out (retriable) rather than cascading into more LLM stages.
// Result shape is identical to generateNote() so callers/eval/UI don't change.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import fs from 'node:fs';

import { emptyNote, emptyIssue, validateNote } from '@notera/schema';
import { createGeminiService } from '../services/LLMService.js';
import { store, audit } from '../firestore/store.js';
import { runGuardrails } from '../validation/guardrails.js';
import { applyUpgradeGuardrails, isBlankEncounter, classifyEncounterDeterministic } from '../validation/upgrades.js';
import { reconcileNote } from './reconcileNote.js';
import { enforceTemplate, fixMisplacement, drugPlausibility, checkInput } from './postGuards.js';
import { condenseNote } from './condenseNote.js';
import { dedupeNote } from './dedupeNote.js';
import { noteToMarkdown } from './renderMarkdown.js';
import { collectMeds } from './structureNote.js';
import { getActivePrompt, getActivePromptMeta } from './promptStore.js';
import { effectiveConfig } from './runtimeConfig.js';
import { pickExemplars, exemplarBlock } from './exemplars.js';
import { guardDrugNames } from './drugGuard.js';

const PIPELINE_VERSION = process.env.PIPELINE_VERSION_V2 || 'notera-pipeline-v2.0';

const S = () => ({ type: 'STRING' });
const A = () => ({ type: 'ARRAY', items: { type: 'STRING' } });

export const WRITER_SCHEMA = {
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
  },
  required: ['subjective', 'past_medical_history', 'objective', 'assessment_and_plan'],
};

const WRITER_SYS = `You are Notera, an expert clinical scribe. Write the SOAP note for this consultation using ONLY the transcript. The clinician will sign it, so it must read like a note a careful physician wrote.

OUTPUT RULES (hard):
- Output the note ONLY. Never write commentary, reasoning, or instructions to yourself ("Let's…", "as per transcript", "without additions", "leave this unstated", "none stated", "not mentioned", "N/A", "unknown"). If the transcript does not say something, leave that field "" or omit the line. Never describe what you did not find.
- Clinical third-person wording, past/present tense, no first person and no quotes of the patient. Convert colloquial speech to the clinical term ("poop test" → "stool test", "my heart's racing" → "palpitations"). Never copy speech fragments or filler ("starting to bother me; now starting to bother me").
- One fact per line, each line a short phrase (about 4-18 words). Put lines in a field separated by "\\n". No paragraphs, no repeated facts, no restating a fact in another section.
- Keep every clinically specific detail exactly: numbers, doses (drug + strength + frequency), units, dates, durations, laterality, test names, specific denials ("denies bleeding from the pills", not "denies bleeding").
- Do not invent or infer anything. Do not add a diagnosis, drug, value, referral or date that was not said.

WHERE EACH FACT GOES
Subjective = what the patient reports and the history of the visit:
  reason_for_visit: why they came / follow-up topics, as one short line per topic.
  hpi_details: onset, course, location, quality, severity, context; also lifestyle the patient reports (diet, exercise, work) as "Diet: …", "Exercise: …".
  aggravating_relieving_factors, symptom_progression, previous_episodes, functional_impact (what the problem stops them doing), associated_symptoms (pertinent positives AND negatives).
Past Medical History = established conditions and history, one per line, with status ("Vasovagal palpitations - resolved", "Hypertension on valsartan 160mg and amlodipine 2.5mg"):
  medical_surgical; social (occupation, smoking, alcohol, drugs, living situation: ONLY if stated); family; exposure; immunisation;
  other: ALL current medications as one line "Current medications: drug dose, drug dose, …" (include supplements); and "Preventive care: …" for screening/vaccines said to be done or up to date.
Objective = MEASURED or EXAMINED only: vital_signs (BP/HR/temp/weight with values and where measured, e.g. "BP 142/85 at home", "BP 132/80 in clinic"), examination (clinician's exam findings), completed_investigations (each completed test WITH its result and date if stated, e.g. "Ultrasound face: multiple small subcutaneous lymph nodes, mild inflammation, no fluid collection"). Never put symptoms, history, medications, plans or lifestyle in Objective.
Assessment & Plan = ONE entry per problem the clinician addressed, most important first:
  issue: the specific problem/diagnosis title.
  diagnosis: ONLY a diagnosis the clinician named or clearly concluded, with status ("Hypertension - controlled", "Suspected sleep apnea - pending assessment" only when the clinician said suspected). If the clinician named no diagnosis for this problem, leave diagnosis EMPTY (""). Never infer a diagnosis from symptoms or from a drug, never restate the symptom as the diagnosis, and never turn a test or a rule-out into a diagnosis.
  assessment: the clinician's interpretation only if stated; otherwise "".
  differential_diagnoses: only if the clinician listed them.
  investigations_planned: tests ordered ("X-ray right foot").
  treatment_planned: medication decisions (continue/start/stop/change with dose), advice, monitoring, who the patient should call or what to do next; separate items with "; ".
  referrals: referral target and service ("Foot surgeon").
  Add a LAST entry issue "Follow-up" ONLY if a return/follow-up time was stated: treatment_planned "Rtc: <timing as stated>".
Do not repeat the history inside the plan; the plan states decisions.

STYLE EXAMPLE (format and terseness only; never copy its content):
Subjective: "- Burn to left hand - grabbed hot pot at work" / "- Blister developed on left middle finger" / "- Has been applying flamazine cream and soaking in cold water"
Objective: "- Left hand: second degree burn with blister on left middle finger, swelling present" / "- No signs of infection"
A&P: issue "Second degree burn, left hand"; diagnosis "Second degree burn, left hand"; treatment_planned "flamazine cream tid; dressing applied; Tylenol or Advil prn for pain; leave open to air dry at home"; then issue "Follow-up", treatment_planned "Rtc: <date as stated>".

Return STRICT JSON matching the schema.`;

const CHECK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    medications: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: S(), detail: S(), status: S() } } },
    results: { type: 'ARRAY', items: { type: 'OBJECT', properties: { test: S(), value: S(), date: S() } } },
    orders: A(), referrals: A(), follow_up: S(),
  },
};
// Extended recall (the "fact recovery" role of the old multi-agent pipeline): the same helper call also lists the history,
// findings, symptoms and specific details the writer tends to drop. Everything is merged by code only if the transcript says it.
const CHECK_SCHEMA_X = { type: 'OBJECT', properties: { ...CHECK_SCHEMA.properties,
  history: { type: 'ARRAY', items: { type: 'OBJECT', properties: { kind: S(), text: S() } } },
  findings: { type: 'ARRAY', items: { type: 'OBJECT', properties: { kind: S(), text: S() } } },
  symptoms: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: S(), present: { type: 'BOOLEAN' } } } },
  specifics: A() } };
const CHECK_EXTRA = `
- history: past medical/surgical history, family history, social history (occupation, smoking, alcohol, living situation) and immunisations the PATIENT's record includes. kind = "medical","surgical","family","social" or "immunisation"; text = short phrase.
- findings: examination findings and vitals the clinician states they observed or measured in this visit. kind = "exam" or "vital"; text = short phrase with the value.
- symptoms: every symptom the patient reports and every explicit denial. text = the symptom ("fever", "pain with walking"); present = true if reported, false if denied.
- specifics: concrete details a good note keeps: exact quantities (weights, steps, amounts), durations ("on Zepbound 7.5 mg for two months"), named people/places/pharmacies, test dates and what a medication is for. One short phrase each.`;
const CHECK_SYS = `You extract a fact checklist from a clinical consultation transcript. Return ONLY items explicitly stated in the transcript; never infer.
- medications: every drug the patient takes, is started, changed, stopped or prescribed. name = drug as spoken; detail = dose/frequency/route if stated; status = one of "current","new","changed","stopped","declined".
- results: every COMPLETED test/exam measurement WITH its stated value (labs, vitals, imaging results). test, value (with units/flag), date if stated.
- orders: tests/imaging the clinician ordered or planned (no results). referrals: referrals to a named service/specialist. follow_up: the stated return/follow-up timing ("" if none).
Keep strings short. Return strict JSON.`;

const VERIFY_SYS = `You are a strict fact-checker for a clinical note. You get the TRANSCRIPT (sole source of truth) and the NOTE as numbered lines.
Return JSON {"unsupported":[{"id":N,"reason":"..."}],"duplicates":[[keepId,dropId],...]}.
- unsupported: a line (or the specific claim in it) that states something the transcript does NOT say — an invented name, drug, dose, number, date, finding, diagnosis, plan or referral. A clinically reasonable summary of what WAS said is NOT unsupported. When unsure, do NOT list it.
- duplicates: pairs of lines that state the same fact (possibly worded differently); keepId = the more specific/complete line, dropId = the redundant one.
Return {"unsupported":[],"duplicates":[]} if the note is clean. Output only JSON.`;

// The clinic's evolved documentation rules (prompt store "clinical-story" v11, tuned by the System Upgrader against
// gold notes), condensed and adapted to ONE call that writes the SOAP JSON. The full v11 text was tested verbatim and
// made notes shorter and slower (9k tokens; its "no diagnosis unless confirmed" rule removed the Diagnosis lines the
// gold notes always have), so only the rules that matter are kept, rewritten so none of them contradict the format.
const CLINIC_RULES = `CLINIC DOCUMENTATION RULES (all mandatory):
IDENTITY: document only the PATIENT. If a caregiver, relative or companion mentions their own symptoms, history or plans, leave them out completely.
GROUNDING: never assume or generate clinical content the transcript does not support. A brief or empty session stays empty; never invent a presentation, plan, referral or value.
DATES: never create or estimate a calendar date. Keep relative phrasing as spoken ("three weeks ago", "since high school"). When an exact date is spoken (return-to-clinic, expiry, test date) keep it exactly.
NAMES AND LOGISTICS: keep specific pharmacies, imaging centres, labs, clinics, specialists, lot numbers, specimen IDs and expiry dates exactly as spoken. Keep named rule-out targets ("rule out cuboid fracture").
MEDICATIONS: never replace a drug name with a generic phrase ("thyroid medication") or swap one drug for another. Always keep name + strength + frequency/route as stated, and whether it is continued, started, stopped, changed or only discussed. A drug only compared as an option is NOT a treatment: never write "Continue X" for it. A patient's request or question about a drug or procedure goes in the reason for visit; it is not a relieving factor unless they confirmed relief.
TESTS AND RESULTS: keep exact test and analyte names with their values (Total cholesterol, LDL, HDL, TSH, Free T4, FIT, ferritin, B12). Never write "stool test" for a named FIT, and never turn LDL into ADL. Pair each value with its named analyte. Reviewed labs and imaging must appear in Objective (or PMH when historical); abnormal ones that need follow-up become problems with a plan.
NEGATIONS: every explicit denial (no fever, no numbness, denies cough) must appear in associated_symptoms. Omitting negations is a failure.
TIMEFRAMES: keep exact timeframes ("3 days ago", "for 7 years"); never generalise them to "recently".
MULTI-TOPIC VISITS: when the visit covers more than one topic or body part, prefix each line with its topic ("Right foot: ...", "Hypertension: ...") and order topics as they were first raised. Do not add prefixes when there is only one topic.
PMH: diagnosed background conditions, prior surgeries and procedures, family and social history. NOT the current complaint's own episodes and NOT active symptoms; those go in Subjective. Include baseline conditions even on a brief renewal visit.
OBJECTIVE: only what was observed, examined or measured: clinician exam findings (including visual findings and negative findings such as "no palpable mass"), vitals, completed results. Never patient-reported symptoms, never disclaimers ("no exam done", "telehealth"): leave the field empty instead.
ONE PLACE: every fact appears exactly once across the whole note. Do not repeat Subjective facts in Objective, PMH or the plan.
PROBLEMS: one entry for each issue the clinician actually assessed or acted on (a diagnosis, a worked-up symptom, a managed or prescribed secondary complaint, a lab abnormality needing action, a screening discussed). Keep distinct diagnoses separate. A cause stays with its parent problem ("Iron deficiency anaemia secondary to gastric ulcer"), not a separate entry. A symptom mentioned in passing that another clinician is already handling is context, not a problem: no plan or referral for it. Do not promote an unassessed mention or a normal screening result to a problem.
RENEWALS AND REFILLS: a refill or chronic-condition renewal IS a problem even with no new symptom: never drop the plan section for a renewal visit. If each medication has its own decision (dose change, switch, new request, its own pharmacy) write one problem per medication with the exact dose change/continuation, quantity and pharmacy. A single bulk request with shared logistics and no per-drug decision is one problem listing the medications, quantity and pharmacy. If a renewal was already completed, say so; do not plan a new prescription for it.
PROBLEM TITLES: the most specific diagnosis the clinician supports, including subtype and cause ("Type 2 diabetes mellitus", not "Diabetes"). Never a vague fragment ("the red one", "thyroid") and never a generic bucket ("Other active issues").
ASSESSMENT: the clinician's interpretation, status, response to treatment and pertinent results, not a retelling of the history, and not a bare lab value (cite a value only with its interpretation: "HbA1c 6.2, improved"). Also capture declined screening/referrals with the reason, forms or requisitions provided, routine follow-ups due, and dose-change discussions that did not result in a change.
PLAN FIELDS: short natural clinical phrases that carry the transcript's context ("X-ray of left foot arranged", "Wegovy 0.25mg prescribed pending insurance approval", "Discontinue ashwagandha"). Include supplement changes and stopped drugs. One entry per distinct action, never repeated. Name referrals and who they are to, including offered or declined ones. Never write the word "None": leave the field empty.
FORBIDDEN: prose starting "The patient..." or "The clinician...", clinical reasoning or standard-of-care text that was not said, duplicated lines, markdown asterisks inside field text.`;
function clinicRules() { return CLINIC_RULES; }

/** The built-in writer system prompt (instructions + clinic rules). The lab reads this as the baseline to improve. */
export const WRITER_PROMPT_NAME = 'v2-writer';
export const CHECKLIST_PROMPT_NAME = 'v2-checklist';
export const VERIFIER_PROMPT_NAME = 'v2-verifier';
export const EDITOR_PROMPT_NAME = 'v2-editor';
export const STORY_PROMPT_NAME = 'v2-story';
/** Every LLM prompt in the pipeline, editable from the admin console. `must` = substrings a replacement has to keep
 *  (the code that parses the model's answer depends on them), so a bad edit is rejected instead of breaking notes. */
export const PROMPT_REGISTRY = {
  [WRITER_PROMPT_NAME]:    { stage: 'Writer', label: 'Note writer', help: 'Drafts the whole SOAP note from the transcript. The main quality lever.', default: () => defaultWriterPrompt(), must: ['JSON'], min: 800 },
  [CHECKLIST_PROMPT_NAME]: { stage: 'Checklist', label: 'Fact checklist', help: 'Extracts medications, results, orders, referrals and follow-up so nothing the writer drops is lost.', default: () => CHECK_SYS, must: ['medications', 'results', 'orders', 'referrals', 'follow_up', 'JSON'], min: 200 },
  [EDITOR_PROMPT_NAME]:    { stage: 'Editor', label: 'Reviewer (editor pass)', help: 'Optional second pass that fixes section placement, plan attribution, contradictions with the transcript and padding in the writer\'s draft. Off unless Settings → Editor pass is on.', default: () => EDITOR_SYS, must: ['JSON', 'TRANSCRIPT'], min: 400 },
  [STORY_PROMPT_NAME]:     { stage: 'Story', label: 'Story agent', help: 'Last step: rewrites the Subjective into a flowing, grammatical clinical story, without adding or losing any fact. Off unless Settings → Story agent is on.', default: () => STORY_SYS, must: ['JSON', 'TRANSCRIPT'], min: 400 },
  [VERIFIER_PROMPT_NAME]:  { stage: 'Verifier', label: 'Fact verifier', help: 'Flags note lines the transcript does not support and duplicate lines. Code confirms every flag before removing anything.', default: () => VERIFY_SYS, must: ['unsupported', 'duplicates', 'JSON'], min: 200 },
};
// Added after the 100-note A/B on gemini-3.7-flash (docs/reports/HISTORY_90_FINDINGS + FINAL_37_ROLLOUT): +1.7 parity, completeness 3.89 → 4.06.
const COMPLETENESS_RULES = `COMPLETENESS (this clinic's clinicians record the following; leaving them out is the most common error):
- Every lab or imaging result named in the visit WITH its value and, when stated, its date; every vital sign with its value.
- Every medication mentioned: name, strength, frequency, what it is for, and whether it is continued, started, stopped or changed; include supplements and over-the-counter products.
- Every past medical, surgical and family history item mentioned, including explicit negatives ("no family history of colon cancer").
- Exact timelines (how long, since when, previous episodes) and each concrete detail the patient gives (amounts, counts, triggers, what has been tried).
- Each plan item with its specifics: what, who, where and when (pharmacy, referral target, test, follow-up timing), and what the patient agreed to or declined.
Completeness means no clinical fact is left out; it does not mean longer sentences. Keep one short fact per line.`;
// v3 (2026-10-20): produced by the Lab's "prompt upgrade from a diagnosis report" (audits + logs + clinic template), validated on 100 unseen
// notes (parity 85.2 vs 83.0, strict gold audit 63.2 vs 61.0, critical wrong claims 0.25 vs 0.31 per note). Lives in prompts/writer-v3.txt;
// the earlier hand-written prompt below is only the fallback if that file is missing.
let _v3 = null;
export function defaultWriterPrompt() {
  if (_v3 === null) { try { _v3 = fs.readFileSync(new URL('../../prompts/writer-v3.txt', import.meta.url), 'utf8').replace(/\r/g, '').trim(); } catch { _v3 = ''; } }
  return _v3 || `${WRITER_SYS}\n\n${clinicRules()}\n\n${COMPLETENESS_RULES}`;
}

// ── deterministic cleaner: the writer must never leak reasoning or filler into a clinical note ──
const META_RX = [
  /\b(none|nothing|not|un)\s?(stated|mentioned|specified|discussed|documented|given|provided|recorded|reported)\b/i,
  /\bnot (?:specifically )?(?:measured|noted|available|applicable)\b/i,
  /\b(?:n\/?a|unknown|unstated)\b/i,
  /\b(?:as per|according to) (?:the )?transcript\b/i,
  /\btranscript(?:'s)? (?:context|text)\b/i,
  /\bwithout (?:any )?(?:additions?|assumptions?)\b/i,
  /\bbeyond what is (?:literally )?mentioned\b/i,
  /^\s*(?:let'?s|let us|i will|i'll|note that|note:|here is|here's|okay|ok,)\b/i,
  /\b(?:leave|list) (?:exact )?(?:other )?(?:vitals?|this|these)\b.*\b(?:unstated|as stated)\b/i,
  /\bin passing conversation context\b/i,
  /\bgeneral location mentioned\b/i,
  /\btranscript\b/i,            // a clinical note never refers to "the transcript": that is the model talking about its input
  /\bnone specifically\b/i,
];
const isMeta = (ln) => META_RX.some((rx) => rx.test(ln));
function splitSentences(ln) {
  if (ln.length <= 260) return [ln];
  return ln.split(/(?<=[.;])\s+(?=[A-Z0-9])/).map((x) => x.trim()).filter(Boolean);
}
/** Model-degeneration guard (seen in the 50-note audit): "the patient or the patient or the patient…" and "X, the patient, the patient".
 *  Collapses any 1–6 word phrase repeated 3+ times in a row, drops repeated/dangling "the patient" artefacts. */
export function collapseLoops(s) {
  let t = String(s || '');
  t = t.replace(/\b((?:[\w'’-]+\s+){0,5}[\w'’-]+)(?:\s*[,;]?\s*(?:or|and)?\s+\1\b){2,}/gi, '$1');
  t = t.replace(/(?:\s*[,;]?\s*(?:or|and)?\s*\bthe patient\b){2,}/gi, '');
  t = t.replace(/\s+the patient[.,;]*$/i, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

function cleanText(text, { splitSemi = false } = {}) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    let ln = raw.replace(/^\s*[-•*]\s*/, '').trim();
    if (!ln) continue;
    // History/exam fields are one fact per line: "a; b; c" becomes three lines. Plan fields keep their "; " lists.
    const pieces = splitSemi ? ln.split(/\s*;\s+/).filter(Boolean) : [ln];
    for (let part of pieces.flatMap((x) => splitSentences(x))) {
      part = collapseLoops(part.replace(/\s{2,}/g, ' ')).replace(/[;,]+$/, '').trim();
      if (!part || isMeta(part)) continue;
      if (part.length > 420) part = part.slice(0, 420).replace(/\s+\S*$/, '');   // runaway line: cut at a word boundary
      out.push(part);
    }
  }
  const seen = new Set(); const uniq = [];
  for (const l of out) { const k = l.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); if (k && !seen.has(k)) { seen.add(k); uniq.push(l); } }
  return uniq.slice(0, 40).join('\n');
}
export function cleanNote(note) {
  let removed = 0;
  const clean = (v, opts) => { const before = String(v || '').split('\n').filter((x) => x.trim()).length; const c = cleanText(v, opts); removed += Math.max(0, before - c.split('\n').filter(Boolean).length); return c; };
  for (const [sec, keys] of [['subjective', Object.keys(note.subjective)], ['past_medical_history', Object.keys(note.past_medical_history)], ['objective', Object.keys(note.objective)]]) {
    for (const k of keys) note[sec][k] = clean(note[sec][k], { splitSemi: true });
  }
  note.assessment_and_plan = (note.assessment_and_plan || []).map((p) => {
    for (const f of ['diagnosis', 'assessment', 'investigations_planned', 'treatment_planned', 'referrals']) p[f] = clean(p[f]);
    p.differential_diagnoses = (p.differential_diagnoses || []).filter((d) => d && !isMeta(d));
    return p;
  }).filter((p) => p.issue && !isMeta(p.issue));
  return removed;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w.length > 3);
const NUMWORD = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const numWordsToDigits = (s) => String(s || '').replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi, (w) => String(NUMWORD[w.toLowerCase()]));
const numsOf = (s) => String(s || '').match(/\d+(?:\.\d+)?/g) || [];

function parseJson(raw) {
  const s = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch { /* repair below */ }
  const start = s.indexOf('{'); if (start < 0) return null;
  let inStr = false, esc = false; const stack = [];
  const body = s.slice(start);
  for (const c of body) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']'); else if (c === '}' || c === ']') stack.pop();
  }
  let out = body; if (inStr) out += '"';
  out = out.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, '');
  while (stack.length) out += stack.pop();
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

const SEC_FIELDS = [
  ['subjective', Object.keys(emptyNote().subjective)],
  ['past_medical_history', Object.keys(emptyNote().past_medical_history)],
  ['objective', Object.keys(emptyNote().objective)],
];
const ISSUE_FIELDS = ['diagnosis', 'assessment', 'investigations_planned', 'treatment_planned', 'referrals'];

function buildNote(out, meta) {
  const note = emptyNote(meta);
  for (const [sec, keys] of SEC_FIELDS) for (const k of keys) note[sec][k] = String(out?.[sec]?.[k] ?? '').trim();
  const ap = Array.isArray(out?.assessment_and_plan) ? out.assessment_and_plan : [];
  note.assessment_and_plan = ap.filter((p) => String(p?.issue || '').trim()).map((p) => {
    const i = emptyIssue();
    i.issue = String(p.issue).trim();
    for (const f of ISSUE_FIELDS) i[f] = String(p[f] ?? '').trim();
    i.differential_diagnoses = Array.isArray(p.differential_diagnoses) ? p.differential_diagnoses.map(String).filter(Boolean) : [];
    return i;
  });
  return note;
}

// Every line of the note with a stable id, plus a setter to rewrite its owning field.
function enumerateLines(note) {
  const lines = [];
  const add = (label, getter, setter, text) => {
    String(text || '').split('\n').forEach((ln, idx, all) => { if (ln.trim()) lines.push({ id: lines.length + 1, label, text: ln.trim(), getter, setter, idx, total: all.length }); });
  };
  for (const [sec, keys] of SEC_FIELDS) for (const k of keys) add(`${sec}.${k}`, () => note[sec][k], (v) => { note[sec][k] = v; }, note[sec][k]);
  note.assessment_and_plan.forEach((p, n) => {
    for (const f of ISSUE_FIELDS) add(`A&P ${n + 1} (${p.issue}).${f}`, () => p[f], (v) => { p[f] = v; }, p[f]);
  });
  return lines;
}

// Remove specific lines (by id) from their fields.
function dropLines(lines, ids) {
  const byField = new Map();
  for (const l of lines) { const key = l.getter; if (!byField.has(key)) byField.set(key, []); byField.get(key).push(l); }
  let dropped = 0;
  for (const group of byField.values()) {
    const kill = group.filter((l) => ids.has(l.id));
    if (!kill.length) continue;
    const keep = group.filter((l) => !ids.has(l.id)).map((l) => l.text);
    group[0].setter(keep.join('\n')); dropped += kill.length;
  }
  return dropped;
}

// ── checklist merge (grounded, additive only) ────────────────────────────────
function mergeChecklist(note, check, transcript, log) {
  if (!check) return 0;
  const tNorm = norm(transcript);
  const inTranscript = (s) => { const n = norm(s); if (!n) return false; if (tNorm.includes(n)) return true; const w = n.split(' ').filter((x) => x.length > 2); return w.length > 0 && w.every((x) => tNorm.includes(x)); };
  const noteNorm = () => norm(JSON.stringify(note));
  const present = (s) => { const n = norm(s); return n.length >= 3 && noteNorm().includes(n.split(' ').slice(0, 3).join(' ')); };
  const first = note.assessment_and_plan[0] || null;
  const append = (obj, key, line) => { obj[key] = (obj[key] ? obj[key] + '\n' : '') + line; };
  let added = 0;

  const curMeds = [];
  for (const m of (check.medications || [])) {
    const name = String(m?.name || '').trim(); if (!name || !inTranscript(name) || present(name)) continue;
    const detail = String(m.detail || '').trim(); const line = detail ? `${name} ${detail}` : name;
    const st = String(m.status || '').toLowerCase();
    if (/new|chang|stop|declin/.test(st) && first) append(first, 'treatment_planned', `${line}${/stop/.test(st) ? ' (stopped)' : ''}`);
    else curMeds.push(line);
    added++;
  }
  // (current medications are NOT listed in a separate PMH line: the clinic template has no such field and gold notes mention a drug only where it matters to a problem)

  for (const r of (check.results || [])) {
    const test = String(r?.test || '').trim(), val = String(r?.value || '').trim(); if (!test || !val) continue;
    if (!inTranscript(test) || present(`${test} ${val}`) || (numsOf(val).length && numsOf(val).every((n) => noteNorm().includes(n)) && present(test))) continue;
    if (numsOf(val).some((n) => !tNorm.includes(n))) continue;                       // value must be spoken
    append(note.objective, 'completed_investigations', `${test}: ${val}${r.date ? ` (${r.date})` : ''}`); added++;
  }
  if (first) {
    for (const o of (check.orders || [])) { const s = String(o || '').trim(); if (s && inTranscript(s) && !present(s)) { append(first, 'investigations_planned', s); added++; } }
    for (const r of (check.referrals || [])) { const s = String(r || '').trim(); if (s && inTranscript(s) && !present(s)) { append(first, 'referrals', s); added++; } }
    const fu = String(check.follow_up || '').trim();
    if (fu && inTranscript(fu) && !/follow|return|rtc|recheck|review|come back|see you/i.test(first.treatment_planned || '') ) { append(first, 'treatment_planned', `Follow-up: ${fu}`); added++; }
  }
  added += mergeRecall(note, check, tNorm, noteNorm, log);
  if (added) log(`[v2:merge] checklist added ${added} grounded item(s) the writer omitted`);
  return added;
}

/** Extended-recall merge: add a history / finding / symptom / specific item only if the transcript says it AND the note lacks it. */
function mergeRecall(note, check, tNorm, noteNorm, log) {
  const tWords = new Set(tNorm.split(' ').filter((w) => w.length > 3)); const tNums = new Set(numsOf(tNorm));
  const grounded = (t) => { const w = norm(t).split(' ').filter((x) => x.length > 3); if (!w.length) return numsOf(t).length > 0 && numsOf(t).every((n) => tNums.has(n)); return w.filter((x) => tWords.has(x)).length / w.length >= 0.8 && numsOf(t).every((n) => tNums.has(n)); };
  const covered = (t) => { const nn = noteNorm(); const w = norm(t).split(' ').filter((x) => x.length > 3); const nums = numsOf(t); if (!w.length && !nums.length) return true; return (!w.length || w.filter((x) => nn.includes(x)).length / w.length >= 0.7) && nums.every((n) => nn.includes(n)); };
  const append = (obj, key, line) => { obj[key] = (obj[key] ? obj[key] + '\n' : '') + line; };
  let n = 0; const CAP = 12; const ok = (t) => typeof t === 'string' && t.trim().length >= 4 && t.length <= 160 && n < CAP && grounded(t) && !covered(t);
  const keys = { surgical: ['past_medical_history', 'medical_surgical'], medical: ['past_medical_history', 'medical_surgical'], family: ['past_medical_history', 'family'], social: ['past_medical_history', 'social'], immunisation: ['past_medical_history', 'immunisation'] };
  for (const h of (check.history || [])) { const t = String(h?.text || '').trim(); const k = keys[String(h?.kind || '').toLowerCase()]; if (k && ok(t)) { append(note[k[0]], k[1], t); n++; } }
  for (const f of (check.findings || [])) { const t = String(f?.text || '').trim(); const kind = String(f?.kind || '').toLowerCase(); if ((kind === 'exam' || kind === 'vital') && ok(t)) { append(note.objective, kind === 'vital' ? 'vital_signs' : 'examination', t); n++; } }
  for (const sy of (check.symptoms || [])) { const t = String(sy?.text || '').trim(); const line = sy?.present === false ? `Denies ${t}` : t; if (t && ok(t) && !covered(line)) { append(note.subjective, 'associated_symptoms', line); n++; } }
  for (const sp of (check.specifics || [])) { const t = String(sp || '').trim(); if (ok(t)) { append(note.subjective, 'hpi_details', t); n++; } }
  if (n) log(`[v2:recall] added ${n} history/finding/symptom/specific item(s) the writer omitted`);
  return n;
}

// ── verifier (model proposes, code confirms) ─────────────────────────────────
async function verifyNote(llm, note, transcript, log, cfg = {}) {
  const lines = enumerateLines(note);
  if (lines.length < 4) return { dropped: 0 };
  const numbered = lines.map((l) => `${l.id}. [${l.label}] ${l.text}`).join('\n');
  llm._agent = 'v2-verifier';
  let res;
  try {
    res = parseJson(await llm.generateContent(cfg.prompt || VERIFY_SYS,
      `=== TRANSCRIPT ===\n${transcript.slice(0, 90000)}\n\n=== NOTE ===\n${numbered}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 900, timeoutMs: cfg.timeoutMs || Number(process.env.V2_VERIFY_TIMEOUT_MS) || 15000, retries: 0, hedgeMs: 6000, temperature: 0, responseMimeType: 'application/json' }));
  } catch (e) { log(`[v2:verify] skipped — ${e.message}`); return { dropped: 0 }; }
  if (!res) return { dropped: 0 };

  const tWords = new Set(words(transcript)); const tNums = new Set(numsOf(transcript));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const kill = new Set();
  // 1) unsupported — CODE CONFIRMS: the line must actually contain something absent from the transcript.
  for (const u of (res.unsupported || [])) {
    const l = byId.get(Number(u?.id)); if (!l) continue;
    const w = words(l.text); const missing = w.filter((x) => !tWords.has(x));
    const badNum = numsOf(l.text).some((n) => !tNums.has(n));
    const lowOverlap = w.length >= 3 && missing.length / w.length >= 0.5;
    if (badNum || lowOverlap) { kill.add(l.id); log(`[v2:verify] ✂ "${l.text.slice(0, 90)}" — ${u.reason || 'unsupported'}`); }
    else log(`[v2:verify] kept (grounded in transcript): "${l.text.slice(0, 70)}"`);
  }
  // 2) duplicates — CODE CONFIRMS: same numbers and ≥55% shared content words.
  for (const pair of (res.duplicates || [])) {
    const [keepId, dropId] = (pair || []).map(Number); const a = byId.get(keepId), b = byId.get(dropId);
    if (!a || !b || kill.has(keepId) || kill.has(dropId)) continue;
    const wa = new Set(words(a.text)), wb = words(b.text);
    const shared = wb.filter((x) => wa.has(x)).length;
    const sameNums = JSON.stringify([...new Set(numsOf(a.text))].sort()) === JSON.stringify([...new Set(numsOf(b.text))].sort())
      || numsOf(b.text).every((n) => numsOf(a.text).includes(n));
    if (wb.length && shared / wb.length >= 0.55 && sameNums) { kill.add(dropId); log(`[v2:verify] dup ✂ "${b.text.slice(0, 80)}"`); }
  }
  // Safety valve: never let the verifier gut a note.
  if (kill.size > Math.max(3, Math.floor(lines.length * 0.25))) { log(`[v2:verify] refused ${kill.size}/${lines.length} deletions (>25%) — note kept as written`); return { dropped: 0 }; }
  return { dropped: dropLines(lines, kill) };
}

// ── main ─────────────────────────────────────────────────────────────────────
// ── editor pass: a reviewer that fixes what the audits keep finding (placement, plan attribution, contradictions, padding) ──
const EDITOR_SYS = `You are the senior reviewer of an AI-drafted SOAP note (JSON). You get the TRANSCRIPT (the only truth) and the DRAFT. Return the corrected note as JSON in exactly the same structure. Change ONLY what is wrong; copy everything that is correct unchanged. Fix, in this priority:
1 CONTRADICTIONS WITH THE TRANSCRIPT: negations flipped ("denies X" when the patient has X, or the reverse), wrong drug / strength / frequency / value / side / date, a diagnosis, treatment or referral that was not said. Correct it using the transcript's own words or delete it. Never add anything that is not in the transcript.
2 PLAN ATTRIBUTION: every investigation, treatment, referral and instruction sits under the problem it is for. Move misplaced items. Merge entries that are the same condition. A test, procedure, refill or visit task is not a problem: fold it under the problem it serves. One entry per genuinely distinct problem; keep distinct diagnoses separate.
3 SECTION PLACEMENT: Subjective = what the patient says (symptoms, history, requests, reported readings, lifestyle). Objective = only what was measured, examined or reviewed (exam findings, vitals with where measured such as "BP 142/85 at home", completed results with values). Move symptoms and history out of Objective, exam findings out of Subjective, and planned or pending tests into investigations_planned. Past medical history = diagnosed conditions, surgeries, family / social / immunisation history and one "Current medications" line: move current-illness details to Subjective, keep family history only in family, and remove drugs that are only being newly prescribed from "Current medications".
4 PADDING: delete visit-agenda lines ("Discussion of ...", "Evaluation of ..."), filler, commentary, duplicates, and anything stated twice.
5 COMPLETENESS: if the transcript clearly states an important fact the draft lacks (diagnosis, medication change with dose, abnormal result with value, referral, follow-up timing), add it to the right field in the same terse style.
Style: one fact per line, short clinical phrases, exact numbers, doses and specific denials. Return ONLY the JSON.`;

/** Accept the editor's output only if it did not lose or invent clinical content (deterministic check). */
const NARRATIVE_WORDS = new Set('been have with from that which since after despite however while there their they this these those then than also again currently previously recently several about around over during before because causing where when were being would could patient presents present presenting reports reported denies denied states stated notes noted describes described complains complained associated symptoms symptom include includes including history onset gradually subsequently continues continued remains remained improved improving worse worsening better overall otherwise further further still just only most some both either neither each other another into onto upon within without between through until while though although whereas thereafter therefore thus hence once twice follow following followed ongoing such involving evaluation approximately occasionally episode episodes received receiving identified monitor monitors monitoring regarding initially known began begun began started starts continues later earlier early shortly became become becoming remained remain tried trying sought seeking due having had has made make getting gets got went goes gone come came coming told said says asked asks reason visit concerns concern'.split(' '));
export function editorAccepts(draft, edited, transcript, o = {}) {
  const flat = (o) => (o && typeof o === 'object' ? Object.values(o).map(flat).join(' ') : String(o ?? ''));   // string values only (no keys, no JSON escapes)
  const T = new Set(words(transcript)); const D = new Set(words(flat(draft))); const E = new Set(words(flat(edited)));
  const nw = o.noPlan ? numWordsToDigits : (x) => x;   // prose may write "three weeks" for "3 weeks"
  const tNums = new Set(numsOf(nw(transcript))); const dNums = new Set(numsOf(nw(flat(draft)))); const eNums = new Set(numsOf(nw(flat(edited))));
  if (!o.noPlan) {
    if (!Array.isArray(edited?.assessment_and_plan)) return { ok: false, why: 'no assessment_and_plan' };
    if ((draft.assessment_and_plan || []).length && !edited.assessment_and_plan.length) return { ok: false, why: 'dropped every problem' };
  }
  const kept = [...D].filter((w) => E.has(w)).length / Math.max(1, D.size);
  if (kept < (o.keptMin ?? 0.78)) return { ok: false, why: `kept only ${(kept * 100).toFixed(0)}% of the draft's content words` };
  const keptNums = [...dNums].filter((n) => tNums.has(n)); const numKeep = keptNums.length ? keptNums.filter((n) => eNums.has(n)).length / keptNums.length : 1;
  if (numKeep < 0.85) return { ok: false, why: `lost ${((1 - numKeep) * 100).toFixed(0)}% of the grounded numbers` };
  const inventedNums = [...eNums].filter((n) => !tNums.has(n) && !dNums.has(n));
  if (inventedNums.length) return { ok: false, why: `introduced numbers not in transcript (${inventedNums.slice(0, 3).join(', ')})` };
  // Prose needs connectives and inflections ("takes" for "taking"): in story mode a word is not new if it shares its first 4 letters with a transcript/draft word or is a narrative function word.
  const stems = o.noPlan ? new Set([...T, ...D].map((w) => w.slice(0, 4))) : null;
  const fresh = [...E].filter((w) => !T.has(w) && !D.has(w) && !(stems && (stems.has(w.slice(0, 4)) || NARRATIVE_WORDS.has(w)))); const freshRate = fresh.length / Math.max(1, E.size);
  if (freshRate > (o.freshMax ?? 0.06) || (o.freshAbs != null && fresh.length > o.freshAbs)) return { ok: false, why: `${(freshRate * 100).toFixed(0)}% brand-new words (${fresh.slice(0, 4).join(', ')})` };
  if (o.noPlan && /unspecified|not (mentioned|specified|stated|documented)|unknown date/i.test(flat(edited)) && !/unspecified|not (mentioned|specified|stated|documented)|unknown date/i.test(flat(draft))) return { ok: false, why: 'states that something was unspecified / not mentioned' };
  return { ok: true, kept, numKeep, fresh: fresh.length };
}
async function editWriterJson(llm, draft, transcript, log, { prompt, model, timeoutMs }) {
  const t0 = Date.now();
  try {
    llm._agent = 'v2-editor';
    const raw = await llm.generateContent(prompt || EDITOR_SYS, `TRANSCRIPT (sole truth):\n"""\n${transcript}\n"""\n\nDRAFT NOTE JSON:\n${JSON.stringify(draft)}\n\nReturn the corrected JSON.`, WRITER_SCHEMA,
      { maxOutputTokens: 6000, timeoutMs: timeoutMs || 30000, retries: 0, hedgeMs: 18000, temperature: 0, thinkingBudget: 0 });
    const edited = parseJson(raw);
    if (!edited) { log('[v2:editor] rejected — unparseable JSON'); return { out: null, why: 'unparseable', ms: Date.now() - t0 }; }
    const chk = editorAccepts(draft, edited, transcript);
    if (!chk.ok) { log(`[v2:editor] rejected — ${chk.why}`); return { out: null, why: chk.why, ms: Date.now() - t0 }; }
    log(`[v2:editor] applied (kept ${(chk.kept * 100).toFixed(0)}% of draft words, ${chk.fresh} new words)`);
    return { out: edited, why: 'applied', ms: Date.now() - t0 };
  } catch (e) { log(`[v2:editor] skipped — ${e.message}`); return { out: null, why: 'error: ' + e.message, ms: Date.now() - t0 }; }
}

// ── STORY agent: an independent stage that makes the Subjective read as a proper clinical story ────────────────────────────────
// Writers produce lists of clipped fragments ("Pain / left knee / 3 weeks"). A physician wants to READ the history: why the patient came,
// how it started and progressed, what helps or hurts, what was tried, what it does to daily life — in grammatical sentences that follow
// one another. This stage runs LAST (after the safety checks, so it only rewrites wording that was already verified), has its own prompt,
// model and switch, and editorAccepts() (story mode) rejects any rewrite that loses a fact or invents one — the verified draft is then kept.
const STORY_SYS = `You are the story editor of a clinical scribe. You receive the SUBJECTIVE of a clinical note as JSON, plus the TRANSCRIPT it came from. Rewrite it so a physician reads a proper clinical story, not a list of fragments. Return JSON with the single key "subjective" and the SAME inner keys.
SUBJECTIVE
- reason_for_visit: ONE complete sentence saying why the patient came ("Presents with left knee pain for 3 weeks.").
- hpi_details: the history of the presenting complaint as one to three short paragraphs of complete, grammatical sentences, in the order a physician would tell it: onset and duration; character, location and severity; how it has progressed; what makes it better or worse and what has been tried; previous episodes; the effect on daily life, work or sleep. Link the sentences with natural connectives (since, after, despite, which, however, so) so each follows from the one before. Use paragraphs, not bullets, and no dashes or list markers.
- associated_symptoms: one or two sentences ("Associated symptoms include X and Y. She denies Z.") — positives first, then the specific denials.
- Move the content of aggravating_relieving_factors, symptom_progression, previous_episodes and functional_impact INTO the story above and leave those four fields as empty strings.
Do not touch anything else in the note; the Past Medical History, Objective and Plan are handled elsewhere.
STYLE: write the way a physician dictates a history: concise, fluent clinical prose in the third person, no quotes of the patient, no first person. Do NOT begin sentence after sentence with "The patient" — begin with the symptom, finding or event ("Right hand pain and swelling have been ongoing for years, worse on the right, especially around the knuckle."; "Pain worsens with painting and using a weed wacker, and eases with rest."; "Has not taken analgesics because of concern about side effects."), using "The patient" at most once or twice. Use "he" or "she" ONLY if the transcript makes the sex explicit. Tense follows the facts (current problems present tense, past events past tense).
PLACEHOLDERS: the text may contain de-identification placeholders such as [date], [name] or "the specialist"; keep them exactly as written and never write "unspecified", "unknown" or "not mentioned" around them. Use the transcript only to check wording; do not pull in facts that are not in the NOTE JSON.
HARD RULES: keep every fact exactly — write numbers as numerals exactly as in the note ("3 weeks", "500 mg", never "three weeks"); every number, dose, unit, date, duration, laterality, drug name, result and every specific denial; keep negations as negations. Never add a fact, a cause, a diagnosis or a judgement that is not already in the note — in particular never name a condition from a drug ("blood pressure medication" stays "blood pressure medication", it does not become "hypertension") and never turn a denial into a finding or the reverse; never state that something was not mentioned; never move facts out of Subjective; leave an empty field empty. Return ONLY the JSON.`;
export async function storyPass(llm, note, transcript, log, { prompt, timeoutMs }) {
  const t0 = Date.now(); const draft = { subjective: note.subjective };
  if (!Object.values(note.subjective || {}).some((v) => String(v || '').trim())) { log('[v2:story] skipped — nothing in Subjective'); return { out: null, why: 'empty', ms: 0 }; }
  try {
    llm._agent = 'v2-story';
    const raw = await llm.generateContent(prompt || STORY_SYS, `TRANSCRIPT (for checking facts only):\n"""\n${transcript.slice(0, 60000)}\n"""\n\nNOTE JSON:\n${JSON.stringify(draft)}\n\nReturn the rewritten JSON.`, null,
      { maxOutputTokens: 5000, timeoutMs: timeoutMs || 30000, retries: 0, hedgeMs: 20000, temperature: 0.2, thinkingBudget: 0, responseMimeType: 'application/json' });
    const out = parseJson(raw);
    if (!out || typeof out.subjective !== 'object') { log('[v2:story] rejected — unparseable or incomplete JSON'); return { out: null, why: 'unparseable', ms: Date.now() - t0 }; }
    const chk = editorAccepts(draft, out, transcript, { noPlan: true, keptMin: 0.72, freshMax: 0.1, freshAbs: 8 });
    if (!chk.ok) { log(`[v2:story] rejected — ${chk.why}`); return { out: null, why: chk.why, rejected: out.subjective, ms: Date.now() - t0 }; }
    log(`[v2:story] applied (kept ${(chk.kept * 100).toFixed(0)}% of words, ${chk.fresh} new words)`);
    return { out, why: 'applied', ms: Date.now() - t0 };
  } catch (e) { log(`[v2:story] skipped — ${e.message}`); return { out: null, why: 'error: ' + e.message, ms: Date.now() - t0 }; }
}

export async function generateNoteV2(input, opts = {}) {
  const t0 = Date.now();
  const { specialty = 'general_primary_care', noteType = 'consultation', clinicianId = 'unknown' } = input;
  const persist = opts.persist !== false;
  const onProgress = opts.onProgress || (() => {});
  const log = (l) => { console.log(l); try { if (opts.onLog) opts.onLog(String(l)); } catch { /* logging must never break a note */ } };
  const consultId = input.consultId || `CONS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const stage = {};                                       // per-stage wall-clock for the monitor
  const lap = (k, from) => { stage[k] = Date.now() - from; log(`⏱️ [Timing] v2:${k}: ${stage[k]}ms`); };

  let transcript = String(input.transcript || '');
  if (!transcript && input.audioUri) {
    const { transcribeFromGcs, turnsToTranscript } = await import('../asr/transcribe.js');
    transcript = turnsToTranscript((await transcribeFromGcs(input.audioUri)).turns);
  }
  if (process.env.NORMALIZE_DEID_DATES === '1') transcript = transcript.replace(/\b(?:19|20)\d{2}-\d{1,2}-\d{1,2}\b/g, '[date]');
  if (!transcript.trim()) throw new Error('generateNote: no transcript or audioUri provided');

  if (persist) {
    await store.createConsult({ consultId, specialty, noteType, clinicianId, status: 'processing', createdAt: new Date().toISOString(), audioUri: input.audioUri || null });
    await audit({ consultId, actor: clinicianId, action: 'consult.created' });
  }

  const detected = classifyEncounterDeterministic(transcript, log);
  const specialtyResolved = (!input.specialty || input.specialty === 'auto') ? (detected || specialty) : specialty;
  const blank = isBlankEncounter({ transcript });

  // Separate LLM instances so parallel calls keep correct per-agent token attribution.
  // The WRITER carries the quality, so it gets the stronger model; the small checklist/verifier calls stay on the fast one.
  const cfg = await effectiveConfig();   // admin-console overrides > env > code defaults (cached 30 s)
  const gOn = (key, o) => (o !== undefined ? !!o : !!cfg[key]);
  const inputMode = opts.inputCheck || cfg['guards.inputCheck'];
  const inputChk = inputMode === 'off' ? { ok: true } : checkInput(transcript);
  if (!inputChk.ok) {
    log(`[v2:input] ${inputChk.reason} — ${inputChk.message}`);
    if (inputMode === 'reject') { const err = new Error(`This does not look like a consultation: ${inputChk.message}`); err.code = 'INVALID_TRANSCRIPT'; throw err; }
  }
  const writerLlm = await createGeminiService(null, { model: opts.writerModel || cfg['writer.model'] }); writerLlm._agent = 'v2-writer';
  const auxModel = opts.auxModel || cfg['aux.model'];
  const checkLlm = await createGeminiService(null, { model: auxModel }); checkLlm._agent = 'v2-checklist';
  const verifyLlm = await createGeminiService(null, { model: auxModel });
  const used = { config: { writer: opts.writerModel || cfg['writer.model'], temperature: opts.writerTemp ?? cfg['writer.temperature'], topP: opts.writerTopP ?? cfg['writer.topP'], helper: auxModel }, prompts: {} };

  let note;
  try {
    if (blank) {
      log('[upgrade:blank-encounter] nothing clinical in the transcript — emitting an empty note');
      note = emptyNote({ specialty: specialtyResolved, noteType, generatedBy: PIPELINE_VERSION });
      note.metadata.flags = [{ type: 'empty_encounter', field: 'transcript', message: 'No clinical content detected; empty note produced to avoid fabrication.', severity: 'warning' }];
    } else {
      // 1) WRITER ∥ CHECKLIST ----------------------------------------------------
      onProgress({ status: 'drafting', consultId });
      const tw = Date.now();
      // Prompt precedence: per-call override (lab experiments) > active promoted version (admin console) > code default.
      const wMeta = opts.writerPrompt ? null : await getActivePromptMeta(WRITER_PROMPT_NAME);
      const writerPrompt = opts.writerPrompt || wMeta?.text || defaultWriterPrompt();
      used.prompts.writer = opts.writerPrompt ? 'experiment' : wMeta ? `v${wMeta.version}` : 'default';
      const cMeta = await getActivePromptMeta(CHECKLIST_PROMPT_NAME); used.prompts.checklist = cMeta ? `v${cMeta.version}` : 'default';
      const vMeta = await getActivePromptMeta(VERIFIER_PROMPT_NAME); used.prompts.verifier = vMeta ? `v${vMeta.version}` : 'default';
      const nShots = Math.max(0, Math.min(3, Number(opts.fewShot ?? cfg['writer.fewShot']) || 0));
      const shots = nShots ? pickExemplars(transcript, nShots, opts.exemplarExclude || []) : [];
      used.config.fewShot = shots.map((e) => e.id); if (opts.trace) opts.trace.exemplars = shots.map((e) => ({ id: e.id, sim: +e.sim.toFixed(3) }));
      if (shots.length) log(`[v2:fewshot] ${shots.length} reference note(s): ${shots.map((e) => e.id + ' (' + e.sim.toFixed(2) + ')').join(', ')}`);
      const writerUser = exemplarBlock(shots) + `TRANSCRIPT (sole source of truth):\n"""\n${transcript}\n"""\n\nWrite the SOAP note. Return ONLY JSON.`;
      const writerOpts = {
        maxOutputTokens: cfg['writer.maxOutputTokens'], timeoutMs: cfg['writer.timeoutMs'],
        retries: 1, hedgeMs: cfg['writer.hedgeMs'], temperature: opts.writerTemp ?? cfg['writer.temperature'], thinkingBudget: opts.writerThinking ?? cfg['writer.thinkingBudget'], fallbackModel: cfg['writer.fallbackModel'] || 'gemini-3.5-flash-lite',
        topP: opts.writerTopP ?? cfg['writer.topP'], ...(process.env.V2_WRITER_TOP_K ? { topK: Number(process.env.V2_WRITER_TOP_K) } : {}),
        ...(process.env.V2_WRITER_SEED ? { seed: Number(process.env.V2_WRITER_SEED) } : {}), ...(process.env.V2_WRITER_FREQ_PENALTY ? { frequencyPenalty: Number(process.env.V2_WRITER_FREQ_PENALTY) } : {}) };
      const writerP = writerLlm.generateContent(writerPrompt, writerUser, WRITER_SCHEMA, writerOpts);
      const recallOn = opts.recall !== undefined ? !!opts.recall : cfg['recall.extended']; used.config.recall = recallOn;
      const checkP = checkLlm.generateContent((cMeta?.text || CHECK_SYS) + (recallOn ? CHECK_EXTRA : ''), `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nReturn ONLY the JSON.`, recallOn ? CHECK_SCHEMA_X : CHECK_SCHEMA, {
        maxOutputTokens: recallOn ? 3000 : 1500, timeoutMs: 20000, retries: 0, hedgeMs: 7000, temperature: 0, thinkingBudget: 0 })
        .then((r) => parseJson(r)).catch((e) => { log(`[v2:checklist] skipped — ${e.message}`); return null; });
      const [writerRaw, check] = await Promise.all([writerP, checkP]);
      lap('writer+checklist', tw);
      let out = parseJson(writerRaw);
      if (!out) {   // a stronger model occasionally returns truncated/invalid JSON (~4% on gemini-3.7-flash): retry once, deterministic, on the fallback model
        log('[v2:writer] unparseable JSON — retrying once on the fallback model at temperature 0');
        try { const retryLlm = await createGeminiService(null, { model: cfg['writer.fallbackModel'] || 'gemini-3.5-flash-lite' }); retryLlm._agent = 'v2-writer';
          out = parseJson(await retryLlm.generateContent(writerPrompt, writerUser, WRITER_SCHEMA, { ...writerOpts, temperature: 0, thinkingBudget: 0, fallbackModel: undefined, retries: 0 })); } catch (e) { log(`[v2:writer] retry failed — ${e.message}`); }
      }
      if (opts.trace) { opts.trace.writer_json = out; opts.trace.checklist = check; }
      if (!out) throw new Error('v2 writer returned unparseable JSON');
      let finalOut = out;
      const useEditor = opts.editor !== undefined ? !!opts.editor : cfg['editor.enabled'];
      if (useEditor) {
        const te = Date.now(); const eMeta = await getActivePromptMeta(EDITOR_PROMPT_NAME); used.prompts.editor = eMeta ? `v${eMeta.version}` : 'default';
        const editorLlm = await createGeminiService(null, { model: cfg['editor.model'] });
        const er = await editWriterJson(editorLlm, out, transcript, log, { prompt: eMeta?.text, model: cfg['editor.model'], timeoutMs: cfg['editor.timeoutMs'] });
        lap('editor', te); if (er.out) finalOut = er.out; if (opts.trace) opts.trace.editor = { applied: !!er.out, why: er.why, ms: er.ms, edited_json: er.out || null };
      }
      note = buildNote(finalOut, { specialty: specialtyResolved, noteType, generatedBy: PIPELINE_VERSION });
      { const n = cleanNote(note); if (n) log(`[v2:clean] removed ${n} commentary/filler/duplicate line(s)`); }
      if (!note.assessment_and_plan.length && !Object.values(note.subjective).some(Boolean)) {
        // Same behaviour as v1 for a non-clinical recording (voicemail, hold music): an empty, flagged note.
        log('[v2] writer found no clinical content — emitting an empty flagged note');
        note.metadata.flags = [...(note.metadata.flags || []), { type: 'empty_encounter', field: 'transcript', message: 'No clinical content found in the transcript; empty note produced to avoid fabrication.', severity: 'warning' }];
      }

      // 2) deterministic merge of anything the writer dropped ----------------------
      mergeChecklist(note, check, transcript, log);
      if (cfg['drugs.guardEnabled']) { try { const dg = guardDrugNames(note, transcript, check, log); if (opts.trace) opts.trace.drugs = dg; } catch (e) { log(`[v2:drugs] skipped — ${e.message}`); } }
      // 2a) guardrails built from the diagnosis reports (each has its own switch in Settings)
      if (gOn('guards.template', opts.guardTemplate)) { try { const r = enforceTemplate(note, log); if (opts.trace) opts.trace.template = r; } catch (e) { log(`[v2:template] skipped — ${e.message}`); } }
      if (gOn('guards.placement', opts.guardPlacement)) { try { const r = fixMisplacement(note, log); if (opts.trace) opts.trace.placement = r; } catch (e) { log(`[v2:place] skipped — ${e.message}`); } }
      if (gOn('guards.drugPlausibility', opts.guardPlausibility)) { try { const r = drugPlausibility(note, transcript, log); if (opts.trace) opts.trace.plausibility = r; } catch (e) { log(`[v2:plausible] skipped — ${e.message}`); } }
      if (!inputChk.ok) note.metadata.flags = [...(note.metadata.flags || []), { type: 'input_not_consultation', field: 'transcript', message: inputChk.message + ' Please check the recording or text.', severity: 'warning' }];
      note.metadata.medications_mentioned = [...new Set([...(collectMeds(note)), ...((check?.medications || []).map((m) => m?.name).filter(Boolean))])];

      // 3) deterministic placement fixes, then ONE verifier call ---------------------
      try { note = reconcileNote(note); } catch (e) { log(`[v2] reconcile skipped: ${e.message}`); }
      if (cfg['verifier.enabled']) {
        const tv = Date.now();
        const v = await verifyNote(verifyLlm, note, transcript, log, { prompt: vMeta?.text, timeoutMs: cfg['verifier.timeoutMs'] });
        lap('verifier', tv);
        if (opts.trace) opts.trace.verifier = v;
        if (v.dropped) log(`[v2:verify] removed ${v.dropped} line(s)`);
      }
    }
  } catch (e) {
    if (persist) { try { await store.updateConsult(consultId, { status: 'error' }); } catch { /* */ } }
    throw e;
  }
  note.specialty = specialtyResolved; note.metadata.encounter_id = consultId;
  note.metadata.pipeline_trace = used;
  if (opts.trace) { opts.trace.used = used; opts.trace.timings = stage; }   // exactly which prompt versions + settings produced this note (shown in the admin console)

  // 4) deterministic guardrails / render (same code as v1) ---------------------------
  try { const up = applyUpgradeGuardrails(note, { transcript, entities: [] }); if (up.flags?.length) note.metadata.flags = [...(note.metadata.flags || []), ...up.flags]; } catch (e) { log(`[v2] guardrails skipped: ${e.message}`); }
  {
    const SEV = { critical: 'critical', warning: 'warning', low: 'low', info: 'info', major: 'warning', high: 'warning', minor: 'low', medium: 'low', error: 'critical', fatal: 'critical' };
    for (const fl of (note.metadata?.flags || [])) if (fl) fl.severity = SEV[String(fl.severity || '').toLowerCase()] || 'info';
  }
  const gr = runGuardrails(note, [], { confidenceThreshold: opts.confidenceThreshold });
  note = gr.note;
  try { condenseNote(note, {}, log); } catch (e) { log(`[v2] condense skipped: ${e.message}`); }
  try { note = reconcileNote(note); } catch { /* */ }
  try { dedupeNote(note, { log }); } catch (e) { log(`[v2] dedupe skipped: ${e.message}`); }
  // STORY agent (independent, optional, LAST): the verified note is rewritten into a readable clinical story; facts are checked by code
  if (!blank && (opts.story !== undefined ? !!opts.story : cfg['story.enabled'])) {
    const ts = Date.now(); const sMeta = await getActivePromptMeta(STORY_PROMPT_NAME); used.prompts.story = sMeta ? `v${sMeta.version}` : 'default';
    const storyModel = opts.storyModel || cfg['story.model']; used.config.story = storyModel;
    const storyLlm = await createGeminiService(null, { model: storyModel });
    const sr = await storyPass(storyLlm, note, transcript, log, { prompt: sMeta?.text, timeoutMs: cfg['story.timeoutMs'] });
    lap('story', ts);
    if (sr.out) {
      for (const [sec, keys] of SEC_FIELDS.slice(0, 1)) for (const k of keys) if (sr.out[sec] && k in sr.out[sec]) note[sec][k] = String(sr.out[sec][k] ?? '').trim();
      note.metadata.subjective_style = 'narrative';
    }
    if (opts.trace) opts.trace.story = { applied: !!sr.out, why: sr.why, ms: sr.ms, subjective: sr.out?.subjective || null, rejected: sr.rejected || null };
  }
  const renderedNote = noteToMarkdown(note);

  // 5) persist -------------------------------------------------------------------
  const draftId = `DRAFT-${Date.now()}`;
  if (persist) {
    await store.updateConsult(consultId, { status: 'ready', specialty: specialtyResolved, transcript: { text: transcript }, entities: [] });
    await store.addDraft(consultId, { draftId, modelVersion: PIPELINE_VERSION, schemaVersion: note.schema_version, note, renderedNote, rawRenderedNote: renderedNote, confidence: note.metadata.confidence || {}, status: gr.status, createdAt: new Date().toISOString() });
    await audit({ consultId, actor: 'system', action: 'draft.created', target: draftId, meta: { status: gr.status, flags: gr.flags.length, pipeline: 'v2' } });
  }

  const merge = (...us) => {
    const perAgent = {};
    for (const u of us) for (const [a, r] of Object.entries(u?.perAgent || {})) { const x = (perAgent[a] ||= { prompt: 0, output: 0, total: 0, calls: 0 }); x.prompt += r.prompt; x.output += r.output; x.total += r.total; x.calls += r.calls; }
    if (!Object.keys(perAgent).length) return null;
    const totals = Object.values(perAgent).reduce((a, r) => ({ prompt: a.prompt + r.prompt, output: a.output + r.output, total: a.total + r.total, calls: a.calls + r.calls }), { prompt: 0, output: 0, total: 0, calls: 0 });
    return { perAgent, totals };
  };
  const tokenUsage = merge(writerLlm.getTokenUsage(), checkLlm.getTokenUsage(), verifyLlm.getTokenUsage());
  const total = Date.now() - t0;
  if (tokenUsage) log(`[tokens] === v2 run total: ${tokenUsage.totals.total} tokens (prompt=${tokenUsage.totals.prompt} output=${tokenUsage.totals.output}, ${tokenUsage.totals.calls} calls) in ${total}ms`);
  try {
    const { recordRun } = await import('../ops/opsLog.js');
    recordRun({ consultId, clinicianId, model: writerLlm.model, status: gr.status === 'INVALID' ? 'partial' : 'ok', durationMs: total,
      transcriptChars: transcript.length, noteChars: (renderedNote || '').length, tokenUsage, timings: { ...stage, total } });
  } catch { /* monitoring must never break generation */ }

  onProgress({ status: 'ready', consultId, draftId });
  return { consultId, draftId, note, renderedNote, rawRenderedNote: renderedNote, status: gr.status, flags: gr.flags, schemaErrors: gr.schemaErrors,
    entities: [], detectedSpecialty: detected, tokenUsage, qa: null, pipeline: 'v2', timings: { ...stage, total } };
}
