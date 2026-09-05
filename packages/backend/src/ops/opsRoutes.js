// ─────────────────────────────────────────────────────────────────────────────
// Notera — monitoring API (/api/ops/*). Read endpoints are ADMIN-ONLY; the two
// intake endpoints accept any authenticated user (they stamp clinician_id from
// the session). Backs the monitor.aitoolsfordoctor.com dashboard.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';
import { query, one } from '../db/pool.js';
import { recordError, recordAudioEvent, ensureOpsSchema } from './opsLog.js';

// range token → Postgres interval string (whitelisted; never interpolate user text raw)
const RANGES = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
const iv = (r) => RANGES[r] || RANGES['7d'];
const lim = (n, d = 100, max = 500) => Math.min(Math.max(1, Number(n) || d), max);

export function mountOps(app, requireAuthMw) {
  const json = express.json({ limit: '256kb' });
  const adminOnly = (req, res, next) =>
    (req.user && req.user.role === 'admin') ? next() : res.status(404).json({ error: 'not found' });

  ensureOpsSchema().catch(() => {});

  // ── intake (any authenticated user) ────────────────────────────────────────
  app.post('/api/ops/client-error', requireAuthMw, json, async (req, res) => {
    const { message, stack, route, code } = req.body || {};
    await recordError({ source: 'frontend', level: 'error', code: code || 'CLIENT_JS',
      message, stack, clinicianId: req.user?.id, context: { route } });
    res.json({ ok: true });
  });

  app.post('/api/ops/audio-event', requireAuthMw, json, async (req, res) => {
    const { consultId, reason, durationMs, meta } = req.body || {};
    await recordAudioEvent({ consultId, clinicianId: req.user?.id, reason, durationMs, meta });
    res.json({ ok: true });
  });

  // ── reads (admin only) ─────────────────────────────────────────────────────
  const ops = express.Router();
  ops.use(requireAuthMw, adminOnly);

  ops.get('/summary', async (req, res) => {
    try {
      const i = iv(req.query.range);
      const runs = await one(
        `SELECT count(*) runs,
                count(*) FILTER (WHERE status='error') errors,
                coalesce(sum(total_tokens),0) tokens,
                coalesce(sum(est_cost_usd),0) cost,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms) p50,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) p95
         FROM ops.pipeline_runs WHERE created_at > now() - interval '${i}'`);
      const audio = await one(`SELECT count(*) n FROM ops.audio_events WHERE ts > now() - interval '${i}'`);
      const accounts = await one(`SELECT count(DISTINCT clinician_id) n FROM ops.pipeline_runs WHERE created_at > now() - interval '${i}'`);
      res.json({ range: req.query.range || '7d', ...runs, audio_events: Number(audio?.n || 0), accounts: Number(accounts?.n || 0) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  ops.get('/errors', async (req, res) => {
    try {
      const i = iv(req.query.range); const clauses = [`ts > now() - interval '${i}'`]; const args = [];
      if (req.query.source) { args.push(req.query.source); clauses.push(`source = $${args.length}`); }
      if (req.query.code)   { args.push(req.query.code);   clauses.push(`code = $${args.length}`); }
      if (req.query.clinician) { args.push(req.query.clinician); clauses.push(`clinician_id = $${args.length}`); }
      const rows = await query(
        `SELECT error_id, ts, source, agent, level, code, message, consult_id, clinician_id, context
         FROM ops.errors WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ${lim(req.query.limit)}`, args);
      res.json({ errors: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  ops.get('/error/:id', async (req, res) => {
    try { res.json({ error: await one('SELECT * FROM ops.errors WHERE error_id=$1', [req.params.id]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  ops.get('/runs', async (req, res) => {
    try {
      const i = iv(req.query.range); const clauses = [`created_at > now() - interval '${i}'`]; const args = [];
      if (req.query.status)    { args.push(req.query.status);    clauses.push(`status = $${args.length}`); }
      if (req.query.clinician) { args.push(req.query.clinician); clauses.push(`clinician_id = $${args.length}`); }
      const rows = await query(
        `SELECT run_id, consult_id, clinician_id, model, status, duration_ms, transcript_chars, note_chars,
                prompt_tokens, output_tokens, total_tokens, est_cost_usd, per_agent, timings, error_id, created_at
         FROM ops.pipeline_runs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ${lim(req.query.limit)}`, args);
      res.json({ runs: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // per-account tokens & cost (the headline view)
  ops.get('/accounts', async (req, res) => {
    try {
      const i = iv(req.query.range);
      const rows = await query(
        `SELECT r.clinician_id,
                coalesce(u.email, r.clinician_id) email,
                count(*) runs,
                count(*) FILTER (WHERE r.status='error') errors,
                coalesce(sum(r.prompt_tokens),0) prompt_tokens,
                coalesce(sum(r.output_tokens),0) output_tokens,
                coalesce(sum(r.total_tokens),0) total_tokens,
                coalesce(sum(r.est_cost_usd),0) cost_usd,
                round(avg(r.duration_ms)) avg_ms,
                max(r.created_at) last_active
         FROM ops.pipeline_runs r
         LEFT JOIN auth.users u ON u.id = r.clinician_id
         WHERE r.created_at > now() - interval '${i}'
         GROUP BY r.clinician_id, u.email
         ORDER BY total_tokens DESC LIMIT ${lim(req.query.limit)}`);
      res.json({ accounts: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  ops.get('/audio', async (req, res) => {
    try {
      const i = iv(req.query.range);
      const rows = await query(
        `SELECT ts, consult_id, clinician_id, reason, duration_ms, meta
         FROM ops.audio_events WHERE ts > now() - interval '${i}' ORDER BY ts DESC LIMIT ${lim(req.query.limit)}`);
      const by = await query(
        `SELECT reason, count(*) n FROM ops.audio_events WHERE ts > now() - interval '${i}' GROUP BY reason`);
      res.json({ events: rows, byReason: by });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.use('/api/ops', ops);
}
