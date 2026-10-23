import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake';
const { mountSuperRun, agreement, engineMetrics, buildSummary, recordingName } = await import('../lab/superRun.js');

const CHIRP = 'If you have class tenderness that is the bad sign. My uncle swells sometimes and I take Estrogel at night.';
const GEM = 'If you have calf tenderness that is the bad sign. My ankles swell sometimes and I take Estrogel at night.';
const NOTE = '### Subjective\n- Swelling of the ankles\n### Assessment & Plan\n1. **Fluid retention**\n   - Treatment planned: Monitor';
const audits = [];
function makeSteps(over = {}) {
  return {
    recordings: async () => [{ id: 'CONS-1', name: 'Hormone therapy · Dr A · 22 Oct, 14:05 · 12:00', status: 'real', damaged: false, durationS: 720 }],
    consult: async (id) => (id === 'CONS-1' || id === 'CONS-BAD' ? { consult_id: id, title: 'Hormone therapy', specialty: 'general', audio_uri: 'gs://b/a.webm', full_name: 'Dr A', created_at: '2026-10-22T14:05:00Z' } : null),
    audioBytes: async () => Buffer.from('x'), decode: async (b) => (over.damaged ? null : Buffer.alloc(32000 * 120)), mp3: async () => (over.noMp3 ? null : Buffer.from('mp3')),
    chirp: async () => { if (over.slow) await new Promise((r) => setTimeout(r, 200)); if (over.chirpFails) throw new Error('quota'); return CHIRP; }, gemini: async () => GEM,
    compare: async ({ mp3, facts }) => ({ winner: over.winner || 'B', confidence: 'high', headline: 'Gemini heard calf and ankles correctly.', scores: { A: { overall: 71 }, B: { overall: 93 } }, reasons: ['calf not class'], disagreements: [{ a: 'class', b: 'calf', audio: 'calf', right: 'B', impact: 'high' }], limits: mp3 ? '' : 'no audio', seenFacts: facts }),
    note: async (text) => { over.noteSawText = text; return { rendered: NOTE, flags: [{ type: 'check_against_recording', severity: 'warning', message: 'x' }], trace: { used: 'v2' } }; },
  };
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
let auditResult = { verdict: 'good', score: 86, summary: 'Faithful note.', wrong: [], missing: [{ fact: 'x', importance: 'minor' }], extra: [], ap_gaps: [], strengths: ['Plan under the right problem'] };
function boot(over = {}, dir = dataDir) {
  const app = express(); app.use(express.json());
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };
  mountSuperRun(app, { wrap, auditAdhoc: async () => auditResult, dataDir: dir, steps: makeSteps(over), auditFn: async (...a) => { audits.push(a); } });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/superrun`;
  return { server, base, over };
}
const H = { 'Content-Type': 'application/json', 'X-Admin-Id': 'admin-1', 'X-Admin-Email': 'support@agilepartners-ai.com' };
const post = (b, p, body = {}) => fetch(b + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const get = (b, p) => fetch(b + p, { headers: H });
async function until(b, id, pick, ms = 4000) { const t0 = Date.now(); for (;;) { const r = await (await get(b, '/' + id)).json(); if (pick(r)) return r; if (Date.now() - t0 > ms) throw new Error('timeout ' + JSON.stringify(r.asr?.status)); await new Promise((x) => setTimeout(x, 25)); } }

test('measurable facts: agreement finds the differences and marks the medical ones first', () => {
  const a = agreement(CHIRP, GEM);
  assert.ok(a.sharedPct > 70 && a.sharedPct < 100); assert.equal(a.differences, 2); assert.equal(a.medicalDifferences, 2);
  assert.deepEqual(a.spans.map((s) => [s.a, s.b]).sort(), [['class', 'calf'], ['uncle swells', 'ankles swell']].sort());
  assert.equal(agreement('', 'x').sharedPct, null);
  const m = engineMetrics(GEM, 120, 8000, 0.002); assert.equal(m.words, 20); assert.equal(m.wpm, 10); assert.equal(m.costUsd, 0.004); assert.equal(m.speedX, 15); assert.ok(m.medicalTerms >= 2);
  assert.match(recordingName({ title: 'Cough', full_name: 'Dr A', created_at: '2026-10-22T14:05:00Z', duration_s: 305 }), /^Cough · Dr A · 22 Oct.* · 5:05$/);
});
test('the whole chain, one step at a time: transcribe, compare, note, audit, summary', async () => {
  const { server, base } = boot({ winner: 'B', slow: true }); try {
    const recs = await (await get(base, '/recordings')).json(); assert.equal(recs.recordings[0].id, 'CONS-1');
    assert.equal((await post(base, '', { consultId: 'bad id!' })).status, 400); assert.equal((await post(base, '', { consultId: 'CONS-NONE' })).status, 404);
    const run = await (await post(base, '', { consultId: 'CONS-1' })).json(); assert.match(run.id, /^sr_[a-f0-9]{12}$/); assert.equal(run.by, 'support@agilepartners-ai.com');
    assert.equal((await post(base, `/${run.id}/compare`)).status, 409, 'compare waits for both transcripts');
    assert.equal((await post(base, `/${run.id}/note`)).status, 409, 'the note waits for the comparison');
    const asr = await until(base, run.id, (r) => r.asr.status === 'done');
    assert.equal(asr.durationS, 120); assert.equal(asr.asr.engines.chirp.status, 'done'); assert.equal(asr.asr.engines.gemini.metrics.words, 20); assert.equal(asr.asr.agreement.medicalDifferences, 2);
    await post(base, `/${run.id}/compare`); const cmp = await until(base, run.id, (r) => r.compare.status === 'done');
    assert.equal(cmp.compare.result.winner, 'B'); assert.equal(cmp.compare.audioAttached, true); assert.equal(cmp.compare.result.seenFacts.agreement.medicalDifferences, 2, 'the reviewer is given the measured facts'); assert.equal(cmp.compare.result.seenFacts.audioSeconds, 120);
    await post(base, `/${run.id}/note`, {}); const done = await until(base, run.id, (r) => r.audit.status === 'done');
    assert.equal(done.note.sourceKey, 'gemini', 'the winner is used by default'); assert.equal(done.note.toCheck, 1); assert.match(done.note.rendered, /Swelling of the ankles/);
    assert.equal(done.audit.result.score, 86);
    assert.equal(done.summary.verdict, 'pass'); assert.match(done.summary.headline, /Pass: Gemini 2\.5 Flash transcript, note scored 86\/100/);
    assert.deepEqual(done.summary.lines.map((l) => l.step), ['Transcribe', 'Compare', 'SOAP note', 'Audit']); assert.match(done.summary.lines[0].text, /agree on .*% of the words/); assert.ok(done.summary.caveats.length >= 2);
    assert.deepEqual(audits.filter((a) => a[0] === 'admin-1').map((a) => a[2].step), ['start', 'compare', 'note']);
    assert.equal((await (await get(base, '/runs')).json()).runs[0].id, run.id); assert.equal((await get(base, '/sr_nope123456')).status, 404); assert.equal((await get(base, '/..%2Fetc')).status, 404);
    assert.match((await get(base, `/${run.id}/report`)).headers.get('content-disposition'), /super-run-sr_/);
  } finally { server.close(); }
});
test('the admin can pick the other transcript for the note', async () => {
  const over = { winner: 'B' }; const { server, base } = boot(over); try {
    const run = await (await post(base, '', { consultId: 'CONS-1' })).json(); await until(base, run.id, (r) => r.asr.status === 'done');
    await post(base, `/${run.id}/compare`); await until(base, run.id, (r) => r.compare.status === 'done');
    await post(base, `/${run.id}/note`, { use: 'chirp' }); const done = await until(base, run.id, (r) => r.audit.status === 'done');
    assert.equal(done.note.sourceKey, 'chirp'); assert.equal(over.noteSawText, CHIRP);
  } finally { server.close(); }
});
test('a damaged recording is explained; a failed model is reported and the chain stops there', async () => {
  let b = boot({ damaged: true }); try {
    const run = await (await post(b.base, '', { consultId: 'CONS-BAD' })).json(); const r = await until(b.base, run.id, (x) => x.asr.status === 'error');
    assert.match(r.asr.error, /damaged/); assert.equal((await post(b.base, `/${run.id}/compare`)).status, 409);
  } finally { b.server.close(); }
  b = boot({ chirpFails: true }); try {
    const run = await (await post(b.base, '', { consultId: 'CONS-1' })).json(); const r = await until(b.base, run.id, (x) => x.asr.status === 'error');
    assert.match(r.asr.error, /Chirp 2: quota/); assert.equal(r.asr.engines.gemini.status, 'done', 'the other model still finished');
  } finally { b.server.close(); }
});
test('a critical audit finding makes the verdict unsafe; a restart marks a running step as interrupted', async () => {
  auditResult = { verdict: 'good', score: 80, summary: 'Mostly fine.', wrong: [{ claim: 'Take Wegovy', problem: 'drug not said', severity: 'critical' }], missing: [], extra: [], ap_gaps: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test2-')); let b = boot({}, dir); let id; try {
    const run = await (await post(b.base, '', { consultId: 'CONS-1' })).json(); id = run.id; await until(b.base, id, (r) => r.asr.status === 'done');
    await post(b.base, `/${id}/compare`); await until(b.base, id, (r) => r.compare.status === 'done'); await post(b.base, `/${id}/note`); const done = await until(b.base, id, (r) => r.audit.status === 'done');
    assert.equal(done.summary.verdict, 'unsafe'); assert.match(done.summary.headline, /^Unsafe:/); assert.match(done.summary.lines.at(-1).text, /1 critical/);
  } finally { b.server.close(); }
  const f = path.join(dir, 'superruns', id + '.json'); const saved = JSON.parse(fs.readFileSync(f, 'utf8')); saved.compare = { status: 'running' }; fs.writeFileSync(f, JSON.stringify(saved));
  b = boot({}, dir); try { const r = await (await get(b.base, '/' + id)).json(); assert.equal(r.compare.status, 'error'); assert.match(r.compare.error, /restart/); } finally { b.server.close(); }
  const s = buildSummary({ name: 'x', durationS: 60, asr: { status: 'done', engines: {}, agreement: {} } }); assert.equal(s.verdict, 'incomplete');
});
