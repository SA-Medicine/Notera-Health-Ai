import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { audioFlags, meanLevel, measureAudio, wordsPerMinute, countWords } from '../src/admin/audioStats.js';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake';
process.env.GCS_AUDIO_BUCKET = 'test-bucket';
const { _setPool } = await import('../src/db/pool.js');
const calls = []; let rows = {};
_setPool({ query: async (sql, params) => {
  const s = String(sql).replace(/\s+/g, ' ').trim(); calls.push({ sql: s, params });
  for (const [needle, out] of Object.entries(rows)) if (s.includes(needle)) return { rows: typeof out === 'function' ? out(params) : out };
  return { rows: [] };
} });
const { mountAudioLibrary, analyseBatch, resetAudioTableCache } = await import('../src/admin/audioLibrary.js');

const deleted = []; const signed = []; const audits = [];
const fakeBucket = async () => ({ file: (name) => ({
  delete: async (o) => { deleted.push({ name, o }); },
  getSignedUrl: async (o) => { signed.push({ name, o }); return [`https://signed.example/${name}?x=1`]; },
  download: async () => [Buffer.from('fake-audio-bytes')],
}) });
const R = express.Router(); let user = { id: 'admin-1', role: 'admin', email: 'support@agilepartners-ai.com' };
R.use((req, _res, next) => { req.user = user; next(); });
const r = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };
mountAudioLibrary(R, { r, audit: async (...a) => { audits.push(a); }, ipOf: () => '1.2.3.4', bucket: fakeBucket });
const app = express(); app.use('/api/console', R); const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/console`;
test.after(() => server.close());
const j = (p, init) => fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...init });

test('flags say why a recording may not be real, and never judge a normal visit', () => {
  assert.deepEqual(audioFlags({ durationS: 600, level: 1800, words: 1300, ownerRole: 'clinician', bytes: 3e6 }), []);
  assert.deepEqual(audioFlags({ durationS: 12, level: 1800, words: 30, ownerRole: 'clinician', bytes: 3e5 }), ['very short']);
  assert.ok(audioFlags({ durationS: 120, level: 90, words: 0, ownerRole: 'clinician', bytes: 3e6 }).includes('mostly silent'));
  assert.ok(audioFlags({ durationS: 120, level: 1800, words: 4, ownerRole: 'clinician', bytes: 3e6 }).includes('almost no words'));
  assert.ok(audioFlags({ durationS: 300, level: 1800, words: 100, ownerRole: 'clinician', bytes: 3e6 }).includes('few words for its length'));   // 20 words a minute
  assert.deepEqual(audioFlags({ durationS: 300, level: 1800, words: 400, ownerRole: 'clinician', bytes: 3e6 }), []);   // 80 a minute is a quiet but real visit
  assert.ok(audioFlags({ durationS: 100, level: 1800, words: 800, ownerRole: 'clinician', bytes: 3e6 }).includes('more words than speech allows'));
  assert.ok(audioFlags({ durationS: 600, level: 1800, words: 1300, ownerRole: 'admin', bytes: 3e6 }).includes('admin account (test upload?)'));
  assert.deepEqual(audioFlags({ durationS: null }), ['cannot be decoded']);
});
test('loudness and measurement', async () => {
  const pcm = Buffer.alloc(32000 * 2); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 4000 : -4000, i);
  assert.ok(meanLevel(pcm) > 3000); assert.equal(meanLevel(Buffer.alloc(64000)), 0);
  assert.deepEqual(await measureAudio(Buffer.from('x'), async () => pcm), { durationS: 2, level: Math.round(meanLevel(pcm)) });
  assert.equal(await measureAudio(Buffer.from('x'), async () => null), null);
  assert.equal(wordsPerMinute(120, 60), 120); assert.equal(countWords("I don't know, 2 pills"), 5);
});
test('the list shows every recording with its review status and totals', async () => {
  rows = { 'FROM clinical.consults c LEFT JOIN auth.users u': [{ consult_id: 'c_1', status: 'unreviewed', flags: ['very short'] }], 'count(*)::int AS total': [{ total: 55, real: 0, not_real: 0, unreviewed: 55 }] };
  const out = await (await j('/audio?status=real')).json();
  assert.equal(out.audio.length, 1); assert.equal(out.totals.total, 55);
  assert.equal(calls.find((c) => c.sql.includes('LEFT JOIN ops.audio_review r ON r.consult_id = c.consult_id WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> \'\' AND ($1'))?.params[0], 'real');
  assert.ok(calls.some((c) => c.sql.startsWith('CREATE SCHEMA IF NOT EXISTS ops')), 'the review table is created on first use');
});
test('listen and download give short-lived signed links and are audited', async () => {
  rows = { 'SELECT c.consult_id, c.audio_uri, c.clinician_id': [{ consult_id: 'c_1', audio_uri: 'gs://test-bucket/audio/u1/c_1.webm', clinician_id: 'u1' }] };
  const play = await (await j('/audio/c_1/url')).json(); assert.match(play.url, /^https:\/\/signed\.example\/audio\/u1\/c_1\.webm/); assert.equal(signed.at(-1).o.responseDisposition, undefined);
  const dl = await (await j('/audio/c_1/url?download=1')).json(); assert.equal(dl.download, true); assert.match(signed.at(-1).o.responseDisposition, /attachment; filename="notera-c_1\.webm"/);
  assert.deepEqual(audits.slice(-2).map((a) => a[1]), ['admin_play_audio', 'admin_download_audio']);
  assert.equal((await j('/audio/../etc/url')).status, 404); assert.equal((await j('/audio/bad%20id/url')).status, 400);
});
test('review accepts only real, not_real or unreviewed', async () => {
  rows = { 'SELECT c.consult_id, c.audio_uri, c.clinician_id': [{ consult_id: 'c_1', audio_uri: 'gs://test-bucket/a.webm' }] };
  assert.equal((await j('/audio/c_1/review', { method: 'PUT', body: JSON.stringify({ status: 'maybe' }) })).status, 400);
  const ok = await j('/audio/c_1/review', { method: 'PUT', body: JSON.stringify({ status: 'not_real', note: 'test clip' }) }); assert.equal(ok.status, 200);
  const q = calls.filter((c) => c.sql.startsWith('INSERT INTO ops.audio_review (consult_id, status, note')).at(-1); assert.deepEqual(q.params.slice(0, 4), ['c_1', 'not_real', 'test clip', 'support@agilepartners-ai.com']);
  assert.equal(audits.at(-1)[1], 'admin_review_audio');
});
test('delete needs an explicit confirm, removes the file, clears the link and keeps the note', async () => {
  rows = { 'SELECT c.consult_id, c.audio_uri, c.clinician_id': [{ consult_id: 'c_9', audio_uri: 'gs://test-bucket/audio/u1/c_9.webm', clinician_id: 'u1' }] };
  assert.equal((await j('/audio/c_9', { method: 'DELETE', body: '{}' })).status, 400); assert.equal(deleted.length, 0);
  const res = await j('/audio/c_9', { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); assert.equal(res.status, 200);
  assert.deepEqual(deleted.at(-1), { name: 'audio/u1/c_9.webm', o: { ignoreNotFound: true } });
  assert.ok(calls.some((c) => c.sql.startsWith('UPDATE clinical.consults SET audio_uri = NULL') && c.params[0] === 'c_9')); assert.ok(!calls.some((c) => /DELETE FROM clinical/.test(c.sql)));
  assert.equal(audits.at(-1)[1], 'admin_delete_audio');
});
test('the training manifest lists only recordings marked real, one JSON line each', async () => {
  rows = { 'r.status = \'real\'': [{ consult_id: 'c_1', specialty: 'general', created_at: '2026-10-01', audio_uri: 'gs://test-bucket/audio/u1/c_1.webm', transcript: 'hello', note: '### Subjective', duration_s: 301.5, reviewed_by: 'support@agilepartners-ai.com', reviewed_at: '2026-10-23' }] };
  const res = await j('/audio-export'); assert.match(res.headers.get('content-disposition'), /notera-training-manifest-\d{4}-\d{2}-\d{2}\.jsonl/);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l)); assert.equal(lines.length, 1);
  assert.equal(lines[0].consult_id, 'c_1'); assert.match(lines[0].audio_url, /signed\.example/); assert.match(lines[0].transcript_source, /not human-checked/); assert.equal(audits.at(-1)[1], 'admin_export_audio');
});
test('analysing measures what is pending and reports what is left; an unreadable file is recorded, not retried forever', async () => {
  resetAudioTableCache(); calls.length = 0;
  rows = { 'r.analysed_at IS NULL ORDER BY c.created_at DESC LIMIT': [{ consult_id: 'c_1', audio_uri: 'gs://test-bucket/a.webm', transcript: 'one two three four five six seven eight nine ten eleven twelve', owner_role: 'clinician' }, { consult_id: 'c_2', audio_uri: 'gs://test-bucket/b.webm', transcript: '', owner_role: 'admin' }],
    'count(*)::int AS n': [{ n: 3 }] };
  const pcm = Buffer.alloc(32000 * 90, 1); let n = 0;
  const out = await analyseBatch({ limit: 5, bucket: fakeBucket, transcode: async () => (++n === 1 ? pcm : null) });
  assert.deepEqual(out, { done: 2, remaining: 3 });
  const ups = calls.filter((c) => c.sql.startsWith('INSERT INTO ops.audio_review (consult_id, bytes')); assert.equal(ups.length, 2);
  assert.equal(ups[1].params[0], 'c_2'); assert.deepEqual(ups[1].params[6], ['damaged file (no audio header)', 'admin account (test upload?)']);
});

import { missingWebmHeader } from '../src/admin/audioStats.js';
test('a recording that starts with a later data block is called damaged, not just undecodable', () => {
  assert.deepEqual(audioFlags({ durationS: null, damaged: true, ownerRole: 'clinician' }), ['damaged file (no audio header)']);
  assert.deepEqual(audioFlags({ durationS: null, damaged: false, ownerRole: 'clinician' }), ['cannot be decoded']);
  assert.equal(missingWebmHeader(Buffer.from('43b67501aabbcc', 'hex')), true); assert.equal(missingWebmHeader(Buffer.from('1a45dfa3aabbcc', 'hex')), false); assert.equal(missingWebmHeader(Buffer.from('OggSxxxx')), false);
});
