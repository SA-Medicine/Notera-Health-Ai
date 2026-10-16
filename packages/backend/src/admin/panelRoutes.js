// ─────────────────────────────────────────────────────────────────────────────
// Notera — admin console API (/api/console/*).  READ-ONLY, ADMIN-ONLY.
// Backs the standalone admin site (separate Cloudflare Pages project):
//   users (plan, usage, last login) · every consult (transcript + SOAP note + pipeline run)
//   · audio (short-lived signed URL) · activity (sign-ups, logins, plan changes, admin views).
// Anything that exposes PHI (a transcript, a note, an audio file) is written to auth.audit_log
// with the admin's id, so access to patient data is itself auditable.
// Non-admins get 404, exactly like /api/ops. Plan changes use the existing
// POST /api/auth/users/plan (admin) so there is one write path.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';
import { query, one } from '../db/pool.js';
import { audit } from '../auth/users.js';
import { ensureAccountSchema, FREE_NOTE_LIMIT } from '../auth/quota.js';

const lim = (n, d = 100, max = 500) => Math.min(Math.max(1, Number(n) || d), max);
const BUCKET = () => process.env.GCS_AUDIO_BUCKET || '';
const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.ip || '');

// SQL kept as constants so a test can EXPLAIN every statement against the real schema.
export const SQL = {
  users: `
    SELECT u.id, u.email, u.full_name, u.role, u.plan, u.free_notes_used, u.is_active, u.created_at, u.last_login_at,
           (SELECT count(*) FROM clinical.consults c WHERE c.clinician_id = u.id::text) AS consults,
           (SELECT count(*) FROM clinical.consults c WHERE c.clinician_id = u.id::text AND c.audio_uri IS NOT NULL) AS audio,
           (SELECT max(c.created_at) FROM clinical.consults c WHERE c.clinician_id = u.id::text) AS last_consult
      FROM auth.users u
     WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR coalesce(u.full_name, '') ILIKE '%' || $1 || '%')
       AND ($2 = '' OR u.plan = $2)
     ORDER BY u.created_at DESC LIMIT $3`,
  user: `SELECT id, email, full_name, role, plan, free_notes_used, is_active, created_at, last_login_at, failed_logins, locked_until FROM auth.users WHERE id = $1::uuid`,
  consults: `
    SELECT c.consult_id, c.title, c.specialty, c.status, c.pipeline_version, (c.audio_uri IS NOT NULL) AS has_audio, c.created_at,
           c.clinician_id, u.email, u.full_name, length(coalesce(c.transcript->>'text', '')) AS transcript_chars,
           (SELECT count(*) FROM clinical.drafts d WHERE d.consult_id = c.consult_id) AS drafts
      FROM clinical.consults c LEFT JOIN auth.users u ON u.id::text = c.clinician_id
     WHERE ($1 = '' OR c.clinician_id = $1)
       AND (NOT $2::boolean OR c.audio_uri IS NOT NULL)
       AND ($3 = '' OR coalesce(c.title, '') ILIKE '%' || $3 || '%' OR coalesce(u.email, '') ILIKE '%' || $3 || '%' OR coalesce(c.specialty, '') ILIKE '%' || $3 || '%')
     ORDER BY c.created_at DESC LIMIT $4`,
  consult: `
    SELECT c.consult_id, c.title, c.specialty, c.note_type, c.status, c.pipeline_version, c.audio_uri, c.created_at, c.updated_at,
           c.clinician_id, u.email, u.full_name, c.transcript->>'text' AS transcript, c.metadata
      FROM clinical.consults c LEFT JOIN auth.users u ON u.id::text = c.clinician_id WHERE c.consult_id = $1`,
  drafts: `SELECT draft_id, rendered_note, note, flags, generated_by, status, created_at FROM clinical.drafts WHERE consult_id = $1 ORDER BY created_at DESC LIMIT 5`,
  finals: `SELECT final_id, note, approved_by, approved_at, status, created_at FROM clinical.finals WHERE consult_id = $1 ORDER BY created_at DESC LIMIT 3`,
  runs: `SELECT run_id, model, status, duration_ms, total_tokens, est_cost_usd, timings, created_at FROM ops.pipeline_runs WHERE consult_id = $1 ORDER BY created_at DESC LIMIT 10`,
  audit: `
    SELECT a.id, a.at, a.action, a.detail, a.ip::text AS ip, u.email
      FROM auth.audit_log a LEFT JOIN auth.users u ON u.id = a.user_id
     WHERE ($1 = '' OR a.action = $1)
     ORDER BY a.at DESC LIMIT $2`,
  audioRow: `SELECT clinician_id, audio_uri FROM clinical.consults WHERE consult_id = $1`,
  usersByDay: `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n FROM auth.users WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`,
  consultsByDay: `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n FROM clinical.consults WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`,
};

