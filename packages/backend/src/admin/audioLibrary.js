// Admin console: the audio library (/api/console/audio*). ADMIN-ONLY; every play, download, review, delete and export is written to the audit log.
//   GET    /audio               every stored recording with owner, length, size, loudness, words, flags and review status (+ totals)
//   GET    /audio/:id/url       short-lived signed link to listen (?download=1 makes the browser save the file)
//   PUT    /audio/:id/review    { status: real | not_real | unreviewed, note }   a person decides what is a real consultation
//   DELETE /audio/:id           { confirm: true }   removes the file from the bucket and the link from the consult (the note and transcript stay)
//   POST   /audio/analyse       { limit }   measures recordings that have not been measured yet (a few per call)
//   GET    /audio-export        training manifest (JSON lines) of the recordings marked real: signed audio link + transcript + note
// Review state lives in ops.audio_review. The recording itself stays in the private bucket (public access is blocked on it).
'use strict';

import express from 'express';
import { zipWriter } from './zipStream.js';
import { webmToMp4 } from './audioConvert.js';
import { query, one } from '../db/pool.js';
import { measureAudio, audioFlags, countWords, wordsPerMinute, decodeFile, missingWebmHeader } from './audioStats.js';
import { ensureAccountSchema } from '../auth/quota.js';

export const STATUSES = ['unreviewed', 'real', 'not_real'];
const ID_RX = /^[A-Za-z0-9_-]{3,80}$/;
const BUCKET = () => process.env.GCS_AUDIO_BUCKET || '';
const nameOf = (uri) => String(uri || '').replace(`gs://${BUCKET()}/`, '');

export const SQL = {
  ensure: `CREATE SCHEMA IF NOT EXISTS ops;
    CREATE TABLE IF NOT EXISTS ops.audio_review (
      consult_id text PRIMARY KEY, bytes bigint, duration_s real, level real, words int, wpm real, flags text[] NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed', 'real', 'not_real', 'removed')), note text,
      reviewed_by text, reviewed_at timestamptz, analysed_at timestamptz)`,
  list: `
    SELECT c.consult_id, c.title, c.specialty, c.created_at, c.clinician_id, u.email, u.role AS owner_role, coalesce(u.improve_consent, false) AS improve, length(coalesce(c.transcript->>'text', '')) AS transcript_chars,
           r.bytes, r.duration_s, r.level, r.words, r.wpm, coalesce(r.flags, '{}') AS flags, coalesce(r.status, 'unreviewed') AS status, r.note, r.reviewed_by, r.reviewed_at, r.analysed_at
      FROM clinical.consults c
      LEFT JOIN auth.users u ON u.id::text = c.clinician_id
      LEFT JOIN ops.audio_review r ON r.consult_id = c.consult_id
     WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> ''
       AND ($1 = '' OR coalesce(r.status, 'unreviewed') = $1)
       AND ($2 = '' OR c.clinician_id = $2)
     ORDER BY c.created_at DESC LIMIT $3`,
  totals: `
    SELECT count(*)::int AS total, count(*) FILTER (WHERE coalesce(r.status, 'unreviewed') = 'real')::int AS real,
           count(*) FILTER (WHERE r.status = 'not_real')::int AS not_real, count(*) FILTER (WHERE coalesce(r.status, 'unreviewed') = 'unreviewed')::int AS unreviewed,
           count(*) FILTER (WHERE cardinality(coalesce(r.flags, '{}')) > 0)::int AS flagged, count(*) FILTER (WHERE r.analysed_at IS NULL)::int AS not_measured,
           coalesce(sum(r.bytes), 0)::bigint AS bytes, coalesce(sum(r.duration_s), 0)::float AS seconds
      FROM clinical.consults c LEFT JOIN ops.audio_review r ON r.consult_id = c.consult_id WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> ''`,
  one: `SELECT c.consult_id, c.audio_uri, c.clinician_id, c.transcript->>'text' AS transcript, u.role AS owner_role FROM clinical.consults c LEFT JOIN auth.users u ON u.id::text = c.clinician_id WHERE c.consult_id = $1`,
  pending: `
    SELECT c.consult_id, c.audio_uri, c.transcript->>'text' AS transcript, u.role AS owner_role
      FROM clinical.consults c LEFT JOIN auth.users u ON u.id::text = c.clinician_id LEFT JOIN ops.audio_review r ON r.consult_id = c.consult_id
     WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> '' AND r.analysed_at IS NULL ORDER BY c.created_at DESC LIMIT $1`,
  pendingCount: `SELECT count(*)::int AS n FROM clinical.consults c LEFT JOIN ops.audio_review r ON r.consult_id = c.consult_id WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> '' AND r.analysed_at IS NULL`,
  upsertStats: `
    INSERT INTO ops.audio_review (consult_id, bytes, duration_s, level, words, wpm, flags, analysed_at) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], now())
    ON CONFLICT (consult_id) DO UPDATE SET bytes = EXCLUDED.bytes, duration_s = EXCLUDED.duration_s, level = EXCLUDED.level, words = EXCLUDED.words, wpm = EXCLUDED.wpm, flags = EXCLUDED.flags, analysed_at = now()`,
  review: `
    INSERT INTO ops.audio_review (consult_id, status, note, reviewed_by, reviewed_at) VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (consult_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
  removed: `
    INSERT INTO ops.audio_review (consult_id, status, reviewed_by, reviewed_at) VALUES ($1, 'removed', $2, now())
    ON CONFLICT (consult_id) DO UPDATE SET status = 'removed', reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
  clearUri: `UPDATE clinical.consults SET audio_uri = NULL, updated_at = now() WHERE consult_id = $1`,
  exportReal: `
    SELECT c.consult_id, c.specialty, c.created_at, c.audio_uri, c.transcript->>'text' AS transcript,
           coalesce((SELECT f.note->>'rendered' FROM clinical.finals f WHERE f.consult_id = c.consult_id AND f.note->>'rendered' IS NOT NULL ORDER BY f.created_at DESC LIMIT 1),
                    (SELECT d.rendered_note FROM clinical.drafts d WHERE d.consult_id = c.consult_id AND d.rendered_note IS NOT NULL ORDER BY d.created_at DESC LIMIT 1)) AS note,
           r.duration_s, r.reviewed_by, r.reviewed_at
      FROM clinical.consults c JOIN ops.audio_review r ON r.consult_id = c.consult_id
      JOIN auth.users u ON u.id::text = c.clinician_id AND u.improve_consent = true
     WHERE c.audio_uri IS NOT NULL AND c.audio_uri <> '' AND r.status = 'real' ORDER BY c.created_at LIMIT 1000`,
};

