// ─────────────────────────────────────────────────────────────────────────────
// Google Speech-to-Text recognition with real long-audio support.
//
// THE LONG-RECORDING BUG THIS FIXES. The API has hard limits that the old code ran
// straight into and reported as "transcription failed":
//   • synchronous recognize accepts at most ~60 SECONDS of audio;
//   • inline audio (sent as base64 `content`) is bounded by the request size limit —
//     about 10 MB, which at 16-bit 16 kHz mono PCM is only ~5 minutes;
//   • longRunningRecognize lifts the duration limit but NOT the inline size limit, so
//     it is no escape hatch for a long recording unless the audio is in GCS.
// So anything past roughly a minute depended on a catch-block guess, and anything past
// a few minutes could not be sent at all.
//
// Now the audio is always decoded to 16 kHz mono PCM first (exact duration known from
// the byte count, no container guessing), then split into windows that fit the sync
// limit and recognised in order. Splits are placed at the quietest point near each
// boundary so a word is rarely cut in half, and the windows do NOT overlap, so no
// phrase is transcribed twice.
//
// Never logs audio bytes or transcript text.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import { medicalPhrases } from './medicalVocab.js';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;          // 16-bit signed little-endian
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

// Sync recognize is documented at 60s; stay under it so a rounding difference in how
// Google measures duration can never tip a window over the edge.
const windowSeconds = () => Math.min(55, num(process.env.ASR_WINDOW_SECONDS, 50));
// How far either side of a boundary to hunt for a quiet split point.
const searchSeconds = () => num(process.env.ASR_SPLIT_SEARCH_SECONDS, 2);
// Parallel recognize calls. Google handles this comfortably and it keeps a long
// recovery pass from taking duration×RTF wall-clock.
const concurrency = () => Math.max(1, Math.min(8, Math.round(num(process.env.ASR_WINDOW_CONCURRENCY, 3))));
const maxRetries = () => Math.max(0, Math.round(num(process.env.ASR_RETRIES, 2)));

const TRANSIENT_RX = /UNAVAILABLE|DEADLINE|deadline|internal|Policy checks|RESOURCE_EXHAUSTED|429|503|504|ECONNRESET|ETIMEDOUT|socket hang up/i;
const TOO_LONG_RX = /too long|sync input|exceeds|1 min|duration|payload|too large|message length/i;

export const pcmDurationSeconds = (bytes) => Math.max(0, bytes) / BYTES_PER_SECOND;

// ── Cost guard, enforced at the billing boundary ─────────────────────────────
// 'medical_conversation' / 'medical_dictation' are premium models (~$0.078/min, roughly
// 5× the standard rate). The callers each had their own check, but this module is what
// actually issues the billed request, so the guard belongs here too: no code path,
// env value or future caller can bill the premium model by mistake.
// 'latest_long' is the cheapest standard model ($0.016/min) and is what production runs.
const PREMIUM_RX = /^medical|premium/i;
export const STANDARD_MODEL = 'latest_long';

export function billableModel(requested, log = () => {}) {
  const m = String(requested || '').trim() || STANDARD_MODEL;
  if (PREMIUM_RX.test(m)) {
    log(`cost guard: '${m}' is a premium model — billing '${STANDARD_MODEL}' instead`);
    return STANDARD_MODEL;
  }
  return m;
}

/** Mean absolute amplitude of a PCM slice — a cheap loudness measure. */
function rms(pcm, start, end) {
  let sum = 0;
  let n = 0;
  for (let i = start; i + 1 < end; i += 2 * 16) {      // sample every 16th frame; plenty
    sum += Math.abs(pcm.readInt16LE(i));
    n += 1;
  }
  return n ? sum / n : 0;
}

/**
 * Split PCM into windows no longer than `windowSeconds`, cutting at the quietest
 * 100 ms inside a search band around each boundary so a split rarely lands mid-word.
 * Windows are contiguous and non-overlapping: every sample appears exactly once, so
 * the stitched transcript neither drops nor repeats speech.
 * @returns {Array<{start:number, end:number}>} byte offsets
 */
