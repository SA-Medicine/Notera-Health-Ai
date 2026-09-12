import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMultipartFile } from '../src/asr/audio.js';
import { planWindows, pcmDurationSeconds, transcribePcm, _BYTES_PER_SECOND } from '../src/asr/googleSpeech.js';

test('extractMultipartFile preserves the uploaded audio bytes', () => {
  const boundary = 'notera-boundary';
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const out = extractMultipartFile(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(out, audio);
});

// Build PCM of a given length. `quietAt` marks seconds that are near-silence, so the
// split planner has an obvious place to cut.
function pcm(seconds, quietAt = []) {
  const buf = Buffer.alloc(Math.round(seconds * _BYTES_PER_SECOND));
  const quiet = new Set(quietAt);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sec = Math.floor(i / _BYTES_PER_SECOND);
    buf.writeInt16LE(quiet.has(sec) ? 0 : 8000, i);
  }
  return buf;
}

test('duration comes from the PCM byte count, not a container header', () => {
  assert.equal(pcmDurationSeconds(_BYTES_PER_SECOND * 20), 20);
  assert.equal(pcmDurationSeconds(0), 0);
});

test('audio inside the synchronous limit stays a single window', () => {
  const windows = planWindows(pcm(30), { windowSeconds: 50 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, 0);
});

test('long audio is split into windows that all fit the synchronous limit', () => {
  // 7 minutes — far past the ~60s sync cap AND past the ~10MB inline limit, the two
  // ceilings that previously made a long recording impossible to transcribe.
  const buf = pcm(7 * 60);
  const windows = planWindows(buf, { windowSeconds: 50, searchSeconds: 2 });
  assert.ok(windows.length >= 8, `expected several windows, got ${windows.length}`);
  for (const w of windows) {
    const secs = (w.end - w.start) / _BYTES_PER_SECOND;
    assert.ok(secs <= 55, `window of ${secs}s exceeds the synchronous limit`);
    assert.ok(secs > 0);
  }
});

test('windows are contiguous and non-overlapping so nothing is lost or doubled', () => {
  const buf = pcm(5 * 60);
  const windows = planWindows(buf, { windowSeconds: 50, searchSeconds: 2 });
  assert.equal(windows[0].start, 0);
  assert.equal(windows[windows.length - 1].end, buf.length);
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].start, windows[i - 1].end, 'a gap or overlap between windows');
  }
});

test('a split lands on the quiet stretch rather than mid-speech', () => {
  // Silence at 49-51s; the boundary search should pick a cut inside it.
  const buf = pcm(120, [49, 50, 51]);
  const windows = planWindows(buf, { windowSeconds: 50, searchSeconds: 2 });
  const cutSecond = windows[0].end / _BYTES_PER_SECOND;
  assert.ok(cutSecond >= 48 && cutSecond <= 52, `cut at ${cutSecond}s missed the quiet stretch`);
});

// Audio whose samples encode their own position, so a window can be identified from its
// bytes. Without this the fake client could only label by call order, which says nothing
// about window order once the windows are recognised concurrently.
function labelledPcm(seconds) {
  const buf = Buffer.alloc(Math.round(seconds * _BYTES_PER_SECOND));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    buf.writeInt16LE(Math.floor(i / _BYTES_PER_SECOND) + 1, i);
  }
  return buf;
}

// A fake SpeechClient so the recognition path is testable without GCP credentials.
// `failAtSecond` fails the window that STARTS at that second, whichever call it is.
function fakeClient({ failAtSecond = null, error = '7 PERMISSION_DENIED: nope' } = {}) {
  const calls = [];
  return {
    calls,
    async recognize({ config, audio }) {
      const bytes = Buffer.from(audio.content, 'base64');
      const startSecond = bytes.readInt16LE(0) - 1;
      calls.push({ config, bytes: bytes.length, startSecond });
      if (failAtSecond != null && startSecond === failAtSecond) throw new Error(error);
      return [{ results: [{ alternatives: [{ transcript: `seg${startSecond}` }] }] }];
    },
  };
}

test('a long recording is transcribed window by window and stitched in order', async () => {
  const client = fakeClient();
  const r = await transcribePcm(labelledPcm(3 * 60), { client, windowSeconds: 50, model: 'latest_long' });
  assert.ok(r.windows >= 3);
  assert.equal(r.failedWindows, 0);
  assert.equal(client.calls.length, r.windows);
  // Window order must follow the audio, not the order the concurrent calls happened to
  // finish in — out-of-order stitching would hand the note generator a scrambled story.
  const expected = client.calls.map((c) => c.startSecond).sort((a, b) => a - b).map((s) => `seg${s}`).join(' ');
  assert.equal(r.text, expected);
  for (const c of client.calls) {
    assert.equal(c.config.encoding, 'LINEAR16');
    assert.equal(c.config.sampleRateHertz, 16000);
    assert.equal(c.config.model, 'latest_long');
  }
});

