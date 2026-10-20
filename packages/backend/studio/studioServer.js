// Notera Studio — API service (separate container "notera-studio", reached only through the studio Worker + Caddy at /studio/*).
// Purpose: doctor-centred evaluation, the review queue and "Teach Notera" for the training doctor, proposals for future style specs,
// evidence-linked review, edit learning, corpus cohorts, tuning export and the regression gate.
// It READS the product's notes and NEVER changes how notes are produced: the Style Spec v1 is locked (see docs/STYLE_SPEC_V1_LOCKED.md).
'use strict';

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, one, ensureStudioSchema, audit } from './db.js';
import { conformance, SPEC } from './conformance.js';
import { evaluateNote, RUBRIC, ERROR_TYPES } from './evaluator.js';
import { mapEvidence } from './evidence.js';
import { makeQuestions, answersToProposals } from './teach.js';
import { diffRendered, inferPreferences } from './editLearning.js';
import { buildIndex, cohortStats, poolIds, parseGold, GOLD_DIR, POOLS } from './corpus.js';
import { exportTuning } from './tuning.js';
import { runGate } from './gate.js';
import { pollOnce, processPending, captureFinals, seedReviewers, reviewerIds } from './ingest.js';
import { specLockState } from '../src/orchestrator/specLock.js';

const KEY = process.env.STUDIO_KEY || '';
const DATA = process.env.STUDIO_DATA_DIR || path.resolve(process.cwd(), '.studio-data');
fs.mkdirSync(DATA, { recursive: true });
const ok = (res, body) => res.json(body);
const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || d));
// Notes made before the approved format went live were not written to Style Spec v1: they are marked "legacy" and left out of the format statistics.
const SPEC_EFFECTIVE = String(process.env.STUDIO_SPEC_EFFECTIVE || '2026-10-20T00:00:00Z').replace(/[^0-9TZ:.+ -]/g, '');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'notera-studio' }));