let _ready = null;
export const ensureAudioTable = () => (_ready ||= Promise.all([ensureAccountSchema(), query(SQL.ensure)]).catch((e) => { _ready = null; throw e; }));
export const resetAudioTableCache = () => { _ready = null; };

const defaultBucket = async () => { const { Storage } = await import('@google-cloud/storage'); return new Storage().bucket(BUCKET()); };

/** Measures up to `limit` recordings that have no measurements yet. A file that cannot be read is recorded as such, so it is not retried forever. */
export async function analyseBatch({ limit = 8, bucket = defaultBucket, transcode = decodeFile, log = () => {} } = {}) {
  await ensureAudioTable();
  const rows = await query(SQL.pending, [Math.min(Math.max(1, Number(limit) || 8), 25)]);
  const b = rows.length ? await bucket() : null; let done = 0;
  for (const row of rows) {
    let bytes = null; let m = null; let damaged = false;
    try { const [buf] = await b.file(nameOf(row.audio_uri)).download(); bytes = buf.length; m = await measureAudio(buf, transcode); damaged = !m && missingWebmHeader(buf); } catch (e) { log(`audio ${row.consult_id}: ${String(e.message).slice(0, 100)}`); }
    const words = countWords(row.transcript);
    const flags = audioFlags({ durationS: m?.durationS ?? null, level: m?.level ?? null, words, ownerRole: row.owner_role, bytes, damaged });
    await query(SQL.upsertStats, [row.consult_id, bytes, m?.durationS ?? null, m?.level ?? null, words, m ? wordsPerMinute(words, m.durationS) : null, flags]);
    done++;
  }
  const left = await one(SQL.pendingCount);
  return { done, remaining: left?.n ?? 0 };
}