export function planWindows(pcm, opts = {}) {
  const winBytes = Math.floor((opts.windowSeconds || windowSeconds()) * BYTES_PER_SECOND / 2) * 2;
  const searchBytes = Math.floor((opts.searchSeconds ?? searchSeconds()) * BYTES_PER_SECOND / 2) * 2;
  const probe = Math.floor(0.1 * BYTES_PER_SECOND / 2) * 2;   // 100 ms
  const out = [];
  let start = 0;
  while (start < pcm.length) {
    let end = start + winBytes;
    if (end >= pcm.length) { out.push({ start, end: pcm.length }); break; }
    // Hunt for the quietest 100 ms window within ±searchBytes of the boundary.
    const lo = Math.max(start + winBytes - searchBytes, start + probe);
    const hi = Math.min(start + winBytes + searchBytes, pcm.length - probe);
    let best = end;
    let bestLevel = Infinity;
    for (let at = lo; at <= hi; at += probe) {
      const level = rms(pcm, at, at + probe);
      if (level < bestLevel) { bestLevel = level; best = at; }
    }
    end = Math.max(start + probe, Math.min(best, pcm.length));
    out.push({ start, end });
    start = end;
  }
  return out;
}

/** Run `tasks` with bounded concurrency, preserving result order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One recognize call with retries on transient failures. The previous code retried only
 * inside longRunningRecognize, so a single transient UNAVAILABLE on the sync path lost
 * that chunk of the consult outright.
 */
