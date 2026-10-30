import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, implausible, defaultSettings, validateSettings, transcribeWithChain, speechLike, resetHealth, healthSnapshot, breakerOpen } from '../src/asr/engines.js';

const pcm = (seconds, amp) => { const b = Buffer.alloc(seconds * 32000); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp), i); return b; };
const SPEECH = pcm(20, 4000), SILENCE = pcm(20, 20);
const ok = (text) => async () => ({ text, windows: 1, durationSeconds: 20, failedWindows: 0 });
const boom = (msg = 'UNAVAILABLE') => async () => { throw new Error(msg); };
const S = (o = {}) => validateSettings({ primary: 'chirp_2', fallbacks: ['latest_long'], ...o });
const runners = (m) => ({ v2: m.v2 || ok('v2 text'), v1: m.v1 || ok('v1 text'), gemini: m.gemini || ok('gemini text') });

test('the default chain: ASR_MODEL first, then Gemini 2.5 Flash, then the cheapest Google model', () => {
  assert.deepEqual(defaultSettings({ ASR_MODEL: 'chirp_2' }), { primary: 'chirp_2', fallbacks: ['gemini-2.5-flash', 'latest_long'], timeoutMs: 60000, breakerFailures: 3, breakerCooldownMs: 300000, speechCheck: true, crossCheck: true, crossCheckTimeoutMs: 45000 });
  assert.deepEqual(defaultSettings({ ASR_MODEL: 'gemini-2.5-flash' }).fallbacks, ['latest_long']);
  assert.deepEqual(defaultSettings({ ASR_MODEL: 'latest_long' }).fallbacks, []); assert.equal(defaultSettings({}).primary, 'latest_long'); assert.equal(defaultSettings({ ASR_MODEL: 'medical_conversation' }).primary, 'latest_long', 'a premium or unknown name never becomes the primary');
});
test('settings are validated', () => {
  assert.throws(() => validateSettings({ primary: 'whisper' }), /unknown engine/); assert.throws(() => validateSettings({ primary: 'chirp_2', fallbacks: ['x'] }), /unknown engine/);
  assert.throws(() => validateSettings({ primary: 'chirp_2', fallbacks: ['chirp_3', 'latest_long', 'gemini-2.5-flash', 'gemini-3.7-flash'] }), /at most three/); assert.throws(() => validateSettings({ timeoutMs: 10 }), /timeoutMs/);
  assert.deepEqual(validateSettings({ primary: 'chirp_3', fallbacks: ['chirp_3', 'chirp_2', 'chirp_2'] }).fallbacks, ['chirp_2'], 'primary and duplicates are removed from the fallbacks');
  assert.ok(Object.keys(ENGINES).includes('chirp_3') && Object.keys(ENGINES).includes('latest_long'));
});
test('speech detection separates speech from silence and from too-short clips', () => { assert.equal(speechLike(SPEECH), true); assert.equal(speechLike(SILENCE), false); assert.equal(speechLike(pcm(1, 4000)), false); });
test('the primary serves the request when it works', async () => {
  resetHealth(); const r = await transcribeWithChain(SPEECH, { settings: S(), runners: runners({}) });
  assert.equal(r.engine, 'chirp_2'); assert.equal(r.fellBack, false); assert.equal(r.text, 'v2 text'); assert.deepEqual(r.tried.map((t) => t.engine), ['chirp_2']);
});
test('an error falls back to the next engine, and the health counters show it', async () => {
  resetHealth(); const r = await transcribeWithChain(SPEECH, { settings: S(), runners: runners({ v2: boom('UNAVAILABLE: 503') }) });
  assert.equal(r.engine, 'latest_long'); assert.equal(r.fellBack, true); assert.equal(r.text, 'v1 text'); const h = healthSnapshot(); assert.equal(h.chirp_2.fail, 1); assert.equal(h.latest_long.fallbackServed, 1);
});
test('a timeout counts as a failure', async () => {
  resetHealth(); const slow = async () => new Promise((r) => setTimeout(() => r({ text: 'late' }), 300));
  const r = await transcribeWithChain(SPEECH, { settings: S({ timeoutMs: 5000 }), runners: runners({ v2: slow }), now: Date.now }); assert.equal(r.engine, 'chirp_2');   // 300 ms < 5 s: served
  const r2 = await transcribeWithChain(SPEECH, { settings: { ...S(), timeoutMs: 100 }, runners: runners({ v2: slow }) }); assert.equal(r2.engine, 'latest_long'); assert.match(r2.tried[0].error, /timed out/);
});
test('a silent failure (speech in, nothing out) falls back; real silence is accepted as empty', async () => {
  resetHealth(); const r = await transcribeWithChain(SPEECH, { settings: S(), runners: runners({ v2: ok('') }) }); assert.equal(r.engine, 'latest_long'); assert.equal(r.tried[0].empty, true);
  const q = await transcribeWithChain(SILENCE, { settings: S(), runners: runners({ v2: ok(''), v1: ok('') }) }); assert.equal(q.text, ''); assert.equal(q.tried.length, 0, 'silence is not sent to any engine'); assert.equal(q.silent, true);
  const both = await transcribeWithChain(SPEECH, { settings: S(), runners: runners({ v2: ok(''), v1: ok('') }) }); assert.equal(both.text, '', 'when every engine agrees there is nothing, the empty answer stands');
});
test('the circuit breaker skips a failing engine until the cooldown ends', async () => {
  resetHealth(); let t = 1_000_000; const now = () => t; const st = S({ breakerFailures: 2, breakerCooldownMs: 60000 }); let calls = 0; const flaky = async () => { calls++; throw new Error('boom'); };
  await transcribeWithChain(SPEECH, { settings: st, runners: runners({ v2: flaky }), now }); await transcribeWithChain(SPEECH, { settings: st, runners: runners({ v2: flaky }), now });
  assert.equal(breakerOpen('chirp_2', t), true); const before = calls; const r = await transcribeWithChain(SPEECH, { settings: st, runners: runners({ v2: flaky }), now }); assert.equal(calls, before, 'the open breaker is not called'); assert.equal(r.engine, 'latest_long');
  t += 61000; await transcribeWithChain(SPEECH, { settings: st, runners: runners({ v2: ok('recovered') }), now }); assert.equal(breakerOpen('chirp_2', t), false);
});
test('when every engine fails the last error is raised; when all breakers are open the primary is still tried', async () => {
  resetHealth(); await assert.rejects(() => transcribeWithChain(SPEECH, { settings: S(), runners: runners({ v2: boom('a'), v1: boom('b') }) }), /b/);
  const st = S({ breakerFailures: 1 }); for (let i = 0; i < 2; i++) await transcribeWithChain(SPEECH, { settings: st, runners: runners({ v2: boom('x'), v1: boom('y') }) }).catch(() => {});
  const r = await transcribeWithChain(SPEECH, { settings: st, runners: runners({ v2: ok('alive') }) }); assert.equal(r.engine, 'chirp_2');
});
test('the owner can switch the primary and chain: chirp_3 first, gemini, then the cheap one', async () => {
  resetHealth(); const st = validateSettings({ primary: 'chirp_3', fallbacks: ['gemini-2.5-flash', 'latest_long'] });
  const r = await transcribeWithChain(SPEECH, { settings: st, runners: runners({ v2: boom('x') }) }); assert.equal(r.engine, 'gemini-2.5-flash'); assert.deepEqual(r.tried.map((t) => t.engine), ['chirp_3', 'gemini-2.5-flash']);
});