// ── access: the Worker proves the session with the product API, then adds these headers with the shared key ──
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
app.use(async (req, res, next) => {
  if (!KEY || !same(req.headers['x-studio-key'] || '', KEY)) return res.status(401).json({ error: 'unauthorised' });
  const id = String(req.headers['x-studio-user'] || ''), role = String(req.headers['x-studio-role'] || ''); let name = ''; try { name = decodeURIComponent(String(req.headers['x-studio-name'] || '')); } catch { /* bad encoding */ }
  if (!id) return res.status(401).json({ error: 'no user' });
  try {
    await ensureStudioSchema();
    if (!name) { const u = await one(`SELECT full_name FROM auth.users WHERE id::text = $1`, [id]).catch(() => null); name = u?.full_name || ''; }
    if (role === 'admin') req.who = { id, name, access: 'owner' };
    else { const r = await one(`SELECT user_id FROM studio.reviewers WHERE user_id = $1 AND active`, [id]); if (!r) return res.status(403).json({ error: 'This account is not a Studio reviewer.' }); req.who = { id, name, access: 'reviewer' }; }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const owner = (req, res, next) => (req.who.access === 'owner' ? next() : res.status(403).json({ error: 'owner only' }));
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[studio]', req.method, req.path, e.message); res.status(e.status || 500).json({ error: e.message }); } };
const visible = (who) => (who.access === 'owner' ? { sql: 'TRUE', args: [] } : { sql: '(assigned_to = $1 OR clinician_id = $1)', args: [who.id] });
async function getItem(req) {
  const v = visible(req.who); const it = await one(`SELECT * FROM studio.review_items WHERE id = $${v.args.length + 1} AND ${v.sql}`, [...v.args, Number(req.params.id)]);
  if (!it) { const e = new Error('not found'); e.status = 404; throw e; } return it;
}

app.get('/me', wrap(async (req, res) => ok(res, { ...req.who, effective: SPEC_EFFECTIVE, spec: { version: SPEC.version, ...(await specLockState()) } })));
app.get('/spec', wrap(async (req, res) => ok(res, { spec: SPEC, lock: await specLockState(), rubric: RUBRIC, error_types: ERROR_TYPES })));

// ── queue and review ──
app.get('/queue', wrap(async (req, res) => {
  const v = visible(req.who); const st = ['new', 'reviewed'].includes(req.query.status) ? req.query.status : null;
  const rows = await query(`SELECT i.id, i.title, i.source, i.status, i.created_at, i.queued_at, i.assigned_to, (i.created_at < '${SPEC_EFFECTIVE}'::timestamptz) AS legacy, (i.conformance->>'score')::float AS conformance, i.auto_eval->>'overall' AS auto_overall,
      i.auto_eval->>'major_errors' AS auto_major, (i.evaluated_at IS NOT NULL) AS evaluated, (SELECT count(*) FROM studio.proposals p WHERE p.item_id = i.id) AS proposals,
      (SELECT overall FROM studio.reviews r WHERE r.item_id = i.id ORDER BY updated_at DESC LIMIT 1) AS doctor_overall
    FROM studio.review_items i WHERE ${v.sql} ${st ? `AND i.status = '${st}'` : ''} ORDER BY i.queued_at DESC LIMIT 200`, v.args);
  ok(res, { items: rows });
}));
app.get('/items/:id', wrap(async (req, res) => {
  const it = await getItem(req);
  const review = await one(`SELECT * FROM studio.reviews WHERE item_id = $1 AND reviewer_id = $2`, [it.id, req.who.id]);
  const teach = await query(`SELECT id, questions, answers, status, created_at, answered_at FROM studio.teach_sessions WHERE item_id = $1 AND reviewer_id = $2 ORDER BY id DESC LIMIT 3`, [it.id, req.who.id]);
  const proposals = await query(`SELECT id, source, section, title, detail, status, created_at FROM studio.proposals WHERE item_id = $1 ORDER BY id DESC`, [it.id]);
  await audit(req.who.id, 'item_view', { item: it.id });
  ok(res, { item: { ...it, note: undefined }, review, teach, proposals, rubric: RUBRIC, error_types: ERROR_TYPES });
}));
app.post('/items/:id/evaluate', wrap(async (req, res) => {
  const it = await getItem(req);
  const conf = conformance(it.rendered); let auto, ev;
  try { auto = await evaluateNote({ transcript: it.transcript, rendered: it.rendered }); } catch (e) { auto = { error: e.message }; }
  try { ev = await mapEvidence({ transcript: it.transcript, rendered: it.rendered }); } catch (e) { ev = { error: e.message }; }
  await query(`UPDATE studio.review_items SET conformance = $2::jsonb, auto_eval = $3::jsonb, evidence = $4::jsonb, evaluated_at = now() WHERE id = $1`, [it.id, JSON.stringify(conf), JSON.stringify(auto), JSON.stringify(ev)]);
  ok(res, { conformance: conf, auto_eval: auto, evidence: ev });
}));
app.post('/items/:id/review', wrap(async (req, res) => {
  const it = await getItem(req); const b = req.body || {};
  const ratings = {}; for (const r of RUBRIC) { const v = Number(b.ratings?.[r.id]); if (Number.isFinite(v) && v >= 1 && v <= 5) ratings[r.id] = Math.round(v); }
  const errors = (Array.isArray(b.errors) ? b.errors : []).slice(0, 40).map((e) => ({ kind: e.kind === 'omission' ? 'omission' : 'hallucination', subtype: String(e.subtype || '').slice(0, 30), severity: e.severity === 'major' ? 'major' : 'minor', section: String(e.section || '').slice(0, 40), text: String(e.text || '').slice(0, 400), comment: String(e.comment || '').slice(0, 400) }));
  const edited = typeof b.edited_text === 'string' && b.edited_text.trim() && b.edited_text.trim() !== String(it.rendered).trim() ? b.edited_text.slice(0, 40000) : null;
  const diff = edited ? diffRendered(it.rendered, edited) : null;
  const overall = Number.isFinite(Number(b.overall)) ? num(b.overall, 3, 1, 5) : null;
  const row = await one(`INSERT INTO studio.reviews (item_id, reviewer_id, ratings, overall, would_sign, errors, comment, edited_text, edit_diff)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9::jsonb)
      ON CONFLICT (item_id, reviewer_id) DO UPDATE SET ratings = EXCLUDED.ratings, overall = EXCLUDED.overall, would_sign = EXCLUDED.would_sign, errors = EXCLUDED.errors, comment = EXCLUDED.comment,
        edited_text = EXCLUDED.edited_text, edit_diff = EXCLUDED.edit_diff, updated_at = now() RETURNING id, updated_at`,
    [it.id, req.who.id, JSON.stringify(ratings), overall, typeof b.would_sign === 'boolean' ? b.would_sign : null, JSON.stringify(errors), String(b.comment || '').slice(0, 3000), edited, diff ? JSON.stringify(diff) : null]);
  await query(`UPDATE studio.review_items SET status = 'reviewed' WHERE id = $1`, [it.id]);
  // the doctor's free-text suggestion becomes a proposal as she wrote it; her edits become inferred preference proposals
  const c = String(b.comment || '').trim();
  if (c.length >= 12 && c !== String(b.prev_comment || '').trim()) await query(`INSERT INTO studio.proposals (source, item_id, reviewer_id, section, title, detail, change) VALUES ('doctor-comment', $1, $2, 'Overall', $3, $4, $5::jsonb)`, [it.id, req.who.id, c.slice(0, 120), c, JSON.stringify({ rule: c })]);
  let inferred = 0;
  if (diff && diff.edit_rate > 0) { try { const props = await inferPreferences({ diff }); for (const p of props) { await query(`INSERT INTO studio.proposals (source, item_id, reviewer_id, section, title, detail, change) VALUES ('edit', $1, $2, $3, $4, $5, $6::jsonb)`, [it.id, req.who.id, p.section, p.title, p.because, JSON.stringify(p)]); inferred++; } } catch (e) { console.warn('[studio] edit inference failed:', e.message); } }
  await audit(req.who.id, 'review_save', { item: it.id, overall, edited: !!edited });
  ok(res, { ok: true, review: row, edit_diff: diff, inferred_proposals: inferred });
}));

// ── Teach Notera ──
app.post('/items/:id/teach', wrap(async (req, res) => {
  const it = await getItem(req);
  const open = await one(`SELECT id, questions FROM studio.teach_sessions WHERE item_id = $1 AND reviewer_id = $2 AND status = 'open' ORDER BY id DESC LIMIT 1`, [it.id, req.who.id]);
  if (open && !req.body?.fresh) return ok(res, { id: open.id, questions: open.questions });
  const questions = await makeQuestions({ transcript: it.transcript, rendered: it.rendered, conformance: it.conformance });
  const row = await one(`INSERT INTO studio.teach_sessions (item_id, reviewer_id, questions) VALUES ($1, $2, $3::jsonb) RETURNING id`, [it.id, req.who.id, JSON.stringify(questions)]);
  ok(res, { id: row.id, questions });
}));
app.post('/teach/:id/answer', wrap(async (req, res) => {
  const s = await one(`SELECT t.*, i.assigned_to, i.clinician_id FROM studio.teach_sessions t JOIN studio.review_items i ON i.id = t.item_id WHERE t.id = $1`, [Number(req.params.id)]);
  if (!s || (req.who.access !== 'owner' && s.reviewer_id !== req.who.id)) return res.status(404).json({ error: 'not found' });
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const props = await answersToProposals({ questions: s.questions, answers });
  for (const p of props) await query(`INSERT INTO studio.proposals (source, item_id, reviewer_id, section, title, detail, change) VALUES ('teach', $1, $2, $3, $4, $5, $6::jsonb)`, [s.item_id, req.who.id, p.section, p.title, p.because, JSON.stringify(p)]);
  await query(`UPDATE studio.teach_sessions SET answers = $2::jsonb, status = 'answered', answered_at = now() WHERE id = $1`, [s.id, JSON.stringify(answers)]);
  await audit(req.who.id, 'teach_answer', { session: s.id, proposals: props.length });
  ok(res, { ok: true, proposals: props });
}));

// ── proposals (nothing here is ever applied to production: the Style Spec is locked) ──
app.get('/proposals', wrap(async (req, res) => {
  const st = ['pending', 'accepted', 'rejected', 'parked'].includes(req.query.status) ? req.query.status : null;
  const mine = req.who.access === 'owner' ? '' : ' AND reviewer_id = $2';
  const rows = await query(`SELECT id, source, item_id, reviewer_id, section, title, detail, change, status, decided_by, decided_at, decision_note, created_at FROM studio.proposals WHERE ($1::text IS NULL OR status = $1) ${mine} ORDER BY id DESC LIMIT 300`, req.who.access === 'owner' ? [st] : [st, req.who.id]);
  ok(res, { proposals: rows, note: 'Proposals are recorded for a future spec version. The approved Style Spec v1 is locked and is not changed by them.' });
}));
app.post('/proposals/:id/decide', owner, wrap(async (req, res) => {
  const st = String(req.body?.status || ''); if (!['accepted', 'rejected', 'parked', 'pending'].includes(st)) return res.status(400).json({ error: 'bad status' });
  const row = await one(`UPDATE studio.proposals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING id, status`, [Number(req.params.id), st, req.who.id, String(req.body?.note || '').slice(0, 400)]);
  if (!row) return res.status(404).json({ error: 'not found' }); await audit(req.who.id, 'proposal_decide', { id: row.id, status: st }); ok(res, row);
}));

// ── reviewers and seeding training cases (owner) ──
app.get('/reviewers', owner, wrap(async (req, res) => ok(res, { reviewers: await query(`SELECT user_id, full_name, active, added_at FROM studio.reviewers ORDER BY added_at`) })));
app.post('/reviewers', owner, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim(); const u = email ? await one(`SELECT id::text AS id, full_name FROM auth.users WHERE email = $1 AND is_active`, [email]) : null;
  if (!u) return res.status(404).json({ error: 'no active account with that email' });
  await query(`INSERT INTO studio.reviewers (user_id, full_name, added_by) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET active = true`, [u.id, u.full_name, req.who.id]);
  await audit(req.who.id, 'reviewer_add', { user: u.id }); ok(res, { ok: true, user_id: u.id, full_name: u.full_name });
}));
app.delete('/reviewers/:id', owner, wrap(async (req, res) => { await query(`UPDATE studio.reviewers SET active = false WHERE user_id = $1`, [req.params.id]); ok(res, { ok: true }); }));
app.post('/items/seed', owner, wrap(async (req, res) => {
  let transcript = String(req.body?.transcript || ''), title = String(req.body?.title || '');
  if (!transcript && req.body?.fixture) { const f = path.join(GOLD_DIR(), String(req.body.fixture).replace(/[^A-Za-z0-9._-]/g, '') + '.txt'); const g = fs.existsSync(f) ? parseGold(fs.readFileSync(f, 'utf8')) : null; if (g) { transcript = g.transcript; title = title || `Training case: ${req.body.fixture}`; } }
  if (transcript.length < 200) return res.status(400).json({ error: 'give a transcript (200+ characters) or a gold fixture id' });
  const assignTo = String(req.body?.assign_to || (await reviewerIds())[0] || ''); if (!assignTo) return res.status(400).json({ error: 'no reviewer to assign to' });
  const { generateNote } = await import('../src/orchestrator/generateNote.js');
  const r = await generateNote({ transcript: transcript.slice(0, 120000), specialty: 'auto', noteType: 'consultation', clinicianId: 'studio-seed' }, { persist: false, mode: 'v2' });
  const rendered = r.renderedNote || ''; const conf = conformance(rendered);
  const cid = `STUDIO-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const row = await one(`INSERT INTO studio.review_items (consult_id, draft_id, clinician_id, assigned_to, source, title, transcript, note, rendered, conformance) VALUES ($1, $1, 'studio-seed', $2, 'training', $3, $4, $5::jsonb, $6, $7::jsonb) RETURNING id`,
    [cid, assignTo, title || 'Training case', transcript, JSON.stringify(r.note || {}), rendered, JSON.stringify(conf)]);
  await audit(req.who.id, 'seed_case', { item: row.id, assignTo }); ok(res, { ok: true, id: row.id, conformance: conf.score });
}));

// ── dashboard ──
app.get('/dashboard', owner, wrap(async (req, res) => {
  const t = await one(`SELECT count(*)::int AS items, count(*) FILTER (WHERE status = 'reviewed')::int AS reviewed, count(*) FILTER (WHERE evaluated_at IS NOT NULL)::int AS evaluated,
      avg((conformance->>'score')::float) FILTER (WHERE created_at >= '${SPEC_EFFECTIVE}'::timestamptz) AS conformance_since_spec, count(*) FILTER (WHERE created_at >= '${SPEC_EFFECTIVE}'::timestamptz)::int AS since_spec,
      avg(NULLIF(auto_eval->>'overall', '')::float) AS judge_overall, avg(NULLIF(auto_eval->>'major_errors', '')::float) AS judge_major FROM studio.review_items`);
  const rv = await one(`SELECT count(*)::int AS reviews, avg(overall) AS doctor_overall, avg(CASE WHEN would_sign THEN 1 ELSE 0 END) AS would_sign,
      avg((edit_diff->>'edit_rate')::float) AS edit_rate, avg(jsonb_array_length(coalesce(errors, '[]'::jsonb)))::float AS doctor_errors FROM studio.reviews`);
  const ag = await query(`SELECT NULLIF(i.auto_eval->>'overall', '')::float AS j, r.overall AS d FROM studio.reviews r JOIN studio.review_items i ON i.id = r.item_id WHERE r.overall IS NOT NULL AND i.auto_eval ? 'overall'`);
  const within1 = ag.length ? ag.filter((x) => Math.abs(x.j - x.d) <= 1).length / ag.length : null;
  const pr = await query(`SELECT status, count(*)::int AS n FROM studio.proposals GROUP BY status`);
  const byRule = await query(`SELECT f->>'rule' AS rule, count(*)::int AS n FROM studio.review_items i, jsonb_array_elements(coalesce(i.conformance->'failed', '[]'::jsonb)) f WHERE i.created_at >= '${SPEC_EFFECTIVE}'::timestamptz GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
  ok(res, { items: t, reviews: rv, judge_vs_doctor: { paired: ag.length, within_1_point: within1 }, proposals: Object.fromEntries(pr.map((p) => [p.status, p.n])), top_failed_rules: byRule, spec: { version: SPEC.version, ...(await specLockState()) } });
}));

// ── corpus, tuning export, regression gate (owner) ──
let _idx = null;
const index = () => (_idx ||= buildIndex());
app.get('/corpus', owner, wrap(async (req, res) => ok(res, { stats: cohortStats(index()), pools: Object.keys(POOLS), caution: 'Analysis only. The locked Style Spec v1 is not trained or tuned from this index.' })));
app.get('/corpus/pool/:name', owner, wrap(async (req, res) => ok(res, { name: req.params.name, ids: poolIds(index(), req.params.name) })));
app.post('/tuning/export', owner, wrap(async (req, res) => { const pool = String(req.body?.pool || 'recent_style'); ok(res, exportTuning({ pool, outDir: path.join(DATA, 'tuning') })); }));
app.get('/tuning/files', owner, wrap(async (req, res) => { const d = path.join(DATA, 'tuning'); ok(res, { files: fs.existsSync(d) ? fs.readdirSync(d).map((f) => ({ name: f, bytes: fs.statSync(path.join(d, f)).size })) : [] }); }));
app.get('/tuning/file/:name', owner, wrap(async (req, res) => { const f = path.join(DATA, 'tuning', path.basename(req.params.name)); if (!fs.existsSync(f)) return res.status(404).json({ error: 'not found' }); res.download(f); }));
app.post('/gate/run', owner, wrap(async (req, res) => {
  const n = num(req.body?.n, 20, 1, 100); const ids = poolIds(index(), 'recent_style').filter((x) => x.split === 'test').slice(0, n);
  const items = ids.map(({ id }) => ({ id, transcript: parseGold(fs.readFileSync(path.join(GOLD_DIR(), id + '.txt'), 'utf8')).transcript }));
  const row = await one(`INSERT INTO studio.gate_runs (n, started_by) VALUES ($1, $2) RETURNING id`, [items.length, req.who.id]);
  ok(res, { id: row.id, n: items.length });
  runGate({ items, concurrency: 2, onProgress: (d) => query(`UPDATE studio.gate_runs SET done = $2 WHERE id = $1`, [row.id, d]).catch(() => {}) })
    .then((r) => query(`UPDATE studio.gate_runs SET status = 'done', finished_at = now(), summary = $2::jsonb, rows = $3::jsonb WHERE id = $1`, [row.id, JSON.stringify(r.summary), JSON.stringify(r.rows)]))
    .catch((e) => query(`UPDATE studio.gate_runs SET status = 'error', finished_at = now(), summary = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify({ error: e.message })]).catch(() => {}));
}));
app.get('/gate/runs', owner, wrap(async (req, res) => ok(res, { runs: await query(`SELECT id, status, n, done, started_at, finished_at, summary FROM studio.gate_runs ORDER BY id DESC LIMIT 20`) })));
app.post('/ingest/run', owner, wrap(async (req, res) => { const added = await pollOnce(); const edits = await captureFinals(); ok(res, { added, edits_captured: edits }); }));

export { app };

// ── start ──
if (process.argv[1] && process.argv[1].endsWith('studioServer.js')) {
  const PORT = Number(process.env.PORT) || 8080;
  await ensureStudioSchema();
  await query(`INSERT INTO studio.spec_versions (version, status, title, spec, created_by) VALUES ($1, 'locked', $2, $3::jsonb, 'owner') ON CONFLICT (version) DO NOTHING`, [SPEC.version, SPEC.title, JSON.stringify(SPEC)]);
  await seedReviewers().catch((e) => console.warn('[studio] reviewer seed:', e.message));
  const tick = async () => { try { await pollOnce(); await processPending(); await captureFinals(); } catch (e) { console.warn('[studio] tick:', e.message); } };
  setInterval(tick, Number(process.env.STUDIO_POLL_MS) || 60000); setTimeout(tick, 3000);
  app.listen(PORT, () => console.log(`[studio] listening on ${PORT}${KEY ? '' : ' — STUDIO_KEY missing, every request will be refused'}`));
}