export function mountAudioLibrary(R, { r, audit, ipOf, bucket = defaultBucket }) {
  const json = express.json({ limit: '100kb' });
  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

  R.get('/audio', r(async (req, res) => {
    await ensureAudioTable();
    const status = STATUSES.includes(req.query.status) ? req.query.status : '';
    const user = /^[0-9a-f-]{36}$/i.test(String(req.query.user || '')) ? String(req.query.user) : '';
    const [rows, totals] = await Promise.all([query(SQL.list, [status, user, Math.min(Math.max(1, Number(req.query.limit) || 300), 1000)]), one(SQL.totals)]);
    res.json({ audio: rows, totals: totals || {} });
  }));

  R.get('/audio/:id/url', r(async (req, res) => {
    if (!ID_RX.test(req.params.id)) return bad(res, 'bad id');
    if (!BUCKET()) return bad(res, 'audio storage not configured', 501);
    const row = await one(SQL.one, [req.params.id]);
    if (!row?.audio_uri) return bad(res, 'no audio for this consult', 404);
    const download = req.query.download === '1';
    const file = (await bucket()).file(nameOf(row.audio_uri));
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 10 * 60 * 1000, ...(download ? { responseDisposition: `attachment; filename="notera-${req.params.id}.webm"` } : {}) });
    await audit(req.user.id, download ? 'admin_download_audio' : 'admin_play_audio', { consultId: req.params.id, owner: row.clinician_id }, ipOf(req));
    res.json({ url, expiresInSec: 600, download });
  }));

  // One recording as a file. MP4 (AAC) by default, ?format=webm for the original. A recording ffmpeg cannot convert is sent as the original WebM.
  R.get('/audio/:id/file', r(async (req, res) => {
    if (!ID_RX.test(req.params.id)) return bad(res, 'bad id');
    if (!BUCKET()) return bad(res, 'audio storage not configured', 501);
    const row = await one(SQL.one, [req.params.id]);
    if (!row?.audio_uri) return bad(res, 'no audio for this consult', 404);
    const [buf] = await (await bucket()).file(nameOf(row.audio_uri)).download();
    let out = buf; let ext = 'webm'; let type = 'audio/webm';
    if (req.query.format !== 'webm') { try { out = await webmToMp4(buf); ext = 'mp4'; type = 'audio/mp4'; } catch (e) { console.error('[audio-file] convert failed, sending the original:', req.params.id, e.message); } }
    await audit(req.user.id, 'admin_download_audio', { consultId: req.params.id, owner: row.clinician_id, format: ext }, ipOf(req));
    res.setHeader('Content-Type', type); res.setHeader('Content-Length', out.length);
    res.setHeader('Content-Disposition', `attachment; filename="notera-${req.params.id}.${ext}"`);
    res.end(out);
  }));

  R.put('/audio/:id/review', json, r(async (req, res) => {
    if (!ID_RX.test(req.params.id)) return bad(res, 'bad id');
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return bad(res, 'status must be real, not_real or unreviewed');
    const row = await one(SQL.one, [req.params.id]);
    if (!row?.audio_uri) return bad(res, 'no audio for this consult', 404);
    await ensureAudioTable();
    await query(SQL.review, [req.params.id, status, String(req.body?.note || '').slice(0, 300) || null, req.user.email || req.user.id]);
    await audit(req.user.id, 'admin_review_audio', { consultId: req.params.id, status }, ipOf(req));
    res.json({ ok: true, status });
  }));

  R.delete('/audio/:id', json, r(async (req, res) => {
    if (!ID_RX.test(req.params.id)) return bad(res, 'bad id');
    if (req.body?.confirm !== true) return bad(res, 'send { "confirm": true } to delete a recording');
    const row = await one(SQL.one, [req.params.id]);
    if (!row?.audio_uri) return bad(res, 'no audio for this consult', 404);
    await ensureAudioTable();
    await (await bucket()).file(nameOf(row.audio_uri)).delete({ ignoreNotFound: true });   // the bucket keeps it recoverable for 7 days (soft delete)
    await query(SQL.clearUri, [req.params.id]);
    await query(SQL.removed, [req.params.id, req.user.email || req.user.id]);
    await audit(req.user.id, 'admin_delete_audio', { consultId: req.params.id, owner: row.clinician_id }, ipOf(req));
    res.json({ ok: true, removed: req.params.id });
  }));

  R.post('/audio/analyse', json, r(async (req, res) => {
    const out = await analyseBatch({ limit: req.body?.limit, bucket });
    res.json(out);
  }));

  R.get('/audio-export', r(async (req, res) => {
    await ensureAudioTable();
    const rows = await query(SQL.exportReal);
    const b = rows.length ? await bucket() : null; const lines = [];
    for (const x of rows) {
      const [url] = await b.file(nameOf(x.audio_uri)).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 24 * 3600 * 1000 });
      lines.push(JSON.stringify({ consult_id: x.consult_id, audio_url: url, audio_format: 'webm', duration_s: x.duration_s, specialty: x.specialty, recorded_at: x.created_at,
        transcript: x.transcript || '', transcript_source: 'machine speech-to-text (not human-checked)', note: x.note || '', marked_real_by: x.reviewed_by, marked_real_at: x.reviewed_at }));
    }
    await audit(req.user.id, 'admin_export_audio', { recordings: rows.length }, ipOf(req));
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="notera-training-manifest-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(lines.join('\n') + (lines.length ? '\n' : ''));
  }));
  // All recordings of ONE clinician as a single zip (names: date_time_consult.webm, plus an index.csv). ADMIN-ONLY and audited like every other audio download.
  R.get('/audio-zip', r(async (req, res) => {
    const user = String(req.query.user || ''); if (!/^[0-9a-f-]{36}$/i.test(user)) return bad(res, 'choose a clinician');
    const rows = await query(`SELECT c.consult_id, c.audio_uri, c.created_at, c.specialty, c.title, r.duration_s, u.email FROM clinical.consults c LEFT JOIN ops.audio_review r ON r.consult_id = c.consult_id LEFT JOIN auth.users u ON u.id::text = c.clinician_id
      WHERE c.clinician_id = $1 AND c.audio_uri IS NOT NULL AND c.audio_uri <> '' AND coalesce(r.status, '') <> 'removed' ORDER BY c.created_at`, [user]);
    if (!rows.length) return bad(res, 'this clinician has no stored recordings', 404);
    const b = await bucket(); const who = String(rows[0].email || user).split('@')[0].replace(/[^A-Za-z0-9._-]+/g, '_');
    await audit(req.user.id, 'admin_download_audio', { owner: user, recordings: rows.length, zip: true }, ipOf(req));
    res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="notera-audio-${who}-${new Date().toISOString().slice(0, 10)}.zip"`);
    const z = zipWriter((buf) => new Promise((ok, no) => { res.write(buf, (e) => (e ? no(e) : ok())); }));
    const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15); const index = ['consult_id,recorded_at_utc,seconds,specialty,title,file'];
    let done = 0; const asMp4 = req.query.format !== 'webm';
    try {
      for (const x of rows) {
        let file = `${stamp(x.created_at)}_${x.consult_id}.${asMp4 ? 'mp4' : 'webm'}`;
        try { if (asMp4) { const [raw] = await b.file(nameOf(x.audio_uri)).download(); let data = raw; try { data = await webmToMp4(raw); } catch (e) { file = file.replace(/.mp4$/, '.webm'); console.error('[audio-zip] convert failed, original kept:', x.consult_id, e.message); } await z.add(file, (async function* () { yield data; })(), new Date(x.created_at)); } else { await z.add(file, b.file(nameOf(x.audio_uri)).createReadStream(), new Date(x.created_at)); } done++; index.push([x.consult_id, new Date(x.created_at).toISOString(), Math.round(x.duration_s || 0), x.specialty || '', String(x.title || '').replace(/[",\r\n]+/g, ' '), file].join(',')); }
        catch (e) { console.error('[audio-zip]', x.consult_id, e.message); if (!res.writableEnded && done === 0 && rows.length === 1) throw e; }
      }
      await z.add('index.csv', (async function* () { yield Buffer.from(index.join('\n') + '\n'); })());
      await z.finish(); res.end();
    } catch (e) { console.error('[audio-zip] aborted', e.message); res.destroy(e); }
  }));

}