test('one failing window does not lose the rest of the consult', async () => {
  const client = fakeClient({ failAtSecond: 0 });
  const r = await transcribePcm(labelledPcm(3 * 60), { client, windowSeconds: 50 });
  assert.equal(r.failedWindows, 1);
  assert.ok(!r.text.includes('seg0 '), 'the failed window must not appear');
  assert.ok(r.text.length > 0, 'the surviving windows must still be returned');
  assert.ok(r.text.split(' ').length >= r.windows - 1);
});

test('a transient failure is retried rather than dropped', async () => {
  let attempts = 0;
  const client = {
    async recognize() {
      attempts += 1;
      if (attempts < 2) throw new Error('14 UNAVAILABLE: Policy checks are unavailable');
      return [{ results: [{ alternatives: [{ transcript: 'recovered' }] }] }];
    },
  };
  const r = await transcribePcm(pcm(20), { client });
  assert.equal(r.text, 'recovered');
  assert.equal(attempts, 2);
});

test('every window failing surfaces as an error, not a silently empty transcript', async () => {
  const client = { async recognize() { throw new Error('permission denied'); } };
  await assert.rejects(() => transcribePcm(pcm(20), { client }), /failed for all/i);
});

test('Chirp is windowed too, so a long recording keeps the configured model', async () => {
  const { transcribeChirpPcm } = await import('../src/asr/googleSpeech.js');
  const seen = [];
  const client = {
    async getProjectId() { return 'proj'; },
    async recognize({ recognizer, config, content }) {
      seen.push({ recognizer, model: config.model, seconds: content.length / _BYTES_PER_SECOND });
      return [{ results: [{ alternatives: [{ transcript: `c${content.readInt16LE(0) - 1}` }] }] }];
    },
  };
  const r = await transcribeChirpPcm(labelledPcm(4 * 60), { client, projectId: 'proj', model: 'chirp_2', windowSeconds: 50 });
  assert.ok(r.windows >= 4);
  assert.equal(r.failedWindows, 0);
  for (const c of seen) {
    assert.equal(c.model, 'chirp_2', 'a long recording must not silently drop to another model');
    assert.ok(c.seconds <= 55, `window of ${c.seconds}s exceeds the synchronous limit`);
    assert.match(c.recognizer, /^projects\/proj\/locations\/.+\/recognizers\/_$/);
  }
});

// ── Cost guard ───────────────────────────────────────────────────────────────
// Production runs the CHEAPEST standard model. The premium medical models are ~5x the
// rate, so the guard lives at the billing boundary and no caller, env value or config
// override can get past it.
test('billableModel forces every premium model down to the cheapest standard one', async () => {
  const { billableModel, STANDARD_MODEL } = await import('../src/asr/googleSpeech.js');
  assert.equal(STANDARD_MODEL, 'latest_long');
  for (const premium of ['medical_conversation', 'medical_dictation', 'MEDICAL_CONVERSATION', 'premium_model']) {
    assert.equal(billableModel(premium), 'latest_long', `${premium} must never be billed`);
  }
  // Standard models pass through untouched, and an empty value defaults to the cheap one.
  assert.equal(billableModel('latest_long'), 'latest_long');
  assert.equal(billableModel('latest_short'), 'latest_short');
  assert.equal(billableModel('default'), 'default');
  assert.equal(billableModel(''), 'latest_long');
  assert.equal(billableModel(undefined), 'latest_long');
});

test('the premium model cannot be billed even via an explicit config override', async () => {
  const seen = [];
  const client = {
    async recognize({ config }) {
      seen.push(config.model);
      return [{ results: [{ alternatives: [{ transcript: 'x' }] }] }];
    },
  };
  // Both the normal option and a raw config override attempt the premium model.
  await transcribePcm(pcm(20), { client, model: 'medical_conversation' });
  await transcribePcm(pcm(20), { client, configOverrides: { model: 'medical_conversation' } });
  assert.deepEqual(seen, ['latest_long', 'latest_long']);
});

test('the GCS path also refuses to bill a premium model', async () => {
  const { transcribeGcsUri } = await import('../src/asr/googleSpeech.js');
  let used = null;
  const client = {
    async longRunningRecognize({ config }) {
      used = config.model;
      return [{ promise: async () => [{ results: [] }] }];
    },
  };
  await transcribeGcsUri('gs://bucket/a.wav', { client, configOverrides: { model: 'medical_conversation' } });
  assert.equal(used, 'latest_long');
});
