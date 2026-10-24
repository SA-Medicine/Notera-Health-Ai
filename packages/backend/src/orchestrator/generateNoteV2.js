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
import { enforceTemplate, fixMisplacement, drugPlausibility, checkInput, sweepEmptyStatements, tidyPlan, dropCoveredFragments, dedupeObjective, stripAddresses, reattachInvestigations, ensureChronicInPMH, trimAssessment } from './postGuards.js';
import { describeMeds, codeDiagnoses } from './refNames.js';
import { condenseNote } from './condenseNote.js';
import { dedupeNote } from './dedupeNote.js';
import { noteToMarkdown } from './renderMarkdown.js';
import { collectMeds } from './structureNote.js';
import { getActivePrompt, getActivePromptMeta } from './promptStore.js';
import { effectiveConfig } from './runtimeConfig.js';
import { pickExemplars, exemplarBlock } from './exemplars.js';
import { guardDrugNames } from './drugGuard.js';
import { writerDraftIssue, pickDraft, RETRY_NOTE } from './writerGuard.js';
import { joinPlanLines } from './planJoin.js';
import { askSweep, applySweep } from './planSweep.js';
import { splitAdviceLines } from './adviceLines.js';
import { qualityGuards } from './qualityGuards.js';
import { groupSubjectiveFields } from './topicGroup.js';
import { groundNote, missingNumbers, collectParts, applyRemovals } from './groundingAgent.js';
import { fidelityGuards } from './fidelityGuards.js';
import { askAttribution, applyAttribution } from './planAttribution.js';
import { completePlan } from './planComplete.js';
import { coverNote } from './noteCoverage.js';
import { structureTreatment } from './treatmentStructure.js';
import { fixPlacementV2 } from './placementRules.js';
import { buildFactGraph } from './factGraph.js';
import { reconcileFacts } from './factLedger.js';
import { checkDrugs } from './drugCheck.js';
import { stripCitations } from './factLedger.js';

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
  [STORY_PROMPT_NAME]:     { stage: 'Story', label: 'Story agent', help: 'Last step: groups the Subjective into topics with bullet points that follow on from each other, and tidies the Past Medical History into a few grammatical bullets, without adding or losing any fact. Off unless Settings → Story agent is on.', default: () => STORY_SYS, must: ['JSON', 'TRANSCRIPT'], min: 400 },
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
  if (_v3 === null) { try { _v3 = fs.readFileSync(new URL('../../prompts/writer-v5.txt', import.meta.url), 'utf8').replace(/\r/g, '').trim(); } catch { _v3 = ''; } }
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
      // runaway line: cut at a word boundary. A plan "a; b; c" list is cut per item, never as a whole (a long Advice list lost its last items)
      const cut = (s) => (s.length > 420 ? s.slice(0, 420).replace(/\s+\S*$/, '') : s);
      if (part.length > 420) part = process.env.NOTE_FIX === '0' ? cut(part) : part.split(/;\s+/).map(cut).join('; ');
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
const numWordsToDigits = (s) => String(s || '').replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi, (w) => String(NUMWORD[w.toLowerCase()])).replace(/\b(\d+) point (\d+)\b/gi, '$1.$2');   // "two point one" = 2.1
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

