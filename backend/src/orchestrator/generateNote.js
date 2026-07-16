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

  // 5b. HEIDI STORY ENGINE — read the full transcript and compose the complete Heidi
  //     note (flowing prose, ranked problems, complete titles, problem-grouped objective).
  //     The deterministic note is the grounding scaffold + fallback. If the engine is
  //     unavailable or its guards trip, we keep the scaffold and apply the lighter
  //     narrative polish instead. Skipped entirely when no LLM is available.
  if (llm && story) {
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

  // 6. GUARDRAILS (schema + NER cross-check) -----------------------------------
  const gr = runGuardrails(note, entities, { confidenceThreshold: opts.confidenceThreshold });
  note = gr.note;

  // 7. RE-IDENTIFY (inside our systems, after generation) ----------------------
  if (!skipDeid && Object.keys(deidMap).length) {
    note = reidentify(note, deidMap);
    await audit({ consultId, actor: 'system', action: 'note.reidentified' }).catch(() => {});
  }

  // 8. PERSIST draft + audit ---------------------------------------------------
  const draftId = `DRAFT-${Date.now()}`;
  if (persist) {
    await store.updateConsult(consultId, { status: 'ready', specialty: specialtyResolved, transcript: { text: transcript }, entities });
    await store.addDraft(consultId, {
      draftId, modelVersion: PIPELINE_VERSION, schemaVersion: note.schema_version,
      note, renderedNote: finalNote, confidence: note.metadata.confidence || {},
      status: gr.status, createdAt: new Date().toISOString(),
    });
    await audit({ consultId, actor: 'system', action: 'draft.created', target: draftId, meta: { status: gr.status, flags: gr.flags.length } });
  }

  onProgress({ status: 'ready', consultId, draftId });
  return {
    consultId, draftId, note, renderedNote: finalNote,
    status: gr.status, flags: gr.flags, schemaErrors: gr.schemaErrors, entities, detectedSpecialty: detected,
    qa: pipeline.logs?.qaValidation || null,   // QA agent output incl. _metrics (for eval metrics chart)
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
