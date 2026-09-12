// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Medical ASR
//
// Batch transcription of consult audio into diarized turns via Google Speech-to-Text.
// Audio already in Cloud Storage goes through longRunningRecognize with the gs:// URI,
// which is the one path where Google itself handles unlimited duration — no download,
// no windowing, no 60-second synchronous limit.
//
// The @google-cloud/speech dependency is imported lazily (inside googleSpeech.js) so
// local/dev runs and tests that only exercise the text path don't need GCP credentials.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { billableModel, transcribeGcsUri } from './googleSpeech.js';

const DEFAULT_CONFIG = {
  languageCode: process.env.ASR_LANGUAGE || 'en-US',
  // Cost guard: a premium model is forced down to the cheapest standard one. Enforced
  // again inside googleSpeech.js at the point the request is issued.
  model: billableModel(process.env.ASR_MODEL),
  enableAutomaticPunctuation: true,
  enableWordTimeOffsets: true,
  diarizationConfig: {
    enableSpeakerDiarization: true,
    minSpeakerCount: 2,
    maxSpeakerCount: 2,
  },
};

/**
 * Transcribe a consult recording stored in GCS.
 * @param {string} gcsUri  e.g. gs://bucket/consult123.wav
 * @param {object} overrides  partial recognition config
 * @returns {Promise<{ turns: Array<{speaker:number|null,text:string}>, raw:any }>}
 */
export async function transcribeFromGcs(gcsUri, overrides = {}) {
  if (!/^gs:\/\/[^/]+\/.+$/i.test(gcsUri || '')) throw new Error('transcribeFromGcs: expected gs:// audio URI');
  const { requestId, log, ...configOverrides } = overrides;
  const response = await transcribeGcsUri(gcsUri, {
    configOverrides: { ...DEFAULT_CONFIG, ...configOverrides },
    log: log || ((l) => console.log(`[asr] ${l}`)),
  });

  const turns = (response.results || []).map((r) => ({
    speaker: r.alternatives?.[0]?.words?.[0]?.speakerTag ?? null,
    text: r.alternatives?.[0]?.transcript ?? '',
  }));
  return { turns, raw: response.results };
}

/** Collapse diarized turns into a single speaker-tagged transcript string. */
export function turnsToTranscript(turns = []) {
  return turns
    .filter((t) => t.text && t.text.trim())
    .map((t) => (t.speaker != null ? `Speaker ${t.speaker}: ${t.text.trim()}` : t.text.trim()))
    .join('\n');
}