export function buildNote(out, meta) {
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
  // The doctor wants ONE "Medications:" line in Past Medical History (regular medications with strength/frequency, as stated).
  if (curMeds.length || (check.medications || []).length) {
    const regular = (check.medications || []).filter((m) => m?.name && inTranscript(String(m.name)) && !/new|stop|declin/.test(String(m.status || '').toLowerCase()))
      .map((m) => `${String(m.name).trim()}${m.detail ? ' ' + String(m.detail).trim() : ''}`);
    const have = String(note.past_medical_history.other || '').split('\n').findIndex((l) => /^medications?\s*:/i.test(l.trim()));
    if (regular.length) {
      const ls = String(note.past_medical_history.other || '').split('\n').filter(Boolean);
      if (have < 0) { ls.push('Medications: ' + [...new Set(regular)].join(', ')); note.past_medical_history.other = ls.join('\n'); added++; }
      else {
        const line = ls[ls.findIndex((l) => /^medications?\s*:/i.test(l.trim()))]; const missing = regular.filter((r) => !norm(line).includes(norm(r.split(' ')[0])));
        if (missing.length) { ls[ls.findIndex((l) => /^medications?\s*:/i.test(l.trim()))] = line.replace(/[.;,\s]+$/, '') + ', ' + missing.join(', '); note.past_medical_history.other = ls.join('\n'); added++; }
      }
    }
  }

  for (const r of (check.results || [])) {
    const test = String(r?.test || '').trim(), val = String(r?.value || '').trim(); if (!test || !val) continue;
    const objNorm = norm(JSON.stringify(note.objective)); const keyWords = norm(test).split(' ').filter((w) => w.length >= 3 && !/^(test|tests|blood|level|levels|scan|study|result|results|panel|the|and)$/.test(w));
    const testShown = keyWords.length > 0 && keyWords.some((w) => new RegExp('\\b' + w + '\\b').test(objNorm)) && (numsOf(numWordsToDigits(val)).length === 0 || numsOf(numWordsToDigits(val)).every((n) => objNorm.includes(n)));
    const valueShown = numsOf(val).filter((n) => !/^(19|20)\d\d$/.test(n)).some((n) => n.length >= 2) && numsOf(val).filter((n) => !/^(19|20)\d\d$/.test(n)).every((n) => objNorm.includes(n));   // e.g. 139 is already on a grouped line
    if (!inTranscript(test) || present(`${test} ${val}`) || testShown || valueShown || (numsOf(val).length && numsOf(val).every((n) => noteNorm().includes(n)) && present(test))) continue;
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
3b DOCTOR PREFERENCES: the assessment field holds ONLY a conclusion the clinician stated (delete lines that retell the history or start with "Patient reports/has/previously"); Past Medical History always lists every established chronic condition the transcript names (with status) even if it is also a plan problem; refills and renewals sit under the condition the drug treats, never as a separate refills problem; no addresses or housing details; an investigation sits under the problem it is about (an abdominal ultrasound belongs to the abdominal problem).
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
const STORY_SYS = `You are the story editor of a clinical scribe. You receive the SUBJECTIVE and PAST MEDICAL HISTORY of a clinical note as JSON, plus the TRANSCRIPT. Rewrite them the way a careful physician would want to read them: grouped by topic, in bullet points that follow on from each other. Return JSON with the keys "subjective" and "past_medical_history" and the SAME inner keys.
SUBJECTIVE — a list of TOPICS. Each topic is a heading line ending with a colon, followed by bullet lines. Put the first topic, "Presenting Complaint:", in reason_for_visit (one short bullet per reason for the visit). Put every other topic in hpi_details, topics separated by a blank line. Topics are SYMPTOMS and PROBLEMS only ("Abdominal Pain:", "Breathing:", "Bowel Symptoms:", "Mood:", "Weight Management:", and "Medication Adherence:" when the patient is not taking a medication); only topics that have content. NEVER make a topic for lifestyle, diet, habits, smoking, alcohol, social or family history or living situation: those facts MOVE to Past Medical History (social bullet) and nothing about them stays in Subjective. A heading is a plain line like "Mood:" with no dash.
BULLETS: each bullet is a short clinical clause of about 4 to 14 words, in plain clinical shorthand without filler ("Sharp right-sided abdominal pain radiating to back, present for at least 1 year"; "Episodes last 5 to 10 minutes, longer last night"; "Worse after eating, not specifically fatty foods"; "No nausea or fever"). No paragraphs. Order the bullets inside a topic so each follows from the one before and refers back to it: onset and duration, then character and severity, then course, then what helps or worsens it, then what was tried, then the effect on daily life. Join closely related fragments into one bullet with a comma or " - " ("Pain for 3 weeks - worse on stairs, eased by rest"). Say every fact and EVERY denial ONCE, in the topic it belongs to ("Denies nausea, fever or cough" goes with the abdominal pain, not repeated elsewhere). Leave aggravating_relieving_factors, symptom_progression, previous_episodes, functional_impact and associated_symptoms as empty strings: their content is already in the topics.
PAST MEDICAL HISTORY — at most 6 bullets in total, in the same fields: medical_surgical (conditions and operations, combined into grammatical bullets), social (ONE bullet: marital status, occupation, smoking, alcohol, who the patient lives with; DELETE every address, street, neighbourhood, town and housing detail), family, exposure, immunisation, and other. Keep the single "Medications: …" line exactly (names, strengths, frequencies) and the "Preventive care: …" line if present. Combine items of the same kind to make a bullet; never combine a medication with a condition unless the note already links them, and never name a condition from a drug.
STYLE: concise clinical language, third person, no quotes, no first person; never begin a bullet with "The patient", "The pain", "Has" or "Experiences" — begin with the finding itself. Use he or she ONLY if the transcript makes the sex explicit.
PLACEHOLDERS: the text may contain de-identification placeholders such as [date], [name] or "the specialist"; keep them exactly as written and never write "unspecified", "unknown" or "not mentioned". Use the transcript only to check wording; do not pull in facts that are not in the NOTE JSON.
HARD RULES: keep every fact exactly — write numbers as numerals exactly as in the note ("3 weeks", "500 mg", never "three weeks"); every number, dose, unit, date, duration, laterality, drug name, result and every specific denial; keep negations as negations. Never add a fact, a cause, a diagnosis or a judgement that is not already in the note — never name a condition from a drug and never turn a denial into a finding or the reverse; move facts between Subjective and Past Medical History ONLY for social, lifestyle, habit and background facts (they go to Past Medical History); leave an empty field empty. Return ONLY the JSON.`;
// Doctor length (30 gold notes: median 7 Subjective bullets of 11 words, 235 words in all; ours were 16 bullets of 8 words, 334 words).
// Fewer, fuller bullets that carry the same facts; editorAccepts() still rejects any rewrite that drops one. STORY_COMPACT=0 turns it off.
export const STORY_COMPACT = `
LENGTH: write like the physician who reads it — fewer, fuller bullets. Each bullet is ONE or TWO lines (about 10 to 22 words) that joins the closely related facts of one point with commas or " - " ("Right hip pain for 3 weeks, worse on stairs and at night, eased by rest"; "Tried Advil 400 mg twice daily with little relief, no side effects"). A topic usually has 2 to 4 bullets; the whole Subjective usually has 5 to 10 bullets. Merge bullets that say the same thing or continue each other, and delete restatements, but NEVER drop a fact, number, drug, denial or detail: shorter by merging and removing repetition, never by leaving facts out.`;
export async function storyPass(llm, note, transcript, log, { prompt, timeoutMs, added = [] }) {
  if (process.env.STORY_COMPACT !== '0' && !/\nLENGTH:/.test(prompt || '')) prompt = (prompt || STORY_SYS) + STORY_COMPACT;
  const t0 = Date.now(); const draft = { subjective: note.subjective, past_medical_history: note.past_medical_history };
  if (!Object.values(note.subjective || {}).some((v) => String(v || '').trim())) { log('[v2:story] skipped — nothing in Subjective'); return { out: null, why: 'empty', ms: 0 }; }
  const noHeads = (o) => { const c = {}; for (const [sec, f] of Object.entries(o || {})) { c[sec] = {}; for (const [k, v] of Object.entries(f || {})) c[sec][k] = String(v ?? '').split('\n').filter((l) => !/^[A-Za-z][A-Za-z &/,'-]{1,50}:\s*$/.test(l.trim())).join('\n'); } return c; };   // topic headings are structure, not facts
  const merge = added.length && process.env.NOTE_FIX !== '0' ? `\n\nLINES ADDED AFTER THE STORY WAS WRITTEN (they are in the NOTE JSON as bare one-fact lines): ${added.slice(0, 30).map((x) => `"${x}"`).join('; ')}.\nMerge EACH of them into the bullet of the topic it belongs to (join with a comma or " - "), or into the Past Medical History field it belongs to (a condition, a medicine, a past test); never leave one as a bullet on its own and never repeat a fact another bullet already says. Keep every fact and number.` : '';
  const user = `TRANSCRIPT (for checking facts only):\n"""\n${transcript.slice(0, 60000)}\n"""\n\nNOTE JSON:\n${JSON.stringify(draft)}${merge}\n\nReturn the rewritten JSON.`;
  let why = 'error'; let rejected = null;
  try {
    llm._agent = 'v2-story';
    for (let attempt = 0; attempt < 3; attempt++) {   // 3rd try only after two rejections (30% of newer test notes lost their topic headings after two)
      const feedback = attempt ? `\n\nYour previous rewrite was REJECTED by the fact checker: ${why}. Rewrite again, staying closer to the wording and facts of the NOTE JSON: do not add interpretive words (such as typically, chronic, requiring), do not change any number, and keep every fact.` : '';
      const raw = await llm.generateContent(prompt || STORY_SYS, user + feedback, null,
        { maxOutputTokens: 5000, timeoutMs: timeoutMs || 30000, retries: 0, hedgeMs: 20000, temperature: attempt === 1 ? 0 : attempt === 2 ? 0.3 : 0.2, thinkingBudget: 0, responseMimeType: 'application/json' });
      const out = parseJson(raw);
      if (!out || typeof out.subjective !== 'object') { why = 'unparseable or incomplete JSON'; log(`[v2:story] attempt ${attempt + 1} rejected — ${why}`); continue; }
      // the model sometimes returns a field as a list of lines instead of one string: always one string, one line per item
      for (const sec of ['subjective', 'past_medical_history']) for (const [k, v] of Object.entries(out[sec] || {})) if (Array.isArray(v)) out[sec][k] = v.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n');
      const isHead = (l) => /^[A-Za-z][A-Za-z &/,'-]{1,50}:\s*$/.test(String(l).trim());
      const heads = [out.subjective.reason_for_visit, out.subjective.hpi_details].flatMap((v) => String(v || '').split('\n')).filter(isHead).length;
      const bullets = String(out.subjective.hpi_details || '').split('\n').filter((l) => l.trim() && !isHead(l)).length;
      const medLine = String(draft.past_medical_history?.other || '').split('\n').find((l) => /^medications?\s*:/i.test(l.trim())) || '';
      const outText = norm(JSON.stringify(out)); const lostMed = norm(medLine).split(' ').filter((w) => w.length >= 4 && w !== 'medications' && w !== 'medication').find((w) => !outText.includes(w));
      let chk = editorAccepts(draft, noHeads(out), transcript, { noPlan: true, keptMin: 0.72, freshMax: 0.1, freshAbs: 8 });
      if (chk.ok && bullets >= 4 && heads < 2) chk = { ok: false, why: 'the Subjective has no topic headings — group the bullets under headings such as "Abdominal Pain:" and "Breathing:" (each heading is a line ending in a colon)' };
      if (chk.ok) {   // the same bullet twice (the model sometimes appends the old fragments after the new topics)
        const bl = String(out.subjective.hpi_details || '').split('\n').filter((l) => l.trim() && !isHead(l)).map((l) => new Set(norm(l).split(' ').filter((w) => w.length > 3)));
        let dupPair = false; for (let i = 0; i < bl.length && !dupPair; i++) for (let j = i + 1; j < bl.length; j++) { const sh = [...bl[i]].filter((w) => bl[j].has(w)).length; if (bl[i].size >= 3 && bl[j].size >= 3 && sh / Math.min(bl[i].size, bl[j].size) >= 0.8) { dupPair = true; break; } }
        if (dupPair) chk = { ok: false, why: 'some bullets repeat each other — say every fact once, under its topic, and do not append the old fragments' };
      }
      if (chk.ok && added.length && process.env.NOTE_FIX !== '0') {   // the merge pass must not append the added lines as topics of their own next to the bullets that already say them
        const all = [out.subjective.reason_for_visit, out.subjective.hpi_details].flatMap((v) => String(v || '').split('\n')).map((l) => l.trim()).filter(Boolean);
        const heads = all.filter(isHead).map((h) => norm(h)); const twice = heads.find((h, i) => heads.indexOf(h) !== i);
        const ws = (l) => new Set(norm(l).split(' ').filter((w) => w.length > 3)); const bl = all.filter((l) => !isHead(l)).map((l) => l.replace(/^[-•*]\s*/, ''));
        const copied = added.find((a) => { const A = ws(a); if (A.size < 3) return false; const self = bl.filter((b) => norm(b) === norm(a)); if (!self.length) return false; return bl.some((b) => norm(b) !== norm(a) && [...A].filter((w) => ws(b).has(w)).length / A.size >= 0.6); });
        if (twice) chk = { ok: false, why: `the topic "${twice}" appears twice — one heading per topic, merge the two` };
        else if (copied) chk = { ok: false, why: `"${copied}" was appended as it is next to a bullet that already says it — merge it into that bullet` };
      }
      if (chk.ok && lostMed) chk = { ok: false, why: `the medication line lost "${lostMed}" — keep every drug name and strength exactly` };
      if (!chk.ok) { why = chk.why; rejected = out.subjective; log(`[v2:story] attempt ${attempt + 1} rejected — ${chk.why}`); continue; }
      log(`[v2:story] applied${attempt ? ' on retry' : ''} (kept ${(chk.kept * 100).toFixed(0)}% of words, ${chk.fresh} new words)`);
      return { out, why: attempt ? 'applied on retry' : 'applied', ms: Date.now() - t0 };
    }
    return { out: null, why, rejected, ms: Date.now() - t0 };
  } catch (e) { log(`[v2:story] skipped — ${e.message}`); return { out: null, why: 'error: ' + e.message, ms: Date.now() - t0 }; }
}

export async function generateNoteV2(input, opts = {}) {
  const t0 = Date.now();
  const { specialty = 'general_primary_care', noteType = 'consultation', clinicianId = 'unknown' } = input;
  const persist = opts.persist !== false;
  const lean = opts.lean ?? process.env.LEAN === '1';      // v3 experiment: the fact graph feeds a writer that cites fact ids per line; the model stages that patch the draft (editor, verifier, story, sweep, attribution, coverage, grounding) are skipped
  const leanKeep = new Set(String(opts.leanKeep ?? process.env.LEAN_KEEP ?? '').split(',').map((s) => s.trim()).filter(Boolean));   // stages kept on in lean mode, e.g. coverage,story
  const skip = (stageName) => lean && !leanKeep.has(stageName);
  const cited = opts.cited ?? (lean || process.env.CITED_WRITER === '1'); let citedIds = null; let ledgerSummary = null; let storyDone = null;   // storyDone: the story pass ran; facts added after it are woven in by a second pass
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

  let note; let checkForRef = null; let factsP = null; let sweepAnswer = null;   // sweepAnswer: the plan sweep asks its question while the editor and story agent work (speed)
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
      let writerUser = exemplarBlock(shots) + `TRANSCRIPT (sole source of truth):\n"""\n${transcript}\n"""\n\nWrite the SOAP note. Return ONLY JSON.`;
      const writerOpts = {
        maxOutputTokens: cfg['writer.maxOutputTokens'], timeoutMs: opts.writerTimeoutMs ?? cfg['writer.timeoutMs'],
        retries: 3, hedgeMs: opts.writerHedgeMs ?? cfg['writer.hedgeMs'], temperature: opts.writerTemp ?? cfg['writer.temperature'], thinkingBudget: opts.writerThinking ?? cfg['writer.thinkingBudget'], fallbackModel: opts.writerFallback ?? (cfg['writer.fallbackModel'] || 'gemini-3.5-flash-lite'),
        topP: opts.writerTopP ?? cfg['writer.topP'], ...(process.env.V2_WRITER_TOP_K ? { topK: Number(process.env.V2_WRITER_TOP_K) } : {}),
        ...(process.env.V2_WRITER_SEED ? { seed: Number(process.env.V2_WRITER_SEED) } : {}), ...(process.env.V2_WRITER_FREQ_PENALTY ? { frequencyPenalty: Number(process.env.V2_WRITER_FREQ_PENALTY) } : {}) };
      const graphOn = process.env.FACT_GRAPH !== '0' && opts.factGraph !== false && cfg['stage.factGraph'] !== false;
      if (graphOn && (cited || opts.factsToWriter === true || process.env.FACTS_TO_WRITER === '1')) {   // the writer reads the fact graph too (it waits for the graph first)
        factsP = buildFactGraph(transcript, { log }); const g0 = await factsP;
        if (g0.facts.length) writerUser += '\n\nFACT GRAPH (every fact below was said in the visit and has been checked against the transcript; each one must appear in the note, once, in the field where it belongs; drug names, doses, numbers and test names exactly as listed):\n' + g0.facts.slice(0, 90).map((f) => `${f.id} [${f.type}${f.medication_status ? '/' + f.medication_status : ''}${f.negative ? '/denied' : ''}] ${f.text}${f.body_part ? ' (' + f.body_part + ')' : ''}${f.value ? ' = ' + f.value + (f.unit ? ' ' + f.unit : '') : ''}`).join('\n') + '\n';
      }
      if (cited) writerUser += '\nCITATIONS: start EVERY line of every field with the ids of the facts it states, in square brackets, e.g. "[F003,F007] Lyrica 75 mg twice daily". Every fact id in the FACT GRAPH must be cited by at least one line. A line that states nothing from the graph starts with "[-]".';
      const writerP = writerLlm.generateContent(writerPrompt, writerUser, WRITER_SCHEMA, writerOpts);
      const recallOn = opts.recall !== undefined ? !!opts.recall : cfg['recall.extended']; used.config.recall = recallOn;
      const checkP = checkLlm.generateContent((cMeta?.text || CHECK_SYS) + (recallOn ? CHECK_EXTRA : ''), `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nReturn ONLY the JSON.`, recallOn ? CHECK_SCHEMA_X : CHECK_SCHEMA, {
        maxOutputTokens: recallOn ? 3000 : 1500, timeoutMs: 20000, retries: 0, hedgeMs: 7000, temperature: 0, thinkingBudget: 0 })
        .then((r) => parseJson(r)).catch((e) => { log(`[v2:checklist] skipped — ${e.message}`); return null; });
      if (!factsP) factsP = graphOn ? buildFactGraph(transcript, { log }) : null;   // Style Spec v2.3: the owner's fact-graph extractor reads the visit at the same time as the writer
      const [writerRaw, check] = await Promise.all([writerP, checkP]); checkForRef = check;
      lap('writer+checklist', tw);
      let out = parseJson(writerRaw);
      if (cited && out) { const c = stripCitations(out); citedIds = c.ids; log(`[v2:cite] ${c.lines} line(s), ${c.cited} with fact ids, ${c.ids.size} fact(s) cited`); if (opts.trace) opts.trace.citations = { lines: c.lines, cited: c.cited, ids: [...c.ids] }; }
      if (!out) {   // a stronger model occasionally returns truncated/invalid JSON (~4% on gemini-3.7-flash): retry once, deterministic, on the fallback model
        log('[v2:writer] unparseable JSON — retrying once on the fallback model at temperature 0');
        try { const retryLlm = await createGeminiService(null, { model: cfg['writer.fallbackModel'] || 'gemini-3.5-flash-lite' }); retryLlm._agent = 'v2-writer';
          out = parseJson(await retryLlm.generateContent(writerPrompt, writerUser, WRITER_SCHEMA, { ...writerOpts, temperature: 0, thinkingBudget: 0, fallbackModel: undefined, retries: 0 })); } catch (e) { log(`[v2:writer] retry failed — ${e.message}`); }
      }
      if (out && opts.writerDraftRetry !== false) {   // a draft with no plan, or a repetition loop that never reached the plan: ask the same writer once more (2 of 30 test notes, 2026-10-22)
        const issue = writerDraftIssue(out, transcript);
        if (issue) {
          log(`[v2:writer] unusable draft (${issue === 'loop' ? 'repetition loop' : 'no Assessment & Plan'}) — retrying once on the same model`);
          const tr = Date.now(); const first = out; let used = 'original', last = issue;
          // attempt 1: same model, a little warmer and with a repetition penalty; attempt 2 (only if still unusable): the fallback model at temperature 0, as for unparseable JSON
          const attempts = [
            ['same model', () => writerLlm.generateContent(writerPrompt, writerUser + RETRY_NOTE, WRITER_SCHEMA, { ...writerOpts, temperature: Math.max(0.4, Number(writerOpts.temperature) || 0), timeoutMs: Math.min(45000, writerOpts.timeoutMs || 45000), retries: 0, hedgeMs: 0 })],
            ['fallback model', async () => { const l = await createGeminiService(null, { model: cfg['writer.fallbackModel'] || 'gemini-3.5-flash-lite' }); l._agent = 'v2-writer'; return l.generateContent(writerPrompt, writerUser + RETRY_NOTE, WRITER_SCHEMA, { ...writerOpts, temperature: 0, thinkingBudget: 0, fallbackModel: undefined, retries: 0, hedgeMs: 0, timeoutMs: 45000 }); }],
          ];
          // both attempts run at the same time (they ran one after the other: up to 34 s); the same model's draft is still preferred when it is usable
          const tries = process.env.PARALLEL_RETRY === '0' ? null : attempts.map(([name, run]) => run().then((r) => parseJson(r)).catch((e) => { log(`[v2:writer] draft retry (${name}) failed — ${e.message}`); return null; }));
          for (let k = 0; k < attempts.length; k++) {
            const [name, run] = attempts[k]; if (!last) break;
            let again = null; if (tries) again = await tries[k]; else { try { again = parseJson(await run()); } catch (e) { log(`[v2:writer] draft retry (${name}) failed — ${e.message}`); } }
            const pick = pickDraft(out, again, transcript); log(`[v2:writer] draft retry (${name}): kept the ${pick.used} (${pick.before || 'ok'} -> ${pick.after || 'ok'})`);
            if (pick.used === 'retry') { out = pick.draft; used = name; } last = writerDraftIssue(out, transcript);
          }
          lap('writer-retry', tr);
          if (opts.trace) opts.trace.writer_retry = { reason: issue, used, after: last || 'ok', first_draft: first };
        }
      }
      if (opts.trace) { opts.trace.writer_json = out; opts.trace.checklist = check; }
      if (!out) throw new Error('v2 writer returned unparseable JSON');
      if (!blank && !lean && opts.planSweep !== false && process.env.PLAN_SWEEP !== '0' && cfg['stage.planSweep'] !== false) {   // F1 (speed): the sweep only reads the draft's problem list, so it runs beside the editor and story; its answer is checked and merged against the FINAL note later
        try {
          const sllm = await createGeminiService(null, { model: opts.storyModel || cfg['story.model'] }); sllm._agent = 'v2-sweep';
          sweepAnswer = askSweep(sllm, buildNote(JSON.parse(JSON.stringify(out)), { specialty: specialtyResolved, noteType, generatedBy: PIPELINE_VERSION }), transcript);
        } catch (e) { log('[v2:sweep] not started — ' + e.message); }
      }
      let finalOut = out;
      const useEditor = !skip('editor') && (opts.editor !== undefined ? !!opts.editor : cfg['editor.enabled']);
      if (useEditor) {
        const te = Date.now(); const eMeta = await getActivePromptMeta(EDITOR_PROMPT_NAME); used.prompts.editor = eMeta ? `v${eMeta.version}` : 'default';
        const editorLlm = await createGeminiService(null, { model: cfg['editor.model'] });
        const er = await editWriterJson(editorLlm, out, transcript, log, { prompt: eMeta?.text, model: cfg['editor.model'], timeoutMs: Math.min(cfg['editor.timeoutMs'], Number(process.env.EDITOR_CAP_MS || 12000)) });   // the editor is 3.6 s on average; a slow one (18 s seen) is dropped and the draft kept, so a note stays under 60 s
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
      if (cfg['drugs.guardEnabled']) { try { const dg = guardDrugNames(note, transcript, check, log, { rewriteUnclear: opts.fidelityGuards !== false && process.env.FIDELITY_GUARDS !== "0" && cfg["stage.fidelityGuards"] !== false }); if (opts.trace) opts.trace.drugs = dg; } catch (e) { log(`[v2:drugs] skipped — ${e.message}`); } }
      // 2a) guardrails built from the diagnosis reports (each has its own switch in Settings)
      if (gOn('guards.template', opts.guardTemplate)) { try { const r = enforceTemplate(note, log); if (opts.trace) opts.trace.template = r; } catch (e) { log(`[v2:template] skipped — ${e.message}`); } }
      if (gOn('guards.template', opts.guardTemplate)) { try { ensureChronicInPMH(note, log); } catch (e) { log(`[v2:tidy] skipped — ${e.message}`); } }
      if (gOn('guards.placement', opts.guardPlacement)) { try { const r = fixMisplacement(note, log); if (opts.trace) opts.trace.placement = r; } catch (e) { log(`[v2:place] skipped — ${e.message}`); } }
      if (gOn('guards.placement', opts.guardPlacement) && opts.placementRules !== false && process.env.PLACEMENT_RULES !== '0') { try { fixPlacementV2(note, log); } catch (e) { log(`[v2:place2] skipped — ${e.message}`); } }   // Style Spec v2.2: a vital sign in the plan, a vaccine given in the visit written as an exam finding, history text under Referrals
      if (gOn('guards.drugPlausibility', opts.guardPlausibility)) { try { const r = drugPlausibility(note, transcript, log); if (opts.trace) opts.trace.plausibility = r; } catch (e) { log(`[v2:plausible] skipped — ${e.message}`); } }
      if (!inputChk.ok) note.metadata.flags = [...(note.metadata.flags || []), { type: 'input_not_consultation', field: 'transcript', message: inputChk.message + ' Please check the recording or text.', severity: 'warning' }];
      note.metadata.medications_mentioned = [...new Set([...(collectMeds(note)), ...((check?.medications || []).map((m) => m?.name).filter(Boolean))])];

      // 3) deterministic placement fixes, then ONE verifier call ---------------------
      try { note = reconcileNote(note); } catch (e) { log(`[v2] reconcile skipped: ${e.message}`); }
      if (!skip('verifier') && cfg['verifier.enabled']) {
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
  const freeFlow = opts.freeFlow !== undefined ? !!opts.freeFlow : process.env.FREE_FLOW === '1';   // Style Spec v2.2 (owner 2026-10-24): while on, the fuzzy 'already stated' removals are off and only identical lines are dropped (FREE_FLOW=0 restores the earlier behaviour)
  try { condenseNote(note, { freeFlow }, log); } catch (e) { log(`[v2] condense skipped: ${e.message}`); }
  try { note = reconcileNote(note); } catch { /* */ }
  try { dedupeNote(note, { log, freeFlow }); } catch (e) { log(`[v2] dedupe skipped: ${e.message}`); }
  let attrAnswer = null;   // plan attribution (Style Spec v2): asked beside the story agent, applied to the final note below
  if (!blank && !lean && opts.planAttribution !== false && process.env.ATTRIBUTION !== '0' && cfg['stage.attribution'] !== false) {
    try { const allm = await createGeminiService(null, { model: opts.storyModel || cfg['story.model'] }); allm._agent = 'v2-attr'; attrAnswer = askAttribution(allm, note, transcript); } catch (e) { log('[v2:attr] not started — ' + e.message); }
  }
  // STORY agent (independent, optional, LAST): the verified note is rewritten into a readable clinical story; facts are checked by code
  if (!blank && !skip('story') && (opts.story !== undefined ? !!opts.story : cfg['story.enabled'])) {
    const ts = Date.now(); const sMeta = await getActivePromptMeta(STORY_PROMPT_NAME); used.prompts.story = sMeta ? `v${sMeta.version}` : 'default';
    const storyModel = opts.storyModel || cfg['story.model']; used.config.story = storyModel;
    const storyLlm = await createGeminiService(null, { model: storyModel });
    const sr = await storyPass(storyLlm, note, transcript, log, { prompt: sMeta?.text, timeoutMs: cfg['story.timeoutMs'] });
    lap('story', ts);
    if (sr.out) {
      for (const [sec, keys] of SEC_FIELDS.slice(0, 2)) for (const k of keys) if (sr.out[sec] && k in sr.out[sec]) note[sec][k] = String(sr.out[sec][k] ?? '').split('\n').map((l) => l.replace(/^\s*[-•*]\s+/, '').trimEnd()).join('\n').trim();
      note.metadata.subjective_style = 'topics';
      if (!/^[A-Za-z][A-Za-z &/,'-]{1,50}:\s*$/.test(String(note.subjective.reason_for_visit || '').split('\n')[0].trim())) note.subjective.reason_for_visit = ('Presenting Complaint:\n' + String(note.subjective.reason_for_visit || '')).trim();
    }
    if (!sr.out && sr.why !== 'empty') {   // fallback: group the existing Subjective lines under headings (nothing is reworded) when the rewrite was rejected every time
      try {
        const g = await groupSubjectiveFields(storyLlm, note.subjective, log);
        if (g) {
          note.subjective.hpi_details = g.text; for (const k of g.moved) note.subjective[k] = ''; note.metadata.subjective_style = 'topics';
          if (!/^[A-Za-z][A-Za-z &/,'-]{1,50}:\s*$/.test(String(note.subjective.reason_for_visit || '').split('\n')[0].trim())) note.subjective.reason_for_visit = ('Presenting Complaint:\n' + String(note.subjective.reason_for_visit || '')).trim();
          sr.why = 'grouped (fallback)'; sr.grouped = true;
        }
      } catch (e) { log('[v2:story] fallback skipped — ' + e.message); }
    }
    if (opts.trace) opts.trace.story = { applied: !!sr.out, why: sr.why, ms: sr.ms, subjective: sr.out?.subjective || null, rejected: sr.rejected || null };
    storyDone = { sr, model: storyModel, prompt: sMeta?.text, snapshot: JSON.stringify([note.subjective, note.past_medical_history]) };
  }
  if (!blank && (opts.guardTemplate !== undefined ? !!opts.guardTemplate : cfg['guards.template'])) { try { sweepEmptyStatements(note, log); if (note.metadata.subjective_style === 'topics' && !freeFlow) dropCoveredFragments(note, log); dedupeObjective(note, log); stripAddresses(note, log); reattachInvestigations(note, log); trimAssessment(note, log); tidyPlan(note, log, { exact: freeFlow }); } catch (e) { log(`[v2:tidy] skipped — ${e.message}`); } }
  if (attrAnswer) { try { const at = applyAttribution(note, await attrAnswer, transcript, log); if (opts.trace) opts.trace.attribution = at; } catch (e) { log('[v2:attr] skipped — ' + e.message); } }
  if (!blank && (opts.qualityGuards !== false && process.env.QUALITY_GUARDS !== '0' && cfg['stage.qualityGuards'] !== false)) { try { const q = qualityGuards(note, transcript, log, { conditions: opts.conditionGuard === true || cfg['stage.conditionGuard'] === true, thirdParty: opts.thirdParty !== false && process.env.THIRD_PARTY !== '0' }); if (opts.trace) opts.trace.quality = q; } catch (e) { log(`[v2:quality] skipped — ${e.message}`); } }   // Style Spec v2: Diagnosis only if the clinician said it, no spoken words in the plan, side check (QUALITY_GUARDS=0 switches off). The condition guard (unsaid diseases out of PMH/titles) is OFF by default since the paired A/B of 2026-10-22 (CONDITION_GUARD=1 turns it on)
  if (sweepAnswer) {   // F1: one problem per issue — merge what the early sweep found (quote-checked, additions only) into the final note
    const ts = Date.now();
    try { const sw = applySweep(note, await sweepAnswer, transcript, log); if (opts.trace) opts.trace.sweep = sw; } catch (e) { log('[v2:sweep] skipped — ' + e.message); }
    lap('sweep', ts);
  }
  const coverageOn = !blank && !skip('coverage') && opts.noteCoverage !== false && process.env.NOTE_COVERAGE !== '0' && cfg['stage.noteCoverage'] !== false;   // the coverage check also covers the plan (one call instead of two), so the separate plan pass runs only when coverage is off
  if (!blank && !coverageOn && opts.planComplete !== false && process.env.PLAN_COMPLETE !== '0' && cfg['stage.planComplete'] !== false && (note.assessment_and_plan || []).length) {   // Style Spec v2.1.1: a problem left as a bare heading is filled from the transcript (quote-checked) or removed; advice / follow-up / orders the plan left out are added (PLAN_COMPLETE=0 switches off)
    const tc = Date.now();
    try { const cllm = await createGeminiService(null, { model: opts.storyModel || cfg['story.model'] }); cllm._agent = 'v2-complete'; const pc = await completePlan(cllm, note, transcript, log); if (opts.trace) opts.trace.complete = pc; } catch (e) { log(`[v2:complete] skipped — ${e.message}`); }
    lap('complete', tc);
  }
  // The grounding check (10 s on average, the longest stage) runs AT THE SAME TIME as coverage, ledger and the story merge, on a copy of the note as it is now:
  // what those stages add is already quote-checked (coverage evidence, fact-graph quotes). Its removals are applied to the finished note by text afterwards;
  // a removed line that a later stage reworded is flagged for checking instead. PARALLEL_GROUND=0 runs it last, as before.
  const groundOn = !blank && !skip('grounding') && opts.grounding !== false && process.env.GROUNDING !== '0' && cfg['stage.grounding'] !== false;
  let groundP = null;
  if (groundOn && process.env.PARALLEL_GROUND !== '0') {
    const snap = structuredClone(note); const flags0 = (snap.metadata?.flags || []).length; const tg0 = Date.now();
    groundP = (async () => { const gllm = await createGeminiService(null, { model: opts.storyModel || cfg['story.model'] }); gllm._agent = 'v2-ground'; const gr0 = await groundNote(gllm, snap, transcript, log); return { gr0, snap, flags0, ms: Date.now() - tg0 }; })()
      .catch((e) => ({ error: e }));
  }
  if (coverageOn) {   // Style Spec v2.1.2: what was said and is missing from the finished note is added under its topic (quote-checked); the grounding agent checks it next (NOTE_COVERAGE=0 switches off)
    const tv = Date.now();
    try { const vllm = await createGeminiService(null, { model: opts.storyModel || cfg['story.model'] }); vllm._agent = 'v2-coverage'; const cv = await coverNote(vllm, note, transcript, log, { meds: checkForRef?.medications || [] }); if (opts.trace) opts.trace.coverage = cv; } catch (e) { log(`[v2:coverage] skipped — ${e.message}`); }
    lap('coverage', tv);
  }
  if (factsP && !blank && process.env.FACT_LEDGER !== '0' && opts.factLedger !== false && cfg['stage.factLedger'] !== false) {   // Style Spec v2.3: every required fact of the graph is checked against the finished note; missing ones are placed by a model call, then by rule
    const tl = Date.now();
    try {
      const graph = await factsP; if (opts.trace) opts.trace.factGraph = { facts: graph.facts.length, windows: graph.windows, recovered: graph.recovered, ms: graph.ms, counts: graph.counts, error: graph.error || null, graph: opts.keepGraph ? graph : undefined };
      if (graph.facts.length) { const lllm = await createGeminiService(null, { model: opts.storyModel || cfg['story.model'] }); lllm._agent = 'v2-ledger'; const led = await reconcileFacts(lllm, note, graph, transcript, log, { cited: citedIds }); ledgerSummary = led.summary; if (opts.trace) opts.trace.factLedger = { summary: led.summary, rows: led.rows, facts: graph.facts.map((f) => ({ id: f.id, type: f.type, text: f.text, importance: f.importance })) }; }
    } catch (e) { log(`[v2:ledger] skipped — ${e.message}`); }
    lap('ledger', tl);
  }
  // Facts the coverage check and the fact ledger added to the Subjective or history arrive as bare lines after the story was written. When that happened, the story
  // pass runs once more so they become part of the topic story (short lines that read on from each other) instead of a list of facts. Its own checks reject a rewrite
  // that loses or invents anything, and then the note is kept as it is.
  if (storyDone?.sr?.out && process.env.STORY_REWEAVE !== '0' && JSON.stringify([note.subjective, note.past_medical_history]) !== storyDone.snapshot) {
    const tw = Date.now();
    try {
      // the lines that arrived after the story, so the second pass merges them into the bullets they belong to instead of keeping them as one-fact bullets
      const linesOf = (v) => (typeof v === 'string' ? v.split('\n') : v && typeof v === 'object' ? Object.values(v).flatMap(linesOf) : []).map((x) => String(x).replace(/^\s*[-•*]\s*/, '').trim()).filter((x) => x.length > 3 && !/:\s*$/.test(x));
      const before = new Set(linesOf(JSON.parse(storyDone.snapshot))); const added = linesOf([note.subjective, note.past_medical_history]).filter((x) => !before.has(x));
      const llm2 = await createGeminiService(null, { model: storyDone.model }); const sr2 = await storyPass(llm2, note, transcript, log, { prompt: storyDone.prompt, timeoutMs: cfg['story.timeoutMs'], added });
      if (sr2.out) { for (const [sec, keys] of SEC_FIELDS.slice(0, 2)) for (const k of keys) if (sr2.out[sec] && k in sr2.out[sec]) note[sec][k] = String(sr2.out[sec][k] ?? '').split('\n').map((l) => l.replace(/^\s*[-•*]\s+/, '').trimEnd()).join('\n').trim(); log('[v2:story] added facts woven into the story'); }
      else log(`[v2:story] second pass kept the note as it is (${sr2.why || 'rejected'})`);
    } catch (e) { log(`[v2:story] second pass skipped — ${e.message}`); }
    lap('reweave', tw);
  }
  if (groundP) {   // the parallel grounding check: its removals and flags, applied to the finished note
    const tg = Date.now(); const g = await groundP;
    if (g.error) log(`[v2:ground] skipped — ${g.error.message}`);
    else {
      const parts = collectParts(note); const used = new Set(); const hits = []; const lost = [];
      for (const r of g.gr0.removed || []) { const idx = parts.findIndex((p, i) => !used.has(i) && p.key === r.key && p.text === r.text); if (idx >= 0) { used.add(idx); hits.push({ idx }); } else lost.push(r); }
      const n = applyRemovals(parts, hits);
      note.metadata ||= {}; note.metadata.flags = [...(note.metadata.flags || []), ...(g.snap.metadata?.flags || []).slice(g.flags0),
        ...lost.map((r) => ({ type: 'check_against_recording', field: 'note', message: `"${String(r.text).slice(0, 120)}" - the fact check could not find this in the recording`, severity: 'warning' }))];
      if (lost.length) log(`[v2:ground] ${lost.length} unsupported line(s) were reworded by a later stage: flagged for checking instead of removed`);
      if (opts.trace) opts.trace.grounding = { ...g.gr0, removed: (g.gr0.removed || []).map((r) => ({ text: r.text, where: r.where })), appliedRemovals: n, parallel: true };
    }
    stage.ground = g.ms || 0; lap('groundWait', tg);   // 'ground' = the check's own time (it overlapped other stages); 'groundWait' = what the note still waited for it
  } else if (groundOn) {   // Style Spec v2: grounding agent — last fact check of every line against the transcript (removes the unsupported, flags the doubtful)
    const tg = Date.now();
    try { const gllm = await createGeminiService(null, { model: opts.storyModel || cfg['story.model'] }); gllm._agent = 'v2-ground'; const gr0 = await groundNote(gllm, note, transcript, log); if (opts.trace) opts.trace.grounding = gr0; } catch (e) { log(`[v2:ground] skipped — ${e.message}`); }
    lap('ground', tg);
  }
  // Reference names (RxNorm brand -> generic, ICD-10-CM codes): public NIH services, only drug/diagnosis words leave the server; time-boxed
  let refMeds = [];
  if (!blank && cfg['ref.enabled']) {
    const tr = Date.now();
    try {
      const names = [...(checkForRef?.medications || []).map((m) => String(m?.name || '').trim())];
      const [meds, dx] = await Promise.all([describeMeds(note, names, { log, timeoutMs: cfg['ref.timeoutMs'] }), codeDiagnoses(note, { log, timeoutMs: cfg['ref.timeoutMs'] })]);
      refMeds = meds || [];
      if (opts.trace) opts.trace.reference = { meds, dx, ms: Date.now() - tr };
    } catch (e) { log(`[v2:ref] skipped — ${e.message}`); }
    lap('ref', tr);
  }
  if (!blank && opts.fidelityGuards !== false && process.env.FIDELITY_GUARDS !== '0' && cfg['stage.fidelityGuards'] !== false) { try { const fg = fidelityGuards(note, transcript, { refMeds, log, missing: missingNumbers }); if (opts.trace) opts.trace.fidelity = fg; } catch (e) { log(`[v2:fidelity] skipped — ${e.message}`); } }   // Style Spec v2.1: unheard drug/test names, social history nobody said, empty headings, duplicates
  if (!blank && opts.joinPlanLabels !== false && process.env.PLAN_JOIN_LABELS !== '0' && cfg['stage.planJoin'] !== false) { try { joinPlanLines(note, log); } catch (e) { log(`[v2:join] skipped — ${e.message}`); } }   // F2: each label once per problem
  const renderedRaw = (!blank && (opts.adviceLines !== false && process.env.ADVICE_LINES !== '0' && cfg['stage.adviceLines'] !== false)) ? splitAdviceLines(noteToMarkdown(note)) : noteToMarkdown(note);
  const renderedNote = (!blank && opts.treatmentStructure !== false && process.env.TREATMENT_STRUCTURE !== '0' && cfg['stage.treatmentStructure'] !== false) ? structureTreatment(renderedRaw) : renderedRaw;   // Style Spec v2.2: Treatment planned as Started / Changed / Stopped / Continued / Given today sub-points (TREATMENT_STRUCTURE=0 switches off)   // Style Spec v2: Advice and Follow-up as their own lines (ADVICE_LINES=0 switches off)
  let drugReview = [];   // the medicines box under the note: every drug, checked against RxNorm (name and dose), with a one-click fix
  if (!blank && process.env.DRUG_CHECK !== '0' && opts.drugCheck !== false && cfg['stage.drugCheck'] !== false) {
    const td = Date.now();
    try { const dc = await checkDrugs(renderedNote, transcript, { log, patientMeds: input.patientMeds || opts.patientMeds || [] }); drugReview = dc.review; note.metadata ||= {}; note.metadata.flags = [...(note.metadata.flags || []), ...dc.flags, ...dc.review.map((r) => ({ type: 'drug_review', field: 'medications', severity: 'info', message: JSON.stringify(r) }))]; if (opts.trace) opts.trace.drugs = dc.review; } catch (e) { log(`[v2:drugs] skipped — ${e.message}`); }
    lap('drugs', td);
  }

  // 5) persist -------------------------------------------------------------------
  // what the admin Quality page reads for every production note: fact ledger, medicines, checks, time per stage
  note.metadata ||= {}; note.metadata.quality = { ledger: ledgerSummary, drugs: { total: drugReview.length, unknown: drugReview.filter((d) => !d.verified).length, suggested: drugReview.filter((d) => d.suggestion).length, doseChecks: drugReview.filter((d) => !d.doseOk).length }, timings: { ...stage, total: Date.now() - t0 }, mode: lean ? 'lean' : 'v2', at: new Date().toISOString() };
  const allFlags = [...gr.flags]; for (const f of (note.metadata?.flags || [])) if (f && !allFlags.some((g) => g.type === f.type && g.message === f.message)) allFlags.push(f);   // the web app shows these above the note
  const draftId = `DRAFT-${Date.now()}`;
  if (persist) {
    await store.updateConsult(consultId, { status: 'ready', specialty: specialtyResolved, transcript: { text: transcript }, entities: [] });
    await store.addDraft(consultId, { draftId, modelVersion: PIPELINE_VERSION, schemaVersion: note.schema_version, note, renderedNote, rawRenderedNote: renderedNote, flags: allFlags, confidence: note.metadata.confidence || {}, status: gr.status, createdAt: new Date().toISOString() });
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
  return { consultId, draftId, note, renderedNote, rawRenderedNote: renderedNote, status: gr.status, flags: allFlags, schemaErrors: gr.schemaErrors,
    entities: [], detectedSpecialty: detected, tokenUsage, qa: null, pipeline: 'v2', timings: { ...stage, total } };
}