test('impossible output is rejected: a repetition loop or a speech rate no human reaches', async () => {
  const loop = 'thank you very much doctor '.repeat(60); assert.match(implausible(loop, 600), /repeated/);
  const fast = Array.from({ length: 3000 }, (_, i) => 'w' + (i % 900)).join(' '); assert.match(implausible(fast, 60), /words a minute/);
  const normal = Array.from({ length: 1500 }, (_, i) => 'word' + i).join(' '); assert.equal(implausible(normal, 600), '', 'a normal 150 words a minute passes'); assert.equal(implausible('short text', 5), '');
  resetHealth(); const r = await transcribeWithChain(pcm(20, 4000), { settings: S(), runners: runners({ v2: ok(loop) }) });   // 20 s of audio with a 360-word reply
  assert.equal(r.engine, 'latest_long', 'the loop is treated as a failure and the next engine answers'); assert.match(r.tried[0].error, /implausible/);
});

import { rerunSettings } from '../src/asr/engines.js';
test('the re-transcribe pass uses Gemini 2.5 Flash first, Chirp 2 only as its fallback, and fits the proxy time limit', () => {
  const r = rerunSettings(defaultSettings({ ASR_MODEL: 'chirp_2' })); assert.equal(r.primary, 'gemini-2.5-flash'); assert.deepEqual(r.fallbacks, ['chirp_2']); assert.ok(r.timeoutMs <= 90000); assert.equal(r.speechCheck, true);
  const g = rerunSettings(validateSettings({ primary: 'chirp_3', fallbacks: ['latest_long'] })); assert.equal(g.primary, 'gemini-2.5-flash', 'whatever the owner chose as primary, the re-run is always Gemini');
});

