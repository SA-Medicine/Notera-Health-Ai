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

import { emptyNote, emptyIssue, validateNote } from '@notera/schema';
import { createGeminiService } from '../services/LLMService.js';
import { store, audit } from '../firestore/store.js';
import { runGuardrails } from '../validation/guardrails.js';
import { applyUpgradeGuardrails, isBlankEncounter, classifyEncounterDeterministic } from '../validation/upgrades.js';
import { reconcileNote } from './reconcileNote.js';
import { condenseNote } from './condenseNote.js';
import { dedupeNote } from './dedupeNote.js';
import { noteToMarkdown } from './renderMarkdown.js';
import { collectMeds } from './structureNote.js';

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

const WRITER_SYS = `You are Notera, an expert clinical scribe. Write the SOAP note for this consultation using ONLY the transcript.

STYLE — concise and specific, like an experienced clinician's own note:
- Every field is a short list of facts; put each fact on its own line (separate lines with "\\n"). A line is a short phrase or one brief sentence. No filler, no transitions, no restating the same fact twice, no "patient reports that…" padding.
- Keep EVERY clinically specific detail exactly as stated: numbers, doses, units, dates, durations, laterality, names of tests/drugs, specific denials ("denies bleeding from the pills", not "denies bleeding").
- COMPLETENESS: concise never means omitting facts. Capture EVERY diagnosis/problem the clinician addressed, every medication (with dose/frequency, and whether started/changed/stopped/continued), every test result, every order, referral, instruction and the follow-up/return timing, and every pertinent positive/negative the patient or clinician states. Go through the whole transcript, including its second half.
- Leave a field "" when the transcript says nothing about it. Never write "not mentioned", "N/A" or "none".

FIELDS
Subjective: reason_for_visit; hpi_details (onset, duration, location, quality, severity, context); aggravating_relieving_factors; symptom_progression; previous_episodes; functional_impact; associated_symptoms (focal + systemic, include pertinent negatives).
Past Medical History: medical_surgical; social (occupation, smoking, alcohol, drugs, living situation); family; exposure; immunisation; other (include current medications here as "Current medications: …").
Objective: vital_signs; examination (findings only, no medications); completed_investigations (each completed test WITH its result, flag and date when stated; never a bare test name, never planned tests).
Assessment & Plan: ONE entry per real problem, ranked by importance (reason for visit first): issue (most specific diagnosis the transcript supports, e.g. "Iron deficiency anaemia" not "Anaemia"), diagnosis (only if explicitly stated), assessment (the clinician's interpretation/status — NOT a retell of the history), differential_diagnoses (only if the clinician listed them), investigations_planned, treatment_planned (medications with dose/frequency, advice, follow-up/return-to-clinic timing), referrals.

PLACEMENT: numeric lab/vital values live ONLY in Objective (Subjective may say a trend in words). One value per measurement; never contradict yourself. Referrals only in A&P "referrals". Do not repeat normal lab results in the A&P. Group a problem's own medications under that problem.

ANTI-HALLUCINATION (critical): a thing merely mentioned in passing is not a problem — only make an A&P entry for something the clinician assessed or acted on. Never invent a disease, medication, dose, value, referral, diagnosis, name or date. If the transcript does not say it, leave it out.

Return STRICT JSON matching the schema.`;

const CHECK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    medications: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: S(), detail: S(), status: S() } } },
    results: { type: 'ARRAY', items: { type: 'OBJECT', properties: { test: S(), value: S(), date: S() } } },
    orders: A(), referrals: A(), follow_up: S(),
  },
};
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

// ── helpers ──────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w.length > 3);
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
  if (curMeds.length) append(note.past_medical_history, 'other', `Current medications: ${curMeds.join(', ')}`);

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
  if (added) log(`[v2:merge] checklist added ${added} grounded item(s) the writer omitted`);
  return added;
}

