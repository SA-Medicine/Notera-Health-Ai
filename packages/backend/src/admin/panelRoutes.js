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
import { listVersions, getVersion, promote, activate, resetToDefault, getActivePromptMeta } from '../orchestrator/promptStore.js';
import { WRITER_PROMPT_NAME, PROMPT_REGISTRY } from '../orchestrator/generateNoteV2.js';
import { describeConfig, setConfig, resetConfig, configHistory, effectiveConfig, REGISTRY as CONFIG_REGISTRY } from '../orchestrator/runtimeConfig.js';

const lim = (n, d = 100, max = 500) => Math.min(Math.max(1, Number(n) || d), max);
const BUCKET = () => process.env.GCS_AUDIO_BUCKET || '';
const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.ip || '');

// SQL kept as constants so a test can EXPLAIN every statement against the real schema.
export const SQL = {
  liveDaily: `
    SELECT date_trunc('day', created_at)::date AS day, count(*) AS runs, count(*) FILTER (WHERE status IN ('ok','success','ready','done')) AS ok,
           count(*) FILTER (WHERE status NOT IN ('ok','success','ready','done')) AS failed,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS p50_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms,
           coalesce(sum(est_cost_usd), 0)::float AS cost_usd, coalesce(sum(total_tokens), 0)::bigint AS tokens
      FROM ops.pipeline_runs WHERE created_at > now() - ($1::int || ' days')::interval GROUP BY 1 ORDER BY 1`,
  liveByModel: `
    SELECT coalesce(model, 'unknown') AS model, count(*) AS runs, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS p50_ms,
           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms, coalesce(sum(est_cost_usd), 0)::float AS cost_usd,
           count(*) FILTER (WHERE status NOT IN ('ok','success','ready','done')) AS failed
      FROM ops.pipeline_runs WHERE created_at > now() - ($1::int || ' days')::interval GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
  liveErrors: `
    SELECT coalesce(source, '') AS source, coalesce(agent, '') AS agent, coalesce(code, '') AS code, count(*) AS n, max(ts) AS last
      FROM ops.errors WHERE ts > now() - ($1::int || ' days')::interval GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 15`,
  liveSignups: `SELECT date_trunc('day', created_at)::date AS day, count(*) AS n FROM auth.users WHERE created_at > now() - ($1::int || ' days')::interval GROUP BY 1 ORDER BY 1`,
  liveNotes: `SELECT date_trunc('day', created_at)::date AS day, count(*) AS n FROM clinical.consults WHERE created_at > now() - ($1::int || ' days')::interval GROUP BY 1 ORDER BY 1`,
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

  // ── prompts: every LLM prompt in the pipeline (writer, checklist, verifier) — list / read / promote / activate / reset ──
  const jsonBody = express.json({ limit: '300kb' });
  const pname = (v) => { const n = String(v || WRITER_PROMPT_NAME); return PROMPT_REGISTRY[n] ? n : null; };
  const checkPrompt = (name, t) => {
    const reg = PROMPT_REGISTRY[name];
    if (t.length < reg.min || t.length > 60000) return `prompt must be ${reg.min}–60,000 characters`;
    const miss = reg.must.filter((m) => !new RegExp(m, 'i').test(t));
    if (miss.length) return `prompt must keep: ${miss.join(', ')} (the pipeline's parser depends on it)`;
    if (name === WRITER_PROMPT_NAME && !/STRICT JSON|schema/i.test(t)) return 'prompt must keep the strict-JSON/schema instruction';
    return null;
  };
  // registry: one row per prompt with what is live right now
  R.get('/prompts/registry', r(async (req, res) => {
    const out = [];
    for (const [name, reg] of Object.entries(PROMPT_REGISTRY)) {
      const meta = await getActivePromptMeta(name); const versions = await listVersions(name);
      out.push({ name, stage: reg.stage, label: reg.label, help: reg.help, default_chars: reg.default().length, live: meta ? `v${meta.version}` : 'default', live_chars: (meta?.text || reg.default()).length, versions: versions.length, last_change: versions[0]?.created_at || null, must: reg.must });
    }
    res.json({ prompts: out });
  }));
  R.get('/prompts', r(async (req, res) => {
    const name = pname(req.query.name); if (!name) return res.status(400).json({ error: 'unknown prompt' });
    const meta = await getActivePromptMeta(name);
    res.json({ name, versions: await listVersions(name), using_default: !meta, default_chars: PROMPT_REGISTRY[name].default().length });
  }));
  R.get('/prompts/default', r(async (req, res) => { const name = pname(req.query.name); if (!name) return res.status(400).json({ error: 'unknown prompt' }); res.json({ name, text: PROMPT_REGISTRY[name].default() }); }));
  // what the pipeline will use for the very next note — proves an edit took effect
  R.get('/prompts/active', r(async (req, res) => { const name = pname(req.query.name); if (!name) return res.status(400).json({ error: 'unknown prompt' }); const m = await getActivePromptMeta(name); res.json({ name, text: m?.text || PROMPT_REGISTRY[name].default(), using_default: !m, version: m?.version || null, id: m?.id || null }); }));
  R.get('/prompts/:id(\\d+)', r(async (req, res) => { const v = await getVersion(Number(req.params.id)); v ? res.json({ version: v }) : res.status(404).json({ error: 'not found' }); }));
  R.post('/prompts/promote', jsonBody, r(async (req, res) => {
    const { text, note, evalSummary } = req.body || {}; const name = pname(req.body?.name); if (!name) return res.status(400).json({ error: 'unknown prompt' });
    const t = String(text || ''); const bad = checkPrompt(name, t); if (bad) return res.status(400).json({ error: bad });
    const row = await promote(name, t, { note: String(note || '').slice(0, 300), by: req.user.email, evalSummary });
    await audit(req.user.id, 'prompt_promote', { name, version: row.version, chars: t.length }, ipOf(req));
    res.json({ ok: true, name, ...row });
  }));
  R.post('/prompts/:id(\\d+)/activate', r(async (req, res) => {
    const row = await activate(Number(req.params.id)); if (!row) return res.status(404).json({ error: 'not found' });
    await audit(req.user.id, 'prompt_activate', { id: row.id, name: row.name }, ipOf(req)); res.json({ ok: true });
  }));
  R.post('/prompts/reset-default', jsonBody, r(async (req, res) => { const name = pname(req.body?.name); if (!name) return res.status(400).json({ error: 'unknown prompt' }); await resetToDefault(name); await audit(req.user.id, 'prompt_reset_default', { name }, ipOf(req)); res.json({ ok: true }); }));

  // ── runtime config: models, sampling, timeouts, verifier — editable, validated, audited, with change history ──
  R.get('/config', r(async (req, res) => res.json({ settings: await describeConfig() })));
  R.get('/config/history', r(async (req, res) => res.json({ history: await configHistory(lim(req.query.limit, 60, 200)) })));
  R.put('/config/:key', jsonBody, r(async (req, res) => {
    const key = req.params.key; if (!CONFIG_REGISTRY[key]) return res.status(404).json({ error: 'unknown setting' });
    try { const v = await setConfig(key, req.body?.value, { by: req.user.email, reason: req.body?.reason }); await audit(req.user.id, 'config_set', { key, value: v }, ipOf(req)); res.json({ ok: true, key, value: v }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  }));
  R.delete('/config/:key', r(async (req, res) => {
    if (!CONFIG_REGISTRY[req.params.key]) return res.status(404).json({ error: 'unknown setting' });
    const did = await resetConfig(req.params.key, { by: req.user.email }); await audit(req.user.id, 'config_reset', { key: req.params.key }, ipOf(req)); res.json({ ok: true, changed: did });
  }));

  // ── system map: every stage of the pipeline, what runs it, and what is live right now ──
  R.get('/system', r(async (req, res) => {
    const cfg = await effectiveConfig(); const pm = {};
    for (const name of Object.keys(PROMPT_REGISTRY)) { const m = await getActivePromptMeta(name); pm[name] = m ? `v${m.version}` : 'default'; }
    const stages = [
      { id: 'capture', label: 'Audio capture', kind: 'client', detail: 'The browser records the consultation and uploads audio in chunks.' },
      { id: 'asr', label: 'Speech to text', kind: 'model', detail: 'Chunked transcription.', model: process.env.ASR_MODEL || null },
      { id: 'classify', label: 'Encounter classifier', kind: 'code', detail: 'Deterministic specialty and blank-encounter detection.' },
      { id: 'writer', label: 'Note writer', kind: 'llm', prompt: 'v2-writer', prompt_live: pm['v2-writer'], model: cfg['writer.model'], fallback: cfg['writer.fallbackModel'], params: { temperature: cfg['writer.temperature'], topP: cfg['writer.topP'], thinking: cfg['writer.thinkingBudget'], maxTokens: cfg['writer.maxOutputTokens'], timeoutMs: cfg['writer.timeoutMs'], hedgeMs: cfg['writer.hedgeMs'] } },
      { id: 'editor', label: 'Editor pass (optional reviewer)', kind: 'llm', prompt: 'v2-editor', prompt_live: pm['v2-editor'], model: cfg['editor.model'], enabled: cfg['editor.enabled'], params: { timeoutMs: cfg['editor.timeoutMs'] }, detail: 'Fixes section placement, plan attribution, contradictions and padding in the draft. Code rejects any edit that loses or invents facts.' },
      { id: 'checklist', label: 'Fact checklist (parallel)', kind: 'llm', prompt: 'v2-checklist', prompt_live: pm['v2-checklist'], model: cfg['aux.model'] },
      { id: 'merge', label: 'Checklist merge', kind: 'code', detail: 'Adds any medication, result, order or referral the writer dropped.' },
      { id: 'reconcile', label: 'Placement fixes', kind: 'code', detail: 'Moves facts to the right section; removes commentary and duplicates.' },
      { id: 'verifier', label: 'Fact verifier', kind: 'llm', prompt: 'v2-verifier', prompt_live: pm['v2-verifier'], model: cfg['aux.model'], enabled: cfg['verifier.enabled'], params: { timeoutMs: cfg['verifier.timeoutMs'] }, detail: 'The model proposes, code confirms before any line is removed.' },
      { id: 'guardrails', label: 'Guardrails and condense', kind: 'code', detail: 'Deterministic safety flags (dose, laterality, negation), length condensing, de-duplication.' },
      { id: 'render', label: 'Render and store', kind: 'code', detail: 'SOAP markdown and structured JSON saved to the consult.' },
    ];
    const mem = process.memoryUsage();
    let db = true; try { await one('SELECT 1 AS ok'); } catch { db = false; }
    res.json({ stages, runtime: { pipeline: process.env.PIPELINE_MODE || 'v2', backend: process.env.LLM_BACKEND || 'vertex', region: process.env.VERTEX_LOCATION || 'global', node: process.version, uptime_s: Math.round(process.uptime()), rss_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576), db_ok: db, audio_bucket: !!BUCKET() } });
  }));

  // ── live production metrics (real clinician notes): volume, latency, failures, cost, errors ──
  R.get('/live', r(async (req, res) => {
    const days = lim(req.query.days, 14, 90);
    const safe = async (q, p) => { try { return await query(q, p); } catch { return []; } };
    const [daily, byModel, errors, signups, notes] = await Promise.all([safe(SQL.liveDaily, [days]), safe(SQL.liveByModel, [days]), safe(SQL.liveErrors, [days]), safe(SQL.liveSignups, [days]), safe(SQL.liveNotes, [days])]);
    const tot = daily.reduce((a, d) => ({ runs: a.runs + Number(d.runs), failed: a.failed + Number(d.failed), cost: a.cost + Number(d.cost_usd) }), { runs: 0, failed: 0, cost: 0 });
    res.json({ days, daily, by_model: byModel, errors, signups, notes, totals: { runs: tot.runs, failed: tot.failed, fail_rate: tot.runs ? tot.failed / tot.runs : 0, cost_usd: tot.cost } });
  }));

  app.use('/api/console', R);
}
