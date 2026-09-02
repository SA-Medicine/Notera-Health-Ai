import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMultipartFile } from '../src/asr/audio.js';
import { localWhisperEnabled } from '../src/asr/localWhisper.js';

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

test('ASR provider switch defaults to rollback Google path unless set', () => {
  const before = process.env.ASR_PROVIDER;
  try {
    delete process.env.ASR_PROVIDER;
    assert.equal(localWhisperEnabled(), false);
    process.env.ASR_PROVIDER = 'whisper_local';
    assert.equal(localWhisperEnabled(), true);
    process.env.ASR_PROVIDER = 'google';
    assert.equal(localWhisperEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.ASR_PROVIDER;
    else process.env.ASR_PROVIDER = before;
  }
});
