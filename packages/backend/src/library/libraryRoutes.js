// ─────────────────────────────────────────────────────────────────────────────
// Notera — per-user Library API (durable history of consults + transcripts +
// SOAP notes, and audio storage/download). All routes require a valid session
// and are scoped to req.user.id (the clinician). Audio lives in GCS; downloads
// use short-lived signed URLs so large files never proxy through the server.
//
//   POST   /api/library/consults              save {transcript, note, title, specialty}
//   GET    /api/library/consults              list the user's consults (history)
//   GET    /api/library/consults/:id          fetch one (owner-only)
//   DELETE /api/library/consults/:id          delete one (owner-only)
//   POST   /api/library/consults/:id/audio    upload the recording (raw bytes) → GCS
//   GET    /api/library/consults/:id/audio    signed download URL (owner-only)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';
import crypto from 'node:crypto';
import { store } from '../firestore/store.js';
import { query, one } from '../db/pool.js';

const BUCKET = () => process.env.GCS_AUDIO_BUCKET || '';

async function gcsBucket() {
  const { Storage } = await import('@google-cloud/storage');
  return new Storage().bucket(BUCKET());
}

export function mountLibrary(app, requireAuthMw) {
  const json = express.json({ limit: '4mb' });

  // Save (or update) a consult produced by the client — tied to the logged-in user.
  app.post('/api/library/consults', requireAuthMw, json, async (req, res) => {
    try {
      const { consultId, transcript, note, renderedNote, title, specialty, noteType, status } = req.body || {};
      const id = consultId || 'c_' + crypto.randomBytes(9).toString('hex');
      await store.createConsult({
        consultId: id, clinicianId: req.user.id, specialty, noteType,
        status: status || 'ready', title: title || null,
        transcript: transcript ? { text: transcript } : null,
        createdAt: new Date().toISOString(),
      });
      if (note || renderedNote) {
        await store.addDraft(id, { draftId: 'd_' + crypto.randomBytes(6).toString('hex'), note: note ?? null, renderedNote: renderedNote || null, status: 'DRAFT' });
      }
      // stamp the title (createConsult doesn't set it in the base driver map)
      await query(`UPDATE clinical.consults SET title=COALESCE($2,title), updated_at=now() WHERE consult_id=$1`, [id, title || null]).catch(() => {});
      res.json({ ok: true, consultId: id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // List the user's consults (most recent first).
  app.get('/api/library/consults', requireAuthMw, async (req, res) => {
    try {
      const rows = await query(
        `SELECT consult_id, title, specialty, note_type, status, audio_uri, created_at
           FROM clinical.consults WHERE clinician_id=$1 ORDER BY created_at DESC LIMIT 200`,
        [req.user.id]);
      res.json({ consults: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Fetch one consult (with its latest draft/final) — owner only.
  app.get('/api/library/consults/:id', requireAuthMw, async (req, res) => {
    try {
      const owner = await one(`SELECT clinician_id FROM clinical.consults WHERE consult_id=$1`, [req.params.id]);
      if (!owner) return res.status(404).json({ error: 'not found' });
      if (owner.clinician_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
      const consult = await store.getConsult(req.params.id);
      res.json({ consult });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/library/consults/:id', requireAuthMw, async (req, res) => {
    try {
      const owner = await one(`SELECT clinician_id, audio_uri FROM clinical.consults WHERE consult_id=$1`, [req.params.id]);
      if (!owner) return res.status(404).json({ error: 'not found' });
      if (owner.clinician_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
      await query(`DELETE FROM clinical.consults WHERE consult_id=$1`, [req.params.id]);
      if (owner.audio_uri && BUCKET()) {
        try { const name = owner.audio_uri.replace(`gs://${BUCKET()}/`, ''); (await gcsBucket()).file(name).delete().catch(() => {}); } catch { /* ignore */ }
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Upload the recording (raw audio bytes) to GCS → store the gs:// URI.
  app.post('/api/library/consults/:id/audio', requireAuthMw, express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
    try {
      if (!BUCKET()) return res.status(501).json({ error: 'audio storage not configured (set GCS_AUDIO_BUCKET)' });
      const owner = await one(`SELECT clinician_id FROM clinical.consults WHERE consult_id=$1`, [req.params.id]);
      if (!owner) return res.status(404).json({ error: 'consult not found — save it first' });
      if (owner.clinician_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
      const ct = String(req.headers['content-type'] || 'audio/webm');
      const ext = /ogg/i.test(ct) ? 'ogg' : /mp4/i.test(ct) ? 'mp4' : /wav/i.test(ct) ? 'wav' : 'webm';
      const objectName = `audio/${req.user.id}/${req.params.id}.${ext}`;
      await (await gcsBucket()).file(objectName).save(req.body, { contentType: ct, resumable: false });
      const uri = `gs://${BUCKET()}/${objectName}`;
      await query(`UPDATE clinical.consults SET audio_uri=$2, updated_at=now() WHERE consult_id=$1`, [req.params.id, uri]);
      res.json({ ok: true, audioUri: uri });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Short-lived signed URL to download the audio directly from GCS (owner only).
  app.get('/api/library/consults/:id/audio', requireAuthMw, async (req, res) => {
    try {
      const row = await one(`SELECT clinician_id, audio_uri FROM clinical.consults WHERE consult_id=$1`, [req.params.id]);
      if (!row || !row.audio_uri) return res.status(404).json({ error: 'no audio for this consult' });
      if (row.clinician_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
      const name = row.audio_uri.replace(`gs://${BUCKET()}/`, '');
      const [url] = await (await gcsBucket()).file(name).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 15 * 60 * 1000 });
      res.json({ url, expiresInSec: 900 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
