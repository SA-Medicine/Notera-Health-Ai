// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Generation orchestrator (the core IP; doc 01 §2)
//
// transcript in → schema-valid, fact-grounded, guardrailed note out, persisted
// with an audit trail, BEFORE any clinician sees it. Stages:
//   1. INGEST   2. NER   3. DE-IDENTIFY   4. GENERATE (ported pipeline / Gemini)
//   5. STRUCTURE → schema v2   6. GUARDRAILS   7. RE-IDENTIFY   8. PERSIST
//
// Full pipeline logs (per-agent passes, timings, coverage, QA) are captured and
// returned when opts.includeLogs is set — used by the frontend Developer panel to
// tune SOAP quality in phase one.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { createGeminiService } from '../services/LLMService.js';
import { PipelineEngine } from '../pipeline/PipelineEngine.js';
import { extractEntities } from '../ner/nerClient.js';
import { deidentify, reidentify, mapFingerprint } from '../deid/deidentify.js';
import { structureNote, storyToSchema } from './structureNote.js';
import { narrateNote } from './heidiNarrative.js';
import { composeStory } from './heidiStoryEngine.js';
import { reconcileNote } from './reconcileNote.js';
import { runGuardrails } from '../validation/guardrails.js';
import { applyUpgradeGuardrails, isBlankEncounter } from '../validation/upgrades.js';
import { noteToMarkdown } from './renderMarkdown.js';
import { condenseNote } from './condenseNote.js';
import { tightenNote } from './tightenNote.js';
import { store, audit } from '../firestore/store.js';

const PIPELINE_VERSION = process.env.PIPELINE_VERSION || 'notera-pipeline-v31';