export function mountPanel(app, requireAuthMw) {
  const adminOnly = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(404).json({ error: 'not found' });
  const r = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[console]', e.message); res.status(500).json({ error: e.message }); } };
  const R = express.Router();
  R.use(requireAuthMw, adminOnly);

  R.get('/overview', r(async (req, res) => {
    await ensureAccountSchema().catch(() => {});
    const safe = (q, a) => one(q, a).catch(() => null);
    const [users, consults, runs, atLimit, usersByDay, consultsByDay, audioEvents] = await Promise.all([
      safe(`SELECT count(*)::int total, count(*) FILTER (WHERE plan='free')::int free, count(*) FILTER (WHERE plan='full')::int "full",
                   count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int new_24h,
                   count(*) FILTER (WHERE created_at > now() - interval '7 days')::int new_7d FROM auth.users`),
      safe(`SELECT count(*)::int total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int d1,
                   count(*) FILTER (WHERE created_at > now() - interval '7 days')::int d7,
                   count(*) FILTER (WHERE audio_uri IS NOT NULL)::int with_audio FROM clinical.consults`),
      safe(`SELECT count(*)::int runs, count(*) FILTER (WHERE status='error')::int errors, coalesce(sum(est_cost_usd),0)::float cost,
                   percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)::int p50 FROM ops.pipeline_runs WHERE created_at > now() - interval '7 days'`),
      safe(`SELECT count(*)::int n FROM auth.users WHERE plan='free' AND free_notes_used >= $1`, [FREE_NOTE_LIMIT]),
      query(SQL.usersByDay).catch(() => []),
      query(SQL.consultsByDay).catch(() => []),
      safe(`SELECT count(*)::int n FROM ops.audio_events WHERE ts > now() - interval '7 days'`),
    ]);
    res.json({ users, consults, runs_7d: runs, free_at_limit: atLimit?.n ?? 0, free_limit: FREE_NOTE_LIMIT, users_by_day: usersByDay, consults_by_day: consultsByDay, audio_events_7d: audioEvents?.n ?? 0 });
  }));

  R.get('/users', r(async (req, res) => {
    await ensureAccountSchema().catch(() => {});
    const plan = ['free', 'full'].includes(req.query.plan) ? req.query.plan : '';
    res.json({ users: await query(SQL.users, [String(req.query.q || '').slice(0, 80), plan, lim(req.query.limit, 200)]), free_limit: FREE_NOTE_LIMIT });
  }));

  R.get('/users/:id', r(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const user = await one(SQL.user, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'not found' });
    const consults = await query(SQL.consults, [req.params.id, false, '', 200]);
    res.json({ user, consults });
  }));

  R.get('/consults', r(async (req, res) => {
    const user = /^[0-9a-f-]{36}$/i.test(String(req.query.user || '')) ? req.query.user : '';
    res.json({ consults: await query(SQL.consults, [user, req.query.audio === '1', String(req.query.q || '').slice(0, 80), lim(req.query.limit, 100)]) });
  }));

  R.get('/consults/:id', r(async (req, res) => {
    const consult = await one(SQL.consult, [req.params.id]);
    if (!consult) return res.status(404).json({ error: 'not found' });
    const [drafts, finals, runs] = await Promise.all([query(SQL.drafts, [req.params.id]), query(SQL.finals, [req.params.id]), query(SQL.runs, [req.params.id]).catch(() => [])]);
    await audit(req.user.id, 'admin_view_consult', { consultId: req.params.id, owner: consult.email || consult.clinician_id }, ipOf(req));
    res.json({ consult: { ...consult, has_audio: !!consult.audio_uri }, drafts, finals, runs });
  }));

  // Short-lived signed URL for the recording. Audited like any other PHI access.
  R.get('/consults/:id/audio', r(async (req, res) => {
    const row = await one(SQL.audioRow, [req.params.id]);
    if (!row || !row.audio_uri) return res.status(404).json({ error: 'no audio for this consult' });
    if (!BUCKET()) return res.status(501).json({ error: 'audio storage not configured' });
    const { Storage } = await import('@google-cloud/storage');
    const name = row.audio_uri.replace(`gs://${BUCKET()}/`, '');
    const [url] = await new Storage().bucket(BUCKET()).file(name).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 10 * 60 * 1000 });
    await audit(req.user.id, 'admin_play_audio', { consultId: req.params.id, owner: row.clinician_id }, ipOf(req));
    res.json({ url, expiresInSec: 600 });
  }));

  R.get('/audit', r(async (req, res) => {
    res.json({ events: await query(SQL.audit, [String(req.query.action || '').slice(0, 40), lim(req.query.limit, 200)]) });
  }));

  app.use('/api/console', R);
}
