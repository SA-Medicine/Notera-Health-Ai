// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Medical ASR (Google Speech-to-Text, doc 08)
//
// Batch transcription of consult audio into speaker-diarized turns. Uses the
// medical/enhanced model + diarization so drug names and clinician/patient turns
// come through correctly. Kept behind an abstract interface (doc 01 §4) so the
// vendor (Amazon Transcribe Medical, AssemblyAI, Corti) can be swapped.
//
// The @google-cloud/speech dependency is imported lazily so local/dev runs and
// tests that only exercise the text path don't need GCP credentials.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

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

/**
 * Transcribe a consult recording stored in GCS.
 * @param {string} gcsUri  e.g. gs://bucket/consult123.wav
 * @param {object} overrides  partial recognition config
 * @returns {Promise<{ turns: Array<{speaker:number|null,text:string}>, raw:any }>}
 */
export async function transcribeFromGcs(gcsUri, overrides = {}) {
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
