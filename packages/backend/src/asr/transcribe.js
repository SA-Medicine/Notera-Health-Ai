// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Medical ASR
//
// Batch transcription of consult audio into turns. ASR_PROVIDER=whisper_local
// uses self-hosted faster-whisper large-v3-turbo. ASR_PROVIDER=google preserves
// the previous Google Speech-to-Text path as a rollback option.
//
// The @google-cloud/speech dependency is imported lazily so local/dev runs and
// tests that only exercise the text path don't need GCP credentials.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupTempDir, normalizeFileToWav16k } from './audio.js';
import { localWhisperEnabled, transcribeLocalAudioFile } from './localWhisper.js';

const DEFAULT_CONFIG = {
  encoding: process.env.ASR_ENCODING || 'LINEAR16',
  sampleRateHertz: Number(process.env.ASR_SAMPLE_RATE || 16000),
  languageCode: process.env.ASR_LANGUAGE || 'en-US',
  model: process.env.ASR_MODEL || 'medical_conversation', // domain model (doc 08 §3)
  useEnhanced: true,
  enableAutomaticPunctuation: true,
  enableWordTimeOffsets: true,
  diarizationConfig: {
    enableSpeakerDiarization: true,
    minSpeakerCount: 2,
    maxSpeakerCount: 2,
  },
};

const BUCKET = () => process.env.GCS_AUDIO_BUCKET || '';

async function downloadGcsUri(gcsUri) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/i.exec(gcsUri || '');
  if (!m) throw new Error('transcribeFromGcs: expected gs:// audio URI');
  const { Storage } = await import('@google-cloud/storage');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notera-asr-gcs-'));
  try { await fs.chmod(dir, 0o700); } catch { /* Windows or restricted FS */ }
  const srcPath = path.join(dir, 'source-audio');
  await new Storage().bucket(m[1] || BUCKET()).file(m[2]).download({ destination: srcPath });
  return { tmpDir: dir, path: srcPath };
}

/**
 * Transcribe a consult recording stored in GCS.
 * @param {string} gcsUri  e.g. gs://bucket/consult123.wav
 * @param {object} overrides  partial recognition config
 * @returns {Promise<{ turns: Array<{speaker:number|null,text:string}>, raw:any }>}
 */
export async function transcribeFromGcs(gcsUri, overrides = {}) {
  if (localWhisperEnabled()) {
    let downloaded = null;
    let normalized = null;
    try {
      downloaded = await downloadGcsUri(gcsUri);
      normalized = await normalizeFileToWav16k(downloaded.path);
      const r = await transcribeLocalAudioFile(normalized.wavPath, { requestId: overrides.requestId });
      const turns = (r.segments || []).map((s) => ({ speaker: null, text: s.text || '' }));
      return { turns, raw: { provider: 'whisper_local', segments: r.segments || [], language: r.language || null } };
    } finally {
      await cleanupTempDir(normalized?.tmpDir);
      await cleanupTempDir(downloaded?.tmpDir);
    }
  }

  const speech = (await import('@google-cloud/speech')).default;
  const client = new speech.SpeechClient();

  const [operation] = await client.longRunningRecognize({
    audio: { uri: gcsUri },
    config: { ...DEFAULT_CONFIG, ...overrides },
  });
  const [response] = await operation.promise();

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