// ── verifier (model proposes, code confirms) ─────────────────────────────────
async function verifyNote(llm, note, transcript, log) {
  const lines = enumerateLines(note);
  if (lines.length < 4) return { dropped: 0 };
  const numbered = lines.map((l) => `${l.id}. [${l.label}] ${l.text}`).join('\n');
  llm._agent = 'v2-verifier';
  let res;
  try {
    res = parseJson(await llm.generateContent(VERIFY_SYS,
      `=== TRANSCRIPT ===\n${transcript.slice(0, 90000)}\n\n=== NOTE ===\n${numbered}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 900, timeoutMs: Number(process.env.V2_VERIFY_TIMEOUT_MS) || 15000, retries: 0, hedgeMs: 6000, temperature: 0, responseMimeType: 'application/json' }));
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
export async function generateNoteV2(input, opts = {}) {
  const t0 = Date.now();
  const { specialty = 'general_primary_care', noteType = 'consultation', clinicianId = 'unknown' } = input;
  const persist = opts.persist !== false;
  const onProgress = opts.onProgress || (() => {});
  const log = (l) => console.log(l);
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
  const writerLlm = await createGeminiService(); writerLlm._agent = 'v2-writer';
  const checkLlm = await createGeminiService(); checkLlm._agent = 'v2-checklist';
  const verifyLlm = await createGeminiService();

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
      const writerP = writerLlm.generateContent(WRITER_SYS, `TRANSCRIPT (sole source of truth):\n"""\n${transcript}\n"""\n\nWrite the SOAP note. Return ONLY JSON.`, WRITER_SCHEMA, {
        maxOutputTokens: Number(process.env.V2_WRITER_MAX_TOKENS) || 6000, timeoutMs: Number(process.env.V2_WRITER_TIMEOUT_MS) || 50000,
        retries: 1, hedgeMs: Number(process.env.V2_WRITER_HEDGE_MS) || 25000, temperature: 0, thinkingBudget: 0 });
      const checkP = checkLlm.generateContent(CHECK_SYS, `TRANSCRIPT:\n"""\n${transcript}\n"""\n\nReturn ONLY the JSON.`, CHECK_SCHEMA, {
        maxOutputTokens: 1500, timeoutMs: 20000, retries: 0, hedgeMs: 7000, temperature: 0, thinkingBudget: 0 })
        .then((r) => parseJson(r)).catch((e) => { log(`[v2:checklist] skipped — ${e.message}`); return null; });
      const [writerRaw, check] = await Promise.all([writerP, checkP]);
      lap('writer+checklist', tw);
      const out = parseJson(writerRaw);
      if (!out) throw new Error('v2 writer returned unparseable JSON');
      note = buildNote(out, { specialty: specialtyResolved, noteType, generatedBy: PIPELINE_VERSION });
      if (!note.assessment_and_plan.length && !Object.values(note.subjective).some(Boolean)) {
        // Same behaviour as v1 for a non-clinical recording (voicemail, hold music): an empty, flagged note.
        log('[v2] writer found no clinical content — emitting an empty flagged note');
        note.metadata.flags = [...(note.metadata.flags || []), { type: 'empty_encounter', field: 'transcript', message: 'No clinical content found in the transcript; empty note produced to avoid fabrication.', severity: 'warning' }];
      }

      // 2) deterministic merge of anything the writer dropped ----------------------
      mergeChecklist(note, check, transcript, log);
      note.metadata.medications_mentioned = [...new Set([...(collectMeds(note)), ...((check?.medications || []).map((m) => m?.name).filter(Boolean))])];

      // 3) deterministic placement fixes, then ONE verifier call ---------------------
      try { note = reconcileNote(note); } catch (e) { log(`[v2] reconcile skipped: ${e.message}`); }
      if (process.env.V2_VERIFIER !== '0') {
        const tv = Date.now();
        const v = await verifyNote(verifyLlm, note, transcript, log);
        lap('verifier', tv);
        if (v.dropped) log(`[v2:verify] removed ${v.dropped} line(s)`);
      }
    }
  } catch (e) {
    if (persist) { try { await store.updateConsult(consultId, { status: 'error' }); } catch { /* */ } }
    throw e;
  }
  note.specialty = specialtyResolved; note.metadata.encounter_id = consultId;

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
