// node --test test/asrHedge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hedgedRequest, hedgeAfterMs } from '../src/asr/hedge.js';

const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); });

test('a fast first answer never sends a second request', async () => {
  let calls = 0;
  const r = await hedgedRequest(async () => { calls++; await sleep(10); return 'ok'; }, { hedgeMs: 200 });
  assert.equal(r, 'ok'); assert.equal(calls, 1);
});

test('a hung first request is covered by the second one, and the hung one is aborted', async () => {
  let calls = 0; let abortedFirst = false; const why = [];
  const r = await hedgedRequest(async (signal) => {
    const n = ++calls;
    if (n === 1) { try { await sleep(5000, signal); } catch (e) { abortedFirst = true; throw e; } return 'slow'; }
    await sleep(20); return 'second';
  }, { hedgeMs: 60, onHedge: (w) => why.push(w) });
  assert.equal(r, 'second'); assert.equal(calls, 2); assert.equal(why.length, 1);
  await sleep(30); assert.ok(abortedFirst, 'the loser is cancelled');
});

test('a failing first request is retried at once (no waiting for the hedge time)', async () => {
  let calls = 0; const t0 = Date.now();
  const r = await hedgedRequest(async () => { if (++calls === 1) throw new Error('boom'); return 'fine'; }, { hedgeMs: 5000 });
  assert.equal(r, 'fine'); assert.equal(calls, 2); assert.ok(Date.now() - t0 < 1000);
});

test('rejects only when both attempts failed', async () => {
  let calls = 0;
  await assert.rejects(hedgedRequest(async () => { calls++; throw new Error('down'); }, { hedgeMs: 30 }), /down/);
  assert.equal(calls, 2);
});

test('hedgeMs 0 turns hedging off: one request, its error is returned', async () => {
  let calls = 0;
  await assert.rejects(hedgedRequest(async () => { calls++; throw new Error('x'); }, { hedgeMs: 0 }), /x/);
  assert.equal(calls, 1);
});

test('the hedge time scales with the audio and never goes under 10 s', () => {
  assert.equal(hedgeAfterMs(20), 11000); assert.equal(hedgeAfterMs(120), 36000); assert.equal(hedgeAfterMs(0), 10000); assert.equal(hedgeAfterMs(5), 10000);
});