async function recognizeOnce(client, config, content, { label, log }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries(); attempt++) {
    try {
      const [response] = await client.recognize({ audio: { content }, config });
      return response;
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT_RX.test(e.message) || attempt === maxRetries()) break;
      const wait = Math.min(500 * 2 ** attempt, 4000) + Math.random() * 200;
      log(`${label} transient (${e.message.slice(0, 120)}) — retry ${attempt + 1}/${maxRetries()} in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const joinResults = (response) => (response?.results || [])
  .map((r) => r.alternatives?.[0]?.transcript || '')
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Transcribe 16 kHz mono PCM of ANY length via Google Speech-to-Text V1.
 *
 * @param {Buffer} pcm        16-bit little-endian mono PCM at 16 kHz
 * @param {object} opts
 *   model      — recognition model (already cost-guarded by the caller)
 *   languageCode
 *   log        — line logger (no transcript content is passed to it)
 * @returns {Promise<{text:string, windows:number, durationSeconds:number, failedWindows:number}>}
 */
export async function transcribePcm(pcm, opts = {}) {
  const log = opts.log || (() => {});
  const durationSeconds = pcmDurationSeconds(pcm.length);
  const speech = (await import('@google-cloud/speech')).default;
  const client = opts.client || new speech.SpeechClient();

  const config = {
    languageCode: opts.languageCode || process.env.ASR_LANGUAGE || 'en-US',
    encoding: 'LINEAR16',
    sampleRateHertz: SAMPLE_RATE,
    audioChannelCount: 1,
    enableAutomaticPunctuation: true,
    ...(opts.configOverrides || {}),
    // Last word on the model, after any overrides — a premium value here would be billed.
    model: billableModel(opts.configOverrides?.model || opts.model, log),
  };

  const windows = planWindows(pcm, opts);
  log(`google-speech: ${durationSeconds.toFixed(1)}s audio → ${windows.length} window(s) of ≤${windowSeconds()}s, model=${config.model}`);

  let failedWindows = 0;
  const parts = await mapLimit(windows, concurrency(), async (w, i) => {
    const slice = pcm.subarray(w.start, w.end);
    const label = `window ${i + 1}/${windows.length}`;
    try {
      const response = await recognizeOnce(client, config, slice.toString('base64'), { label, log });
      return joinResults(response);
    } catch (e) {
      // One window failing must not lose the rest of the consult — that all-or-nothing
      // behaviour is what made a long recording come back empty.
      failedWindows += 1;
      log(`google-speech: ${label} failed (${e.message.slice(0, 160)}) — keeping the other windows`);
      return '';
    }
  });

  const text = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (failedWindows) log(`google-speech: ${failedWindows}/${windows.length} window(s) produced no transcript`);
  if (!text && failedWindows === windows.length) {
    throw new Error(`Google Speech recognition failed for all ${windows.length} window(s)`);
  }
  return { text, windows: windows.length, durationSeconds, failedWindows };
}

// ── overlap-safe windows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A cut between two windows can drop or clip the words that straddle it (and a phrase said during crosstalk right at the cut is easily lost).
// Each window therefore also hears `overlap` seconds of its neighbours, and every word is kept by the window whose own span contains the
// word's START time, so each word is written exactly once and none sits on a cut. Needs word time offsets; without them the overlap is merged by text.
const overlapSeconds = (win) => Math.max(0, Math.min(num(process.env.ASR_OVERLAP_SECONDS, 3), (58 - win) / 2));

/** Widens each window by overlap seconds on both sides (never past the audio) and remembers its own span. */
export function overlapWindows(windows, pcmBytes, overlap) {
  const o = Math.floor(overlap * BYTES_PER_SECOND / 2) * 2;
  if (!o || windows.length < 2) return windows.map((w) => ({ ...w, keepFrom: w.start, keepTo: w.end }));
  return windows.map((w, i) => ({ start: i === 0 ? w.start : Math.max(0, w.start - o), end: i === windows.length - 1 ? w.end : Math.min(pcmBytes, w.end + o), keepFrom: w.start, keepTo: w.end }));
}

/** Duration as a number of seconds: V2 sends { seconds, nanos }, some clients a string like "1.2s". */
export function offsetSeconds(d) {
  if (d == null) return NaN;
  if (typeof d === 'string') return parseFloat(d);
  return Number(d.seconds || 0) + Number(d.nanos || 0) / 1e9;
}

/** The words of one window's results that start inside [keepFrom, keepTo) (absolute seconds). { text, hadWords } */
export function keepWordsByTime(results, { winStartSec, keepFromSec, keepToSec }) {
  const kept = []; let hadWords = false;
  for (const r of results || []) {
    const alt = r?.alternatives?.[0]; const words = alt?.words;
    if (Array.isArray(words) && words.length) {
      hadWords = true;
      for (const w of words) { const t = winStartSec + offsetSeconds(w.startOffset); if (Number.isFinite(t) ? (t >= keepFromSec && t < keepToSec) : true) kept.push(w.word); }
    } else if (alt?.transcript) kept.push(alt.transcript);   // no word times for this result: keep its text whole
  }
  return { text: kept.join(' ').replace(/\s+/g, ' ').trim(), hadWords };
}

/** Joins two neighbouring window texts that heard the same overlap: drops the longest run of words (3 or more) that ends one and starts the other. */
export function mergeOverlapText(prev, cur) {
  const a = String(prev || '').split(/\s+/).filter(Boolean); const b = String(cur || '').split(/\s+/).filter(Boolean);
  const n = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
  const maxK = Math.min(40, a.length, b.length);
  for (let k = maxK; k >= 3; k--) { let ok = true; for (let i = 0; i < k; i++) if (n(a[a.length - k + i]) !== n(b[i])) { ok = false; break; } if (ok) return [...a, ...b.slice(k)].join(' '); }
  return [...a, ...b].join(' ');
}

/**
 * Same windowing, but through Chirp on Speech-to-Text V2. Chirp shares V1's ~60s
 * synchronous limit, so without windowing a long recording would silently fall back to
 * latest_long and lose the accuracy the model was chosen for.
 *
 * @param {Buffer} pcm  16-bit little-endian mono PCM at 16 kHz
 * @param {object} opts  model ('chirp_2'|'chirp'), location, languageCode, log, client
 */
export async function transcribeChirpPcm(pcm, opts = {}) {
  const log = opts.log || (() => {});
  const durationSeconds = pcmDurationSeconds(pcm.length);
  const location = opts.location || process.env.ASR_V2_LOCATION || 'us-central1';
  const hintsOn = opts.hints === undefined ? process.env.ASR_HINTS !== '0' : !!opts.hints;
  const phrases = hintsOn ? (Array.isArray(opts.hints) ? opts.hints : medicalPhrases({ boost: opts.hintBoost || (Number(process.env.ASR_HINT_BOOST) || undefined) })) : [];
  const overlap = opts.overlapSeconds !== undefined ? Math.max(0, opts.overlapSeconds) : overlapSeconds(opts.windowSeconds || windowSeconds());
  let client = opts.client;
  let projectId = opts.projectId;
  if (!client) {
    const { SpeechClient: SpeechClientV2 } = (await import('@google-cloud/speech')).v2;
    client = new SpeechClientV2({ apiEndpoint: `${location}-speech.googleapis.com` });
  }
  projectId = projectId
    || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
    || await client.getProjectId();
  const recognizer = `projects/${projectId}/locations/${location}/recognizers/_`;
  const config = {
    // V2 only knows its own model names; anything else (including a premium V1 model)
    // falls back to chirp_2, which is standard-priced like latest_long.
    model: /^chirp/i.test(String(opts.model || '')) ? opts.model : 'chirp_2',
    languageCodes: [opts.languageCode || process.env.ASR_LANGUAGE || 'en-US'],
    features: { enableAutomaticPunctuation: true, enableWordTimeOffsets: overlap > 0 },
    explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE, audioChannelCount: 1 },
    // medical vocabulary: drug names, Canadian brands and clinical words are boosted so they win over everyday look-alikes (calf / class)
    ...(phrases.length ? { adaptation: { phraseSets: [{ inlinePhraseSet: { phrases } }] } } : {}),
  };

  const base = planWindows(pcm, opts);
  const windows = overlapWindows(base, pcm.length, overlap);
  log(`chirp v2: ${durationSeconds.toFixed(1)}s audio → ${windows.length} window(s), model=${config.model} loc=${location}, hints=${phrases.length}, overlap=${overlap}s`);

  let failedWindows = 0; let needTextMerge = false;
  const parts = await mapLimit(windows, concurrency(), async (w, i) => {
    const label = `chirp window ${i + 1}/${windows.length}`;
    const content = pcm.subarray(w.start, w.end);
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries(); attempt++) {
      try {
        const [r] = await client.recognize({ recognizer, config, content });
        if (overlap > 0) {
          const k = keepWordsByTime(r.results, { winStartSec: w.start / BYTES_PER_SECOND, keepFromSec: i === 0 ? -1 : w.keepFrom / BYTES_PER_SECOND, keepToSec: i === windows.length - 1 ? Infinity : w.keepTo / BYTES_PER_SECOND });
          if (!k.hadWords && (r.results || []).length) needTextMerge = true;   // no word times came back: merge this window's overlap by text instead
          return k.text;
        }
        return (r.results || []).map((x) => x.alternatives?.[0]?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
      } catch (e) {
        lastErr = e;
        if (!TRANSIENT_RX.test(e.message) || attempt === maxRetries()) break;
        log(`${label} transient (${e.message.slice(0, 120)}) — retry ${attempt + 1}/${maxRetries()}`);
        await sleep(Math.min(500 * 2 ** attempt, 4000));
      }
    }
    failedWindows += 1;
    log(`chirp v2: ${label} failed (${lastErr?.message?.slice(0, 160)})`);
    return '';
  });

  const text = (needTextMerge ? parts.filter(Boolean).reduce((acc, p) => (acc ? mergeOverlapText(acc, p) : p), '') : parts.filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
  if (!text && failedWindows === windows.length) {
    throw new Error(`Chirp recognition failed for all ${windows.length} window(s)`);
  }
  return { text, windows: windows.length, durationSeconds, failedWindows };
}

/**
 * Transcribe audio already in Cloud Storage. Uses longRunningRecognize with the GCS
 * URI — the one path where Google itself handles unlimited duration — so a stored
 * consult needs no local download or windowing.
 */
export async function transcribeGcsUri(gcsUri, opts = {}) {
  const log = opts.log || (() => {});
  const speech = (await import('@google-cloud/speech')).default;
  const client = opts.client || new speech.SpeechClient();
  const config = {
    languageCode: opts.languageCode || process.env.ASR_LANGUAGE || 'en-US',
    enableAutomaticPunctuation: true,
    enableWordTimeOffsets: true,
    ...(opts.configOverrides || {}),
    // Last word on the model, after any overrides — see billableModel().
    model: billableModel(opts.configOverrides?.model || opts.model, log),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const [operation] = await client.longRunningRecognize({ audio: { uri: gcsUri }, config });
      const [response] = await operation.promise();
      return response;
    } catch (e) {
      if (attempt >= maxRetries() || !TRANSIENT_RX.test(e.message)) throw e;
      log(`google-speech(gcs): transient (${e.message.slice(0, 120)}) — retry ${attempt + 1}/${maxRetries()}`);
      await sleep(Math.min(800 * 2 ** attempt, 5000));
    }
  }
}

export { TOO_LONG_RX as _TOO_LONG_RX, TRANSIENT_RX as _TRANSIENT_RX, BYTES_PER_SECOND as _BYTES_PER_SECOND };