test('cross-check: a medical word and a missing sentence from the second engine are used; the primary is kept when the second fails or is off', async () => {
  resetHealth();
  const chirp = ok('If you have class tenderness that is the bad sign. Why do you not continue and if still concerned come see me');
  const gem = ok('If you have calf tenderness that is the bad sign. Why do you not continue and any signs of concern that I should be watching for and if still concerned come see me');
  const on = await transcribeWithChain(SPEECH, { settings: S({ crossCheck: true }), runners: runners({ v2: chirp, gemini: gem }) });
  assert.match(on.text, /calf tenderness/); assert.match(on.text, /signs of concern that I should be watching for/);
  assert.equal(on.consensus.swaps, 1); assert.equal(on.consensus.fills, 1); assert.equal(on.engine, 'chirp_2');
  const off = await transcribeWithChain(SPEECH, { settings: S({ crossCheck: false }), runners: runners({ v2: chirp, gemini: gem }) });
  assert.match(off.text, /class tenderness/); assert.equal(off.consensus, undefined);
  resetHealth();
  const failed = await transcribeWithChain(SPEECH, { settings: S({ crossCheck: true }), runners: runners({ v2: chirp, gemini: boom('429 quota') }) });
  assert.match(failed.text, /class tenderness/); assert.equal(failed.consensus, undefined, 'a failed second opinion never fails or changes the transcript');
  resetHealth();
  const loop = await transcribeWithChain(SPEECH, { settings: S({ crossCheck: true }), runners: runners({ v2: chirp, gemini: ok('word '.repeat(600)) }) });
  assert.match(loop.text, /class tenderness/, 'an impossible second transcript (a loop) is ignored');
});
test('with Gemini as the primary, Chirp 2 is the second opinion; and a slow second engine is abandoned at its time limit', async () => {
  resetHealth(); let gemCalls = 0; let v2Calls = 0;
  const g = await transcribeWithChain(SPEECH, { settings: validateSettings({ primary: 'gemini-2.5-flash', fallbacks: ['latest_long'], crossCheck: true }), runners: runners({
    gemini: async () => { gemCalls++; return { text: 'The pain in the class gets worse when I walk upstairs' }; },
    v2: async () => { v2Calls++; return { text: 'The pain in the calf gets worse when I walk upstairs' }; } }) });
  assert.equal(gemCalls, 1); assert.equal(v2Calls, 1); assert.equal(g.engine, 'gemini-2.5-flash'); assert.match(g.text, /in the calf gets worse/); assert.equal(g.consensus.engine, 'chirp_2');
  resetHealth();
  const fb = await transcribeWithChain(SPEECH, { settings: validateSettings({ primary: 'chirp_2', fallbacks: ['gemini-2.5-flash', 'latest_long'], crossCheck: true }), runners: runners({ v2: boom(), gemini: ok('gemini served this') }) });   // primary failed, Gemini is both the fallback and the checker
  assert.equal(fb.text, 'gemini served this'); assert.equal(fb.consensus, undefined);
  resetHealth();
  const slow = await transcribeWithChain(SPEECH, { settings: S({ crossCheck: true, crossCheckTimeoutMs: 5000 }), runners: runners({ v2: ok('primary text stays'), gemini: () => new Promise((r) => setTimeout(() => r({ text: 'late' }), 6500)) }) });
  assert.equal(slow.text, 'primary text stays');
});
