import test from 'node:test';
import assert from 'node:assert/strict';
import { silentAudio, transcribeWithChain, defaultSettings } from '../src/asr/engines.js';
const pcm = (n, amp, noise = false) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(noise ? (Math.random() * 2 - 1) * amp : Math.sin(i / 8) * amp), i * 2); return b; };
test('silence and room noise are silent, speech-level audio is not', () => {
  assert.equal(silentAudio(pcm(16000 * 3, 0)), true);
  assert.equal(silentAudio(pcm(16000 * 3, 900, true)), true);
  assert.equal(silentAudio(pcm(16000 * 3, 9000)), false);
  assert.equal(silentAudio(Buffer.alloc(10)), true);
});
test('a silent clip is never sent to a speech engine', async () => {
  let called = 0; const runners = { v2: async () => { called++; return { text: 'invented' }; }, v1: async () => { called++; return { text: 'invented' }; }, gemini: async () => { called++; return { text: 'invented' }; } };
  const r = await transcribeWithChain(pcm(16000 * 2, 300, true), { settings: { ...defaultSettings(), speechCheck: true }, runners });
  assert.equal(r.text, ''); assert.equal(r.silent, true); assert.equal(called, 0);
});
test('a loud clip still goes to the engine', async () => {
  const runners = { v2: async () => ({ text: 'hello there' }), v1: async () => ({ text: 'hello there' }), gemini: async () => ({ text: 'hello there' }) };
  const r = await transcribeWithChain(pcm(16000 * 4, 9000), { settings: { ...defaultSettings(), crossCheck: false }, runners });
  assert.equal(r.text, 'hello there');
});