export async function generateNote(input, opts = {}) {
  const {
    specialty = 'general_primary_care',
    noteType = 'consultation',
    clinicianId = 'unknown',
    templateSystemPrompt = '',
  } = input;
  const onProgress = opts.onProgress || (() => {});
  const persist = opts.persist !== false;
  const skipDeid = opts.skipDeid ?? (process.env.LLM_BACKEND === 'vertex');

  const consultId = input.consultId || `CONS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const llm = await createGeminiService();

  // 1. INGEST ------------------------------------------------------------------
  onProgress({ status: 'transcribing', consultId });
  let transcript = input.transcript || '';
  if (!transcript && input.audioUri) {
    const { transcribeFromGcs, turnsToTranscript } = await import('../asr/transcribe.js');
    const { turns } = await transcribeFromGcs(input.audioUri);
    transcript = turnsToTranscript(turns);
  }
  // De-identification can inject synthetic ISO dates where a spoken NUMBER/relative time was,
  // which the model then extracts as a lab value / lot number. Neutralize them — ONLY on the
  // de-identified eval corpus (NORMALIZE_DEID_DATES=1). Default OFF so PRODUCTION transcripts
  // keep their real, clinically-meaningful dates.
  if (process.env.NORMALIZE_DEID_DATES === '1') {
    const _before = transcript;
    transcript = transcript.replace(/\b(?:19|20)\d{2}-\d{1,2}-\d{1,2}\b/g, '[date]');
    if (transcript !== _before) console.log('[deid-normalize] neutralized synthetic ISO date placeholders in the transcript');
  }
  if (!transcript.trim()) throw new Error('generateNote: no transcript or audioUri provided');

  if (persist) {
    await store.createConsult({ consultId, specialty, noteType, clinicianId, status: 'processing', createdAt: new Date().toISOString(), audioUri: input.audioUri || null });
    await audit({ consultId, actor: clinicianId, action: 'consult.created' });
  }

  // 2. NER (raw transcript, in-house) ------------------------------------------
  onProgress({ status: 'extracting', consultId });
  const entities = await extractEntities(transcript);

  // 3. DE-IDENTIFY (before any AI Studio call) ---------------------------------
  const nameHints = entities.filter((e) => /PERSON|NAME/i.test(e.label || '')).map((e) => e.text);
  const { text: safeTranscript, map: deidMap } = skipDeid
    ? { text: transcript, map: {} }
    : deidentify(transcript, { mode: opts.deidMode || 'redact', nameHints });
  if (persist && !skipDeid && Object.keys(deidMap).length) {
    await store.putDeidMap(consultId, deidMap, mapFingerprint(deidMap));
    await audit({ consultId, actor: 'system', action: 'transcript.deidentified', meta: { fingerprint: mapFingerprint(deidMap), tokens: Object.keys(deidMap).length } });
  }

  // 4. GENERATE (ported multi-agent pipeline; Gemini only) ---------------------
  onProgress({ status: 'drafting', consultId });
  const engine = new PipelineEngine(
    (i, n, msg) => onProgress({ status: 'drafting', step: i, total: n, message: msg, consultId }),
    () => {}
  );
  await engine.init();

  // Optional per-agent LLM I/O recorder (Testing Lab). Wraps generateContent on the
  // pipeline LLM service (and the orchestrator's own llm); PipelineEngine tags each
  // call via llmService._agent so we know which agent made it. Enables agent
  // drilldown + single-agent rerun from stored input.
  const trace = [];
  if (opts.recordTrace) {
    for (const svc of [engine.llmService, llm]) {
      if (!svc || svc.__recorded) continue;
      const origGen = svc.generateContent.bind(svc);
      svc.__recorded = true;
      svc.generateContent = async (sys, prompt, schema, options) => {
        const t = Date.now(); let out = null, error = null;
        try { out = await origGen(sys, prompt, schema, options); return out; }
        catch (e) { error = e; throw e; }
        finally { trace.push({ agent: svc._agent || 'llm', seq: trace.length, systemInstruction: sys, userPrompt: prompt, responseSchema: schema || null, output: out, status: error ? 'error' : 'ok', error: error ? error.message : null, latency_ms: Date.now() - t, model: svc.model || null }); }
      };
    }
  }

  const pipeline = await engine.runPipeline(safeTranscript, templateSystemPrompt, input.referenceNote || '');
  const finalNote = pipeline.finalNote;

  // COMPLETENESS RECOVERY (Fix): the QA validator identifies extracted facts the V31 slot-filler
  // DROPPED from the note (action=retry_slot_filler). Previously this signal was discarded
  // ("retry on next run"). Capture the missing_facts here and feed them to the grounded tightener
  // below so they are re-included — the downstream grounding guardrails strip anything unsupported,
  // so this can only add transcript-grounded content, never fabrication.
  const qaMissingFacts = Array.isArray(pipeline.logs?.qaValidation?.missing_facts)
    ? pipeline.logs.qaValidation.missing_facts.filter((f) => typeof f === 'string' && f.trim())
    : [];
  if (qaMissingFacts.length) console.log(`[completeness] QA flagged ${qaMissingFacts.length} dropped fact(s) — passing to tightener for grounded re-inclusion`);

  // Auto-select specialty from the pipeline's Agent 0 encounter classifier unless
  // the caller pinned one explicitly (doc: specialty should be auto-detected).
  const detected = pipeline.logs?.encounterType || null;
  const specialtyResolved = (!input.specialty || input.specialty === 'auto') ? (detected || specialty) : specialty;

  // 5. STRUCTURE → schema v2 ---------------------------------------------------
  // Prefer the DETERMINISTIC map from the pipeline's own clinical_story (no loss).
  // Fall back to the LLM structurer only if the pipeline produced no story.
  onProgress({ status: 'structuring', consultId });
  const story = pipeline.logs?.clinicalStory;
  const graphForMap = pipeline.logs?.clinicalObservations || {};

  // MEDICATION ROBUSTNESS — the extractor reliably captures the drugs, but the slot-filler/story
  // sometimes drops or generalizes them (Zepbound → "current medication", Tramacet dropped). Build
  // a grounded medication checklist from the fact graph and hand it to the tightener as MUST-INCLUDE.
  // De-identification placeholders (Patient 84, [LOCATION]) are excluded so we never force a masked
  // token into the note. This is grounded (drugs came from the transcript via the extractor).
  const medChecklist = (() => {
    const g = graphForMap || {};
    const out = new Set();
    const add = (v) => { const s = String(v || '').trim(); if (s.length >= 3 && !/^\s*$/.test(s) && !/patient\s*\d+|\[location\]|\[name|\[redacted\]/i.test(s)) out.add(s); };
    for (const m of (g.current_medications || [])) add(m);
    for (const d of (g.medication_decisions || [])) if (d) add(d.medication);
    for (const e of (g.clinical_entities || [])) if (/medication/i.test(e.entity_type || '')) add(e.medication || e.display_text);
    return [...out].slice(0, 30);
  })();
  if (medChecklist.length) console.log(`[medications] ${medChecklist.length} grounded medication(s) from the extractor → tightener must-include: ${medChecklist.join(', ')}`);
  let note;
  if (story && (story.assessment_plan?.length || Object.keys(story.subjective_slots || {}).length || (story.pmh_lines || []).length)) {
    note = storyToSchema(story, graphForMap, { specialty: specialtyResolved, noteType, generatedBy: PIPELINE_VERSION, encounterType: detected, transcript });
  } else {
    note = await structureNote(finalNote, { specialty: specialtyResolved, noteType, llm, generatedBy: PIPELINE_VERSION });
  }
  note.specialty = specialtyResolved;
  note.metadata.encounter_id = consultId;

  // 5a. BLANK-ENCOUNTER GATE (upgrade B) — if the extractor found no clinical facts (or the
  //     transcript is phatic-only), do NOT run the narrative generator, which would otherwise
  //     confabulate a presentation. Emit an empty note instead.
  const blankEncounter = isBlankEncounter({ transcript, graph: graphForMap });
  if (blankEncounter) {
    console.log('[upgrade:blank-encounter] no clinical facts extracted — emitting an empty note, skipping narrative synthesis to prevent hallucination');
    for (const k of Object.keys(note.subjective || {})) note.subjective[k] = '';
    if (note.objective) for (const k of Object.keys(note.objective)) if (typeof note.objective[k] === 'string') note.objective[k] = '';
    note.assessment_and_plan = [];
    note.metadata.flags = [...(note.metadata.flags || []), { type: 'empty_encounter', field: 'transcript', message: 'No clinical facts were extracted from the transcript; an empty note was produced to avoid fabrication.', severity: 'warning' }];
  }

  // 5b. HEIDI STORY ENGINE — read the full transcript and compose the complete Heidi
  //     note (flowing prose, ranked problems, complete titles, problem-grouped objective).
  //     The deterministic note is the grounding scaffold + fallback. If the engine is
  //     unavailable or its guards trip, we keep the scaffold and apply the lighter
  //     narrative polish instead. Skipped entirely when no LLM is available or blank.
  if (!blankEncounter && llm && story) {
    const scaffold = note;
    try {
      const composed = await composeStory(scaffold, { llm, transcript, meta: { specialty: specialtyResolved, noteType, generatedBy: PIPELINE_VERSION } });
      note = (composed && composed !== scaffold) ? composed : await narrateNote(scaffold, { llm, transcript });
      note.specialty = specialtyResolved;
      note.metadata.encounter_id = consultId;
    } catch (e) {
      console.warn('[generateNote] story engine skipped:', e.message);
      try { note = await narrateNote(scaffold, { llm, transcript }); } catch (_) { note = scaffold; }
    }
  }

  // 5c. RECONCILE — deterministic placement & consistency: lab/vital values → Objective,
  //     referrals → A&P, no normal-lab relists in A&P (fixes cross-section contradictions).
  try { note = reconcileNote(note); } catch (e) { console.warn('[generateNote] reconcile skipped:', e.message); }

  // 5c-tighten. Optional LLM "gold tightener" (NOTE_TIGHTENER=1): re-reads the transcript +
  // draft and rewrites gold-style — recovers dropped plan/pharmacy/RTC/normal-lab facts and
  // trims filler, strictly grounded. Time-boxed; falls back to the draft on any issue. The
  // deterministic guardrails below still run on its output (so it can't smuggle in fabrication).
  if (process.env.NOTE_TIGHTENER === '1' && llm) {
    try {
      const _tt = Date.now();
      const budget = Number(process.env.TIGHTENER_TIMEOUT_MS) || 60000;
      note = await Promise.race([
        tightenNote(note, { llm, transcript, missingFacts: qaMissingFacts, medications: medChecklist, log: (l) => console.log(l) }),
        new Promise((resolve) => setTimeout(() => resolve(note), budget)),
      ]);
      note.specialty = specialtyResolved; note.metadata.encounter_id = consultId;
      console.log(`⏱️ [Timing] upgrade:tightener: ${Date.now() - _tt}ms`);
    } catch (e) { console.warn('[upgrade:tightener] skipped:', e.message); }
  }

  // 5d. UPGRADE GUARDRAILS (deterministic, source-grounded) — section-router (medication
  //     dosing → Plan), temporal-validator (no future results in Objective), value-flagger.
  //     Every action prints an [upgrade:*] line so it's visible in the run logs.
  try {
    const up = applyUpgradeGuardrails(note, { transcript, entities });
    if (up.flags?.length) note.metadata.flags = [...(note.metadata.flags || []), ...up.flags];
  } catch (e) { console.warn('[upgrade] guardrails skipped:', e.message); }

  // The note schema only allows flag severities: info | low | warning | critical. Guardrails
  // (and other agents) sometimes emit major/minor/high/medium — coerce every flag severity to
  // the allowed enum so a flagged note never fails schema validation. (This was the root cause
  // of the schema_validity regression: dropped-agenda/generic-med flags used "major"/"minor".)
  {
    const SEV_MAP = { critical: 'critical', warning: 'warning', low: 'low', info: 'info', major: 'warning', high: 'warning', minor: 'low', medium: 'low', error: 'critical', fatal: 'critical' };
    for (const fl of (note.metadata?.flags || [])) {
      if (fl && fl.severity != null) fl.severity = SEV_MAP[String(fl.severity).toLowerCase()] || 'info';
      else if (fl) fl.severity = 'info';
    }
  }

  // 5e. RxNorm verification (upgrade D-Tier2) — opt-in (RXNORM_VERIFY=1), network-optional.
  //     Flags medications that don't resolve to a real RxNorm concept. Never blocks.
  if (process.env.RXNORM_VERIFY === '1') {
    try {
      const { normalizeMedications } = await import('../services/rxnorm.js');
      // ensure any NER drug names are in the list the agent normalizes/checks
      const nerMeds = entities.filter((e) => /DRUG|MEDICATION|CHEMICAL|MED7/i.test(String(e.label || ''))).map((e) => e.text);
      note.metadata.medications_mentioned = [...new Set([...(note.metadata.medications_mentioned || []), ...nerMeds])];
      // Time-boxed so a slow/unreachable RxNav can never stall note generation. Corrects
      // medication spelling to the canonical RxNorm name and flags fabricated drugs.
      const budget = Number(process.env.RXNORM_TIMEOUT_MS) || 8000;
      const rx = await Promise.race([
        normalizeMedications(note, transcript, { log: (l) => console.log(l) }),
        new Promise((resolve) => setTimeout(() => resolve({ flags: [], timedOut: true }), budget)),
      ]);
      if (rx.timedOut) console.warn(`[upgrade:rxnorm] skipped — verification exceeded ${budget}ms (RxNav slow/unreachable)`);
      if (rx.corrected) console.log(`[upgrade:rxnorm] corrected ${rx.corrected} medication name(s) to canonical RxNorm spelling`);
      if (rx.flags?.length) note.metadata.flags = [...(note.metadata.flags || []), ...rx.flags];
    } catch (e) { console.warn('[upgrade:rxnorm] skipped:', e.message); }
  }

  // 6. GUARDRAILS (schema + NER cross-check) -----------------------------------
  const gr = runGuardrails(note, entities, { confidenceThreshold: opts.confidenceThreshold });
  note = gr.note;

  // 7. RE-IDENTIFY (inside our systems, after generation) ----------------------
  if (!skipDeid && Object.keys(deidMap).length) {
    note = reidentify(note, deidMap);
    await audit({ consultId, actor: 'system', action: 'note.reidentified' }).catch(() => {});
  }

  // Agent 1 — cross-section condenser: keep Subjective/Objective detailed, make A&P concise
  // by dropping sentences that just repeat the detail above, and merge duplicate exam lines.
  try { condenseNote(note, {}, (l) => console.log(l)); } catch (e) { console.warn('[upgrade:condense] skipped:', e.message); }

  // FINAL AGENT — Hallucination Remover (DeepSeek). Runs LAST on the assembled note: audits
  // every statement against the transcript and DELETES anything unsupported (invented names,
  // dates, doses, lab values, meds, findings, negations). Remove-only, grounded; records the
  // exact removals in metadata + [hallucination-remover] logs. Gated + timeboxed so it can
  // never block or wipe a note. Reuses the Second-Opinion engine.
  if (process.env.HALLUCINATION_REMOVER !== '0' && llm) {
    try {
      const { removeHallucinations } = await import('./hallucinationRemover.js');
      const _ht = Date.now();
      // DYNAMIC budget: longer transcripts legitimately need more time; short ones fail fast
      // instead of hanging. Base 20s + 3s per 1000 transcript chars, clamped to [20s, 90s].
      // HALLUCINATION_TIMEOUT_MS (if set) acts as a hard CEILING, not a fixed wait.
      const dyn = Math.min(90000, Math.max(20000, 20000 + Math.round((transcript.length || 0) / 1000) * 3000));
      const cap = Number(process.env.HALLUCINATION_TIMEOUT_MS) || 0;
      const budget = cap > 0 ? Math.min(cap, dyn) : dyn;
      // IMPORTANT: clear the timer as soon as the work resolves. Previously the setTimeout was
      // never cancelled, so a 45s timer kept firing LATER — printing "skipped — exceeded 45000ms"
      // into unrelated fixtures' logs even though this pass had already finished in ~1s.
      let timer = null;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => { console.warn(`[hallucination-remover] skipped — exceeded ${budget}ms (LLM slow); note kept as-is`); resolve('__timeout__'); }, budget); });
      try {
        const res = await Promise.race([
          removeHallucinations(note, { transcript, llm, log: (l) => console.log(l) }),   // main-pipeline LLM (Gemini)
          timeout,
        ]);
        console.log(`⏱️ [Timing] hallucination-remover: ${Date.now() - _ht}ms${res === '__timeout__' ? ' (timed out)' : ''}`);
      } finally { if (timer) clearTimeout(timer); }
    } catch (e) { console.warn('[hallucination-remover] skipped:', e.message); }
  }

  // Deterministic Markdown render of the FINAL structured note in the fixed Heidi/gold
  // schema (section headings + one bullet per sentence + numbered A&P). This is what the UI
  // shows and the eval compares, so the structure is always the schema + points. Falls back
  // to the pipeline text if empty.
  const renderedNote = noteToMarkdown(note) || finalNote;

  // 8. PERSIST draft + audit ---------------------------------------------------
  const draftId = `DRAFT-${Date.now()}`;
  if (persist) {
    await store.updateConsult(consultId, { status: 'ready', specialty: specialtyResolved, transcript: { text: transcript }, entities });
    await store.addDraft(consultId, {
      draftId, modelVersion: PIPELINE_VERSION, schemaVersion: note.schema_version,
      note, renderedNote, rawRenderedNote: finalNote, confidence: note.metadata.confidence || {},
      status: gr.status, createdAt: new Date().toISOString(),
    });
    await audit({ consultId, actor: 'system', action: 'draft.created', target: draftId, meta: { status: gr.status, flags: gr.flags.length } });
  }

  onProgress({ status: 'ready', consultId, draftId });
  return {
    consultId, draftId, note, renderedNote, rawRenderedNote: finalNote,
    status: gr.status, flags: gr.flags, schemaErrors: gr.schemaErrors, entities, detectedSpecialty: detected,
    qa: pipeline.logs?.qaValidation || null,   // QA agent output incl. _metrics (for eval metrics chart)
    trace: opts.recordTrace ? trace : undefined,   // per-agent LLM I/O (Testing Lab)
    // Full pipeline logs for the Developer panel (only when requested).
    logs: opts.includeLogs ? {
      textLogs: pipeline.textLogs || [],
      timings: pipeline.logs?.timings || {},
      stages: summarizeStages(pipeline),
    } : undefined,
  };
}

// Compact per-stage summary from the structured pipeline logs (for a quick view).
function summarizeStages(pipeline) {
  const L = pipeline.logs || {};
  return {
    encounterType: L.encounterType || null,
    entityCount: L.clinicalObservations?.clinical_entities?.length || 0,
    activeProblems: (L.activeProblems || []).length,
    storyCoverage: L.storyCoverage?.coverage_percent ?? null,
    jsValidation: L.jsValidation?.status || null,
    qaValidation: L.qaValidation?.status || null,
    fhirGenerated: !!L.fhirBundle,
  };
}

/** Clinician sign-off → writes finals + captures the draft→final diff as feedback. */
export async function approveNote({ consultId, draftId, finalNote, clinicianId }) {
  const finalId = `FINAL-${Date.now()}`;
  const gr = runGuardrails(finalNote, [], {});
  await store.addFinal(consultId, { finalId, note: finalNote, approvedBy: clinicianId, approvedAt: new Date().toISOString(), status: gr.status });
  await store.addFeedback(consultId, { feedbackId: `FB-${Date.now()}`, draftId, finalId, clinicianId, createdAt: new Date().toISOString() });
  await store.updateConsult(consultId, { status: 'signed' });
  await audit({ consultId, actor: clinicianId, action: 'note.approved', target: finalId });
  return { finalId, status: gr.status };
}
