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

  // 5d. UPGRADE GUARDRAILS (deterministic, source-grounded) — section-router (medication
  //     dosing → Plan), temporal-validator (no future results in Objective), value-flagger.
  //     Every action prints an [upgrade:*] line so it's visible in the run logs.
  try {
    const up = applyUpgradeGuardrails(note, { transcript, entities });
    if (up.flags?.length) note.metadata.flags = [...(note.metadata.flags || []), ...up.flags];
  } catch (e) { console.warn('[upgrade] guardrails skipped:', e.message); }

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

  // Deterministic Markdown render of the FINAL structured note in the fixed Heidi/gold
  // schema (section headings + bullets + numbered A&P). This is what the UI shows and the
  // eval compares, so the structure is always the schema. Falls back to the pipeline text.
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
