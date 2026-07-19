// ─────────────────────────────────────────────────────────────────────────────
// Admin / Testing-Lab request handler — mounted by the unified Express backend
// (packages/backend/server.js) for the admin API prefixes. Not a standalone server.
//   • spawns `node eval/run_eval.mjs [fixtures]`, streams stdout/stderr over SSE
//   • persists run history to admin/data/runs.json
//   • serves results (rendered md + raw + diff) and metrics from eval/results/*
//   • prompt registry (view/edit/version/publish) + sessions + editable judge + lab APIs
//   • simple single-admin password/session (ADMIN_PASSWORD, default "notera")
// Reached in the browser at /admin (Next app) via the /backend/* proxy.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../..');

// .env loader (no dependency) — same rules as eval/run_eval.mjs so the admin process
// (Comparison & scores, judge) sees GEMINI_API_KEY etc. Strips stray CR from CRLF files
// and overrides undefined OR empty existing values.
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) {
        const v = m[2].replace(/^["']|["']$/g, '').replace(/[\r\n]+$/, '').trim();
        if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
      }
    }
  } catch { /* no .env */ }
})();

const RESULTS = path.join(ROOT, 'eval', 'results');
const GOLD = path.join(ROOT, 'data', 'gold');
const DATA = path.join(ROOT, 'admin', 'data');
const LOGDIR = path.join(DATA, 'logs');
const RUNS_DB = path.join(DATA, 'runs.json');
const PROMPTS = path.join(__dirname, '..', '..', 'prompts', 'store');
const SESSIONS = path.join(DATA, 'sessions');
const PORT = Number(process.env.ADMIN_PORT) || 4300;
const PASSWORD = process.env.ADMIN_PASSWORD || 'notera';
const PROMPTS_READONLY = process.env.ADMIN_PROMPTS_READONLY === '1';
fs.mkdirSync(LOGDIR, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });

// ── tiny state ───────────────────────────────────────────────────────────────
const sessions = new Set();
const runs = new Map();
loadRuns();

function loadRuns() {
  try {
    const arr = JSON.parse(fs.readFileSync(RUNS_DB, 'utf8'));
    for (const r of arr) runs.set(r.id, { ...r, status: r.status === 'running' ? 'interrupted' : r.status, lines: [], listeners: new Set(), proc: null });
  } catch { /* fresh */ }
}
function persistRuns() {
  const arr = [...runs.values()].map(({ proc, listeners, lines, ...r }) => r).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  try { fs.writeFileSync(RUNS_DB, JSON.stringify(arr.slice(0, 200), null, 2)); } catch {}
}

// ── helpers ──────────────────────────────────────────────────────────────────
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9_.\- ]/g, '');
const safeRunDir = (s) => { const n = safeName(s); return /^run_/.test(n) ? n : null; };
function parseCookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }); return out; }
function authed(req) { return sessions.has(parseCookies(req).notera_admin); }
// Body reader. Buffers chunks (not string concat) and, when the limit is hit, answers
// with a real 413 instead of destroying the socket — a silent destroy surfaces to the
// caller/proxy as an opaque `write ECONNRESET`.
const MAX_BODY_MB = Number(process.env.ADMIN_MAX_BODY_MB || 512);
const MAX_BODY = MAX_BODY_MB * 1024 * 1024;
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (d) => {
      if (done) return;
      size += d.length;
      if (size > MAX_BODY) {
        if (res && !res.headersSent) json(res, 413, { ok: false, error: `Upload too large (over ${MAX_BODY_MB} MB). Split the file, or raise ADMIN_MAX_BODY_MB.` });
        finish({ __tooLarge: true });
        setTimeout(() => { try { req.destroy(); } catch {} }, 50);   // let the 413 flush first
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); finish(s ? JSON.parse(s) : {}); } catch (e) { finish({ __badJson: e.message }); } });
    req.on('error', () => finish({}));
  });
}

// ── lazy Testing-Lab DB access (pg) ───────────────────────────────────────────
// Loaded only when a /api/patients|lab|metrics route is hit, so the zero-dependency
// server still boots when Postgres / the pg package is absent.
let _lab = null, _labErr = null;
async function getLab() {
  if (_lab) return _lab;
  if (_labErr) throw _labErr;
  try { _lab = await import(pathToFileURL(path.join(__dirname, '..', 'db', 'labStore.js')).href); return _lab; }
  catch (e) { _labErr = e; throw e; }
}
const labHint = 'Testing Lab DB not reachable. Start Postgres (npm run db:up), run npm run db:reset, and set DATABASE_URL in .env.';

// ── run spawning ────────────────────────────────────────────────────────────
function startRun(fixtures = []) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
  const args = [(process.env.ADMIN_EVAL_ENTRY||'eval/run_eval.mjs'), ...fixtures.filter(Boolean).map(safeName)];
  const command = 'node ' + args.join(' ');
  const rec = { id, command, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, resultDir: null, lines: [], listeners: new Set(), proc: null };
  runs.set(id, rec);
  const logStream = fs.createWriteStream(path.join(LOGDIR, id + '.log'), { flags: 'a' });
  const proc = spawn('node', args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '1' } });
  rec.proc = proc;
  const push = (chunk, stream) => {
    const text = chunk.toString();
    logStream.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (line === '' ) continue;
      rec.lines.push({ t: Date.now(), stream, line });
      if (rec.lines.length > 5000) rec.lines.shift();
      const m = line.match(/run_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
      if (m && !rec.resultDir) rec.resultDir = 'run_' + m[1];
      for (const l of rec.listeners) l({ type: 'line', stream, line });
    }
  };
  proc.stdout.on('data', (d) => push(d, 'out'));
  proc.stderr.on('data', (d) => push(d, 'err'));
  proc.on('close', (code) => {
    rec.status = code === 0 ? 'passed' : 'failed'; rec.exitCode = code; rec.finishedAt = new Date().toISOString(); rec.proc = null;
    logStream.end();
    for (const l of rec.listeners) l({ type: 'status', status: rec.status, exitCode: code, resultDir: rec.resultDir });
    persistRuns();
  });
  proc.on('error', (e) => { rec.status = 'error'; rec.finishedAt = new Date().toISOString(); rec.proc = null; for (const l of rec.listeners) l({ type: 'status', status: 'error', message: e.message }); persistRuns(); });
  persistRuns();
  return id;
}

// ── results / metrics readers ─────────────────────────────────────────────────
function listResultRuns() {
  let dirs = [];
  try { dirs = fs.readdirSync(RESULTS).filter((d) => /^run_/.test(d) && fs.statSync(path.join(RESULTS, d)).isDirectory()); } catch {}
  return dirs.sort().reverse().map((dir) => {
    let summary = null; try { summary = JSON.parse(fs.readFileSync(path.join(RESULTS, dir, '_summary.json'), 'utf8')).summary; } catch {}
    return { dir, id: dir.replace(/^run_/, ''), summary };
  });
}
function listFixtures() {
  try { return fs.readdirSync(GOLD).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')).sort(); } catch { return []; }
}
function runFiles(dir) {
  const d = path.join(RESULTS, dir); let files = [];
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.md')); } catch {}
  return files.sort().map((f) => {
    const base = f.replace(/\.md$/, ''); let score = null;
    try { score = JSON.parse(fs.readFileSync(path.join(d, base + '.json'), 'utf8')).score; } catch {}
    return { file: f, fixture: base, passed: score ? (score.status !== 'FLAGGED' && score.status !== 'INVALID' && score.schema_valid !== false) : null, score };
  });
}

// ── prompt registry (modular, versioned prompt store) ─────────────────────────
const promptId = (s) => { const n = String(s || '').replace(/[^a-z0-9\-]/gi, ''); return n || null; };
function readPromptRec(id) { try { return JSON.parse(fs.readFileSync(path.join(PROMPTS, id + '.json'), 'utf8')); } catch { return null; } }
function readPromptVersion(id, v) { try { return JSON.parse(fs.readFileSync(path.join(PROMPTS, id, 'v' + v + '.json'), 'utf8')); } catch { return null; } }
function listPromptVersions(id) {
  let vs = []; try { vs = fs.readdirSync(path.join(PROMPTS, id)).filter((f) => /^v\d+\.json$/.test(f)).map((f) => Number(f.slice(1, -5))); } catch {}
  return vs.sort((a, b) => a - b).map((v) => { const d = readPromptVersion(id, v) || {}; return { version: v, note: d.note || '', author: d.author || '', createdAt: d.createdAt || '' }; });
}
function listPromptRecs() {
  let files = []; try { files = fs.readdirSync(PROMPTS).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => readPromptRec(f.replace(/\.json$/, ''))).filter(Boolean)
    .sort((a, b) => (a.stage || '').localeCompare(b.stage || '') || (a.id || '').localeCompare(b.id || ''));
}
function savePromptDraft(id, systemInstruction, note) {
  const rec = readPromptRec(id); if (!rec) return null;
  rec.draft = { systemInstruction: String(systemInstruction || ''), note: String(note || ''), updatedAt: new Date().toISOString() };
  rec.updatedAt = rec.draft.updatedAt;
  fs.writeFileSync(path.join(PROMPTS, id + '.json'), JSON.stringify(rec, null, 2));
  return rec;
}
function publishPromptDraft(id, author) {
  const rec = readPromptRec(id); if (!rec || !rec.draft) return null;
  const next = (rec.publishedVersion || 0) + 1;
  const ver = { version: next, systemInstruction: rec.draft.systemInstruction, note: rec.draft.note || ('Published v' + next), createdAt: new Date().toISOString(), author: author || 'admin' };
  fs.mkdirSync(path.join(PROMPTS, id), { recursive: true });
  fs.writeFileSync(path.join(PROMPTS, id, 'v' + next + '.json'), JSON.stringify(ver, null, 2));
  rec.publishedVersion = next; rec.draft = null; rec.updatedAt = ver.createdAt;
  fs.writeFileSync(path.join(PROMPTS, id + '.json'), JSON.stringify(rec, null, 2));
  return rec;
}
// map prompt id -> regexes that identify that agent's lines in a run log
// (run logs print human agent names + block markers, not the JS class name)
// Primary matcher for every agent is the unique `[PromptAgent] <id>` tag each
// agent now prints; the extra human-name patterns enrich the captured output.
const AGENT_LOG_PATTERNS = {
  'encounter-classifier': [/\[PromptAgent\] encounter-classifier/, /Encounter Classifier/i, /Classification Output/i],
  'observation-extractor': [/\[PromptAgent\] observation-extractor/, /Observation Extractor/i, /AGENT 1 SUMMARY/i, /Extracted Entities/i, /Edges Found/i, /^Diagnoses:/, /^PMH:/, /^Medications:/, /^Orders:/, /^Followups:/, /^Numerics:/],
  'fact-recovery': [/\[PromptAgent\] fact-recovery/, /Fact Recovery/i, /Targeted Recovery/i, /Recall optimal/i, /Recall Analyzer Scores/i, /Missing entities detected/i, /Recovered:/],
  'timeline-builder': [/\[PromptAgent\] timeline-builder/, /Temporal Intelligence/i],
  'negation-normalizer': [/\[PromptAgent\] negation-normalizer/],
  'diagnosis-preservation': [/\[PromptAgent\] diagnosis-preservation/, /Diagnosis Preservation/i],
  'qa-validator': [/\[PromptAgent\] qa-validator/, /QA Validator/i, /V31 QA/i, /Running deep QA/i, /QA Flags/i, /Missing Required Entity/i, /HARD FAIL/i, /Missing Medication/i, /Missing Numeric/i, /Missing Temporal/i, /Retry signal/i, /note is complete/i],
  'compression': [/\[PromptAgent\] compression/, /Compression Engine/i],
  'judge-clinical': [/\[PromptAgent\] judge-clinical/, /Judge/i],
};
const stripAnsiSrv = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
// Get the full stdout for a result run. Prefer the per-run pipeline log the eval
// harness now writes into the result dir (present for EVERY run, CLI or dashboard);
// fall back to the dashboard-captured stdout log for older/legacy runs.
function readRunLogByDir(dir) {
  try { return fs.readFileSync(path.join(RESULTS, dir, '_pipeline.log'), 'utf8'); } catch {}
  const rec = [...runs.values()].find((r) => r.resultDir === dir);
  if (rec) { try { return fs.readFileSync(path.join(LOGDIR, rec.id + '.log'), 'utf8'); } catch {} }
  return '';
}
// BLOCK capture: everything an agent printed between its `[PromptAgent] <id>`
// start tag and the next agent's tag — i.e. the agent's full free output.
const TAG_RE = /\[PromptAgent\]\s+([a-z0-9\-]+)/;
function extractAgentBlocks(text, id) {
  const lines = stripAnsiSrv(text).split(/\r?\n/);
  const fixtures = []; let cur = null; let capturing = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const fm = line.match(/^▶\s+(\S+)/);
    if (fm) { cur = { fixture: fm[1], lines: [] }; fixtures.push(cur); capturing = false; continue; }
    if (!cur) { cur = { fixture: '(startup)', lines: [] }; fixtures.push(cur); }
    const tm = line.match(TAG_RE);
    if (tm) { capturing = (tm[1] === id); if (capturing) cur.lines.push(line); continue; }
    if (capturing && line) cur.lines.push(line);
  }
  return fixtures.filter((f) => f.lines.length);
}
// LEGACY line capture: for older runs (before agent tags) match by human names
function extractAgentFixtures(text, patterns) {
  const lines = stripAnsiSrv(text).split(/\r?\n/);
  const fixtures = []; let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const fm = line.match(/^▶\s+(\S+)/);
    if (fm) { cur = { fixture: fm[1], lines: [] }; fixtures.push(cur); continue; }
    if (!cur) { cur = { fixture: '(startup)', lines: [] }; fixtures.push(cur); }
    if (line && patterns.some((rx) => rx.test(line))) cur.lines.push(line);
  }
  return fixtures.filter((f) => f.lines.length);
}
// for a prompt id, return recent runs with that agent's specific output grouped by fixture
function agentLogs(id) {
  const patterns = AGENT_LOG_PATTERNS[id] || [];
  const byDir = {}; for (const r of runs.values()) if (r.resultDir) byDir[r.resultDir] = r;
  const out = [];
  for (const rr of listResultRuns().slice(0, 12)) {
    const text = readRunLogByDir(rr.dir); if (!text) continue;
    const rec = byDir[rr.dir];
    // primary: block capture via the agent's own tag (full free output);
    // fallback: legacy human-name line matching for runs made before tagging.
    let fixtures = extractAgentBlocks(text, id);
    if (!fixtures.length && patterns.length) fixtures = extractAgentFixtures(text, patterns);
    out.push({ id: rr.dir, resultDir: rr.dir, status: rec ? rec.status : 'passed', command: rec ? rec.command : '(cli run)', fixtures });
  }
  return out;
}

// ── sessions (Debug tab) ──────────────────────────────────────────────────────
function listSessionFiles() { try { return fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } }

// ── router ─────────────────────────────────────────────────────────────────
// Admin/testing-lab request handler, mounted by the combined Express server for the
// admin API prefixes. The unified Next app serves all UI, so static serving is gone.
// This handler reads the raw request stream (readBody) itself, so the mounting server
// must NOT apply express.json() to these routes.
export async function adminHandler(req, res, next) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  // Never serves UI anymore — non-API requests fall through to the rest of the app.
  if (!p.startsWith('/api/')) return next ? next() : json(res, 404, { error: 'not found' });

  if (p === '/api/login' && req.method === 'POST') {
    const { password } = await readBody(req);
    if (password === PASSWORD) { const tok = crypto.randomBytes(24).toString('hex'); sessions.add(tok); res.writeHead(200, { 'Set-Cookie': `notera_admin=${tok}; Path=/; HttpOnly; SameSite=Lax`, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    return json(res, 401, { error: 'wrong password' });
  }
  if (p === '/api/session') return json(res, 200, { authed: authed(req) });
  if (p === '/api/logout' && req.method === 'POST') { sessions.delete(parseCookies(req).notera_admin); return json(res, 200, { ok: true }); }

  if (p.startsWith('/api/') && !authed(req)) return json(res, 401, { error: 'unauthorized' });

  if (p === '/api/scripts') {
    const fx = listFixtures();
    return json(res, 200, { presets: [{ id: 'all', label: `All fixtures (${fx.length})`, fixtures: [] }, ...fx.map((f) => ({ id: f, label: f, fixtures: [f] }))] });
  }

  if (p === '/api/runs' && req.method === 'POST') { const { fixtures = [] } = await readBody(req); return json(res, 200, { runId: startRun(fixtures) }); }
  if (p === '/api/runs' && req.method === 'GET') {
    return json(res, 200, [...runs.values()].map(({ proc, listeners, lines, ...r }) => ({ ...r, liveLines: (runs.get(r.id)?.lines || []).length })).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')).slice(0, 50));
  }
  let m;
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/kill$/)) && req.method === 'POST') { const r = runs.get(m[1]); if (r?.proc) { r.proc.kill('SIGTERM'); r.status = 'killed'; } return json(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/stream$/))) {
    const r = runs.get(m[1]); if (!r) return json(res, 404, { error: 'no run' });
    // Anti-buffering headers: dev proxies (Next rewrites, nginx) otherwise hold the
    // whole stream until it closes, so nothing appears until the run finishes.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write(': open\n\n');                    // forces an immediate flush through proxies
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    for (const ln of r.lines) send({ type: 'line', stream: ln.stream, line: ln.line });
    send({ type: 'status', status: r.status, resultDir: r.resultDir });
    if (r.status !== 'running') { return res.end(); }
    const listener = (ev) => send(ev);
    r.listeners.add(listener);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    const cleanup = () => { clearInterval(beat); r.listeners.delete(listener); };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }
  if ((m = p.match(/^\/api\/runs\/([^/]+)$/)) && req.method === 'GET') { const r = runs.get(m[1]); if (!r) return json(res, 404, {}); const { proc, listeners, ...rest } = r; return json(res, 200, rest); }

  if (p === '/api/results/runs') return json(res, 200, listResultRuns());
  if ((m = p.match(/^\/api\/results\/([^/]+)\/files$/))) { const d = safeRunDir(m[1]); if (!d) return json(res, 400, {}); return json(res, 200, runFiles(d)); }
  if (p === '/api/results/file') {
    const d = safeRunDir(u.searchParams.get('dir')); const f = safeName(u.searchParams.get('name'));
    if (!d || !f) return json(res, 400, {}); try { return json(res, 200, { content: fs.readFileSync(path.join(RESULTS, d, f), 'utf8') }); } catch { return json(res, 404, { error: 'not found' }); }
  }
  if (p === '/api/results/diff') {
    const a = safeRunDir(u.searchParams.get('a')); const b = safeRunDir(u.searchParams.get('b')); const f = safeName(u.searchParams.get('name'));
    const rd = (dir) => { try { return fs.readFileSync(path.join(RESULTS, dir, f), 'utf8'); } catch { return ''; } };
    if (!a || !b || !f) return json(res, 400, {}); return json(res, 200, { a: rd(a), b: rd(b) });
  }
  // ── Patients (reference cases) — list + JSON import ──────────────────────────
  if (p === '/api/patients' && req.method === 'GET') {
    try { const lab = await getLab(); return json(res, 200, { patients: await lab.listPatients() }); }
    catch (e) { return json(res, 200, { patients: [], error: e.message, hint: labHint }); }
  }
  // delete ONE patient (cascades to its records/agent runs/metrics) + its gold fixture
  if ((m = p.match(/^\/api\/patients\/(\d+)$/)) && req.method === 'DELETE') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    try {
      const gone = await lab.deletePatient(Number(m[1]));
      if (!gone) return json(res, 404, { ok: false, error: 'patient not found' });
      let fixtureRemoved = false;
      try { fs.unlinkSync(path.join(GOLD, `${gone.slug}.txt`)); fixtureRemoved = true; } catch { /* no fixture on disk */ }
      return json(res, 200, { ok: true, deleted: { id: gone.id, slug: gone.slug, name: gone.name }, fixtureRemoved });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  if (p === '/api/patients/import' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const body = await readBody(req, res);
    if (body.__tooLarge) return;                                             // 413 already sent
    if (body.__badJson) return json(res, 400, { ok: false, error: 'Invalid JSON: ' + body.__badJson });
    const sessions = Array.isArray(body) ? body : (Array.isArray(body.sessions) ? body.sessions : (Array.isArray(body.data) ? body.data : []));
    if (!sessions.length) return json(res, 200, { ok: false, error: 'No sessions found. Expected a JSON array of reference sessions (or { sessions: [...] }).' });
    // ensure unique fixture slugs across existing + this batch
    const taken = new Set();
    try { (await lab.listPatients()).forEach((r) => taken.add(r.slug)); } catch {}
    const uniqueSlug = (base, sid) => {
      let s = lab.slugify(base, 'patient'); if (s.length < 2) s = 'session-' + String(sid || '').slice(0, 6);
      let c = s, i = 2; while (taken.has(c)) c = `${s}-${i++}`; taken.add(c); return c;
    };

    // Large imports: don't spray thousands of .txt run fixtures into data/gold (it would
    // flood the run selector and the disk). Above the threshold we import to the DB only.
    const FIXTURE_LIMIT = Number(process.env.ADMIN_MAX_FIXTURES || 500);
    const writeFixtures = sessions.length <= FIXTURE_LIMIT;

    // 1) prepare rows synchronously so slugs are assigned deterministically, in order
    const rows = [], skipped = [];
    for (const s of sessions) {
      const name = (s.session_title || s.patient_name_fallback || s.subtitle || `Session ${s.id ?? ''}`).toString().trim() || 'Session';
      const t = s.transcript || {};
      const transcript_clean = (t.clean_text || t.raw_text || '').trim();
      const transcript_raw = (t.raw_text || t.clean_text || '').trim();
      const gold_note = ((s.soap_note && s.soap_note.soap_note) || '').trim();
      if (!transcript_clean && !gold_note) { skipped.push({ name, reason: 'no transcript or note' }); continue; }
      rows.push({ slug: uniqueSlug(name, s.heidi_session_id), name, s, transcript_raw, transcript_clean, gold_note });
    }

    // 2) upsert with bounded concurrency — 10k sequential round-trips would crawl/time out
    const added = [], updated = [];
    const CONC = Math.max(1, Number(process.env.ADMIN_IMPORT_CONCURRENCY || 8));
    let idx = 0;
    const worker = async () => {
      while (idx < rows.length) {
        const r = rows[idx++];
        try {
          const rec = await lab.upsertPatient({
            slug: r.slug, name: r.name, heidi_session_id: r.s.heidi_session_id || null,
            source_url: r.s.source_url || null, subtitle: r.s.subtitle || null, tags: r.s.tags || [],
            transcript_raw: r.transcript_raw, transcript_clean: r.transcript_clean, gold_note: r.gold_note,
            artifacts: r.s.artifacts || [], audits: r.s.audits || [],
          });
          if (writeFixtures) {
            try {
              const golden = r.gold_note && /Subjective\s*:/i.test(r.gold_note) ? r.gold_note : (r.gold_note ? ('Subjective:\n' + r.gold_note) : '');
              fs.writeFileSync(path.join(GOLD, `${rec.slug}.txt`), r.transcript_clean + (golden ? '\n\n' + golden : ''), 'utf8');
            } catch { /* fixture write best-effort */ }
          }
          (rec.created ? added : updated).push({ name: r.name, slug: rec.slug });
        } catch (e) { skipped.push({ name: r.name, reason: e.message }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length || 1) }, () => worker()));

    const cap = (a) => a.slice(0, 50);   // keep the response small for huge imports
    return json(res, 200, {
      ok: true, added: cap(added), updated: cap(updated), skipped: cap(skipped),
      counts: { added: added.length, updated: updated.length, skipped: skipped.length },
      fixturesWritten: writeFixtures,
      note: writeFixtures ? undefined
        : `Imported ${rows.length} patients to the database without writing .txt run fixtures (batch over ${FIXTURE_LIMIT}). Raise ADMIN_MAX_FIXTURES if you want fixtures too.`,
    });
  }

  // ── rerun a single agent (both modes) ────────────────────────────────────────
  //   single     → replay this agent's stored LLM call on the SAME run/record
  //                (optionally with an edited prompt) — fast, deterministic.
  //   downstream → launch a fresh single-patient eval (new run) so the chosen
  //                agent + everything after it re-runs with the current prompts.
  if (p === '/api/lab/rerun-agent' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const { runId, patientId, agentId, mode = 'single', promptOverride = '' } = await readBody(req);
    if (!patientId || !agentId) return json(res, 400, { ok: false, error: 'patientId and agentId are required' });
    try {
      if (mode === 'downstream') {
        const pat = await lab.getPatient(patientId);
        if (!pat) return json(res, 200, { ok: false, error: 'patient not found' });
        const rid = startRun([pat.slug]);   // reuses the run machinery; mirrors to lab DB on completion
        return json(res, 200, { ok: true, mode: 'downstream', runId: rid, slug: pat.slug });
      }
      // single mode — replay the stored call
      if (!runId) return json(res, 400, { ok: false, error: 'runId is required for single-agent rerun' });
      const prev = await lab.latestAgentRun(runId, patientId, agentId);
      if (!prev) return json(res, 200, { ok: false, error: `No stored '${agentId}' call on this run to replay.` });
      const input = prev.input || {};
      const systemPrompt = (promptOverride && String(promptOverride).trim()) ? String(promptOverride) : (prev.system_prompt || '');
      const userPrompt = input.userPrompt || '';
      const schema = input.responseSchema || null;
      const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
      const llm = await createGeminiService();
      const t0 = Date.now();
      const out = await llm.generateContent(systemPrompt, userPrompt, schema);
      const parsed = (() => { try { return JSON.parse(String(out).replace(/```json/gi, '').replace(/```/g, '').trim()); } catch { return null; } })();
      const attempt = (prev.attempt || 1) + 1;
      const newId = await lab.insertAgentRun({
        runId, patientId, runPatientId: prev.run_patient_id, agentId, seq: prev.seq,
        systemPrompt, promptVersion: prev.prompt_version, input, outputRaw: out, outputParsed: parsed,
        status: 'ok', latencyMs: Date.now() - t0, model: llm.model, rerunOf: prev.id, attempt,
      });
      // recompute qa_* metrics for the QA agent so the dashboard reflects the rerun
      let metrics = {};
      if (agentId === 'qa-validator' && parsed) {
        const collected = {};
        (function walk(o, prefix) {
          if (!o || typeof o !== 'object' || Array.isArray(o)) return;
          for (const [k, v] of Object.entries(o)) {
            if (k === 'addendum' || k === 'missing_facts') continue;
            const key = prefix ? prefix + '.' + k : k;
            if (typeof v === 'number' && isFinite(v)) collected[key] = v;
            else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(collected).length < 40) walk(v, key);
          }
        })(parsed, '');
        for (const [k, v] of Object.entries(collected)) metrics['qa_' + k] = v;
        if (Object.keys(metrics).length && prev.run_patient_id) await lab.upsertMetrics({ runId, patientId, runPatientId: prev.run_patient_id, metrics });
      }
      return json(res, 200, { ok: true, mode: 'single', agentRunId: newId, attempt, output: out, outputParsed: parsed, metrics });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, hint: 'Rerun needs a valid GEMINI_API_KEY and a reachable Testing Lab DB.' });
    }
  }

  // ── rerun ONE agent across the whole latest run (single mode) — for the Prompts tab ──
  if (p === '/api/lab/rerun-latest' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const { agentId, promptOverride = '' } = await readBody(req);
    if (!agentId) return json(res, 400, { ok: false, error: 'agentId is required' });
    try {
      const run = await lab.latestRun();
      if (!run) return json(res, 200, { ok: false, error: 'No runs yet — run the tester first.' });
      const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
      const llm = await createGeminiService();
      const patients = await lab.patientsOfRun(run.id);
      let done = 0, failed = 0;
      for (const { patient_id } of patients) {
        const prev = await lab.latestAgentRun(run.id, patient_id, agentId);
        if (!prev) { failed++; continue; }
        try {
          const sys = (promptOverride && String(promptOverride).trim()) ? String(promptOverride) : (prev.system_prompt || '');
          const out = await llm.generateContent(sys, (prev.input && prev.input.userPrompt) || '', (prev.input && prev.input.responseSchema) || null);
          const parsed = (() => { try { return JSON.parse(String(out).replace(/```json/gi, '').replace(/```/g, '').trim()); } catch { return null; } })();
          await lab.insertAgentRun({ runId: run.id, patientId: patient_id, runPatientId: prev.run_patient_id, agentId, seq: prev.seq, systemPrompt: sys, input: prev.input, outputRaw: out, outputParsed: parsed, status: 'ok', model: llm.model, rerunOf: prev.id, attempt: (prev.attempt || 1) + 1 });
          if (agentId === 'qa-validator' && parsed && prev.run_patient_id) {
            const collected = {};
            (function walk(o, prefix) { if (!o || typeof o !== 'object' || Array.isArray(o)) return; for (const [k, v] of Object.entries(o)) { if (k === 'addendum' || k === 'missing_facts') continue; const key = prefix ? prefix + '.' + k : k; if (typeof v === 'number' && isFinite(v)) collected[key] = v; else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(collected).length < 40) walk(v, key); } })(parsed, '');
            const mm = {}; for (const [k, v] of Object.entries(collected)) mm['qa_' + k] = v;
            if (Object.keys(mm).length) await lab.upsertMetrics({ runId: run.id, patientId: patient_id, runPatientId: prev.run_patient_id, metrics: mm });
          }
          done++;
        } catch { failed++; }
      }
      return json(res, 200, { ok: true, run: { id: run.id, run_no: run.run_no, label: run.label }, agentId, done, failed, total: patients.length });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, hint: 'Rerun needs a valid GEMINI_API_KEY and a reachable Testing Lab DB.' });
    }
  }

  // ── Testing Lab dashboard reads ──────────────────────────────────────────────
  if (p.startsWith('/api/lab/')) {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { error: e.message, hint: labHint }); }
    try {
      if (p === '/api/lab/runs') return json(res, 200, { runs: await lab.listRuns() });
      if (p === '/api/lab/trend') return json(res, 200, { points: await lab.trendByRun() });
      let mm;
      if ((mm = p.match(/^\/api\/lab\/run\/(\d+)\/metrics$/))) return json(res, 200, { rows: await lab.metricsForRun(Number(mm[1])) });
      if ((mm = p.match(/^\/api\/lab\/run\/(\d+)\/agents$/))) return json(res, 200, { rows: await lab.agentStats(Number(mm[1])) });
      if ((mm = p.match(/^\/api\/lab\/run\/(\d+)\/heatmap$/))) return json(res, 200, { rows: await lab.heatmap(Number(mm[1])) });
      if ((mm = p.match(/^\/api\/lab\/run\/(\d+)\/patient\/(\d+)\/agents$/))) return json(res, 200, { rows: await lab.agentRunsFor(Number(mm[1]), Number(mm[2])) });
      if ((mm = p.match(/^\/api\/lab\/agent-run\/(\d+)$/))) return json(res, 200, { agentRun: await lab.getAgentRun(Number(mm[1])) });
      if (p === '/api/lab/compare') {
        const a = Number(u.searchParams.get('a')), b = Number(u.searchParams.get('b'));
        const [ma, mb] = await Promise.all([lab.metricsForRun(a), lab.metricsForRun(b)]);
        return json(res, 200, { a: ma, b: mb });
      }
    } catch (e) { return json(res, 200, { error: e.message, hint: labHint }); }
    // fall through for unknown /api/lab/* GETs handled elsewhere (e.g. rerun POST)
  }

  // ── LLM comparison: Notera generated note vs gold reference, scored + cached ──────
  if (p === '/api/results/compare') {
    const isPost = req.method === 'POST';
    const body = isPost ? await readBody(req) : {};
    const d = safeRunDir(isPost ? body.dir : u.searchParams.get('dir'));
    const f = safeName(isPost ? body.name : u.searchParams.get('name'));
    if (!d || !f) return json(res, 400, { error: 'bad args' });
    const cacheFp = path.join(RESULTS, d, f.replace(/\.md$/, '') + '.compare.json');
    if (!isPost) { try { return json(res, 200, { cached: true, ...JSON.parse(fs.readFileSync(cacheFp, 'utf8')) }); } catch { return json(res, 200, { cached: false }); } }
    // read + split the fixture .md into generated and gold
    let generated = '', gold = '';
    try {
      const mdText = fs.readFileSync(path.join(RESULTS, d, f), 'utf8');
      const secs = []; let cur = { title: '_head', body: [] };
      for (const ln of mdText.split('\n')) { const mm = ln.match(/──\s*(.+?)\s*──/); if (mm) { secs.push(cur); cur = { title: mm[1], body: [] }; } else cur.body.push(ln); }
      secs.push(cur);
      const findSec = (rx) => { const s = secs.find((x) => rx.test(x.title)); return s ? s.body.join('\n').trim() : ''; };
      generated = findSec(/generated/i); gold = findSec(/gold/i);
    } catch { return json(res, 404, { error: 'fixture not found' }); }
    if (!generated) return json(res, 404, { error: 'no generated note in fixture' });
    const sys = `You are a clinical documentation comparator scoring two SOAP notes. Compare the NOTERA note (system under test) against the GOLD reference note.
Score objectively, evidence-based, never rewarding fluent-but-unsupported text. Return ONLY valid JSON matching this schema — no prose, no markdown:
{
  "overall_score": 0-100,
  "verdict": "notera_better | gold_better | equivalent",
  "dimensions": [ { "name": "Faithfulness", "notera": 0-5, "gold": 0-5, "comment": "short" },
                  { "name": "Completeness", "notera": 0-5, "gold": 0-5, "comment": "short" },
                  { "name": "Structure", "notera": 0-5, "gold": 0-5, "comment": "short" },
                  { "name": "Clarity", "notera": 0-5, "gold": 0-5, "comment": "short" } ],
  "notera_missing": ["facts in gold missing from notera"],
  "notera_extra": ["facts in notera not supported by gold (possible fabrication)"],
  "key_differences": ["short phrases"],
  "summary": "2-3 sentence verdict"
}`;
    const prompt = `=== NOTERA NOTE (system under test) ===\n\n${generated}\n\n=== GOLD NOTE (reference) ===\n\n${gold || '(no gold reference available)'}\n\nCompare and return ONLY the JSON.`;
    try {
      const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
      const llm = await createGeminiService();
      const out = await llm.generateContent(sys, prompt);
      let parsed = null; try { parsed = JSON.parse(String(out).replace(/```json/g, '').replace(/```/g, '').trim()); } catch {}
      if (!parsed) return json(res, 200, { ok: false, error: 'could not parse comparison output', raw: String(out).slice(0, 4000) });
      parsed.generatedAt = new Date().toISOString();
      try { fs.writeFileSync(cacheFp, JSON.stringify(parsed, null, 2)); } catch {}
      return json(res, 200, { ok: true, cached: true, ...parsed });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, hint: 'Comparison needs GEMINI_API_KEY (or GEMINI_PROXY_URL) in the admin server env.' });
    }
  }
  // delete a run entirely: its result dir, captured stdout log, runs.json entry, history line
  if ((m = p.match(/^\/api\/results\/([^/]+)$/)) && req.method === 'DELETE') {
    const d = safeRunDir(m[1]); if (!d) return json(res, 400, { error: 'bad run' });
    try { fs.rmSync(path.join(RESULTS, d), { recursive: true, force: true }); }
    catch (e) { return json(res, 500, { error: e.message }); }
    // prune the metrics history line for this run
    try {
      const hp = path.join(RESULTS, '_history.jsonl'); const rid = d.replace(/^run_/, '');
      const kept = fs.readFileSync(hp, 'utf8').split(/\n/).filter(Boolean).filter((l) => { try { return JSON.parse(l).runId !== rid; } catch { return true; } });
      fs.writeFileSync(hp, kept.length ? kept.join('\n') + '\n' : '');
    } catch {}
    // prune the runs.json entry + its captured stdout log
    try {
      for (const [rid, r] of runs) if (r.resultDir === d) { runs.delete(rid); try { fs.unlinkSync(path.join(LOGDIR, rid + '.log')); } catch {} }
      persistRuns();
    } catch {}
    return json(res, 200, { ok: true });
  }

  if (p === '/api/metrics/history') {
    let hist = []; try { hist = fs.readFileSync(path.join(RESULTS, '_history.jsonl'), 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    return json(res, 200, hist);
  }
  if ((m = p.match(/^\/api\/metrics\/run\/([^/]+)$/))) { const d = safeRunDir(m[1]); if (!d) return json(res, 400, {}); let data = { summary: null, rows: [] }; try { data = JSON.parse(fs.readFileSync(path.join(RESULTS, d, '_summary.json'), 'utf8')); } catch {} return json(res, 200, data); }
  if (p === '/api/metrics/compare') {
    const a = safeRunDir(u.searchParams.get('a')); const b = safeRunDir(u.searchParams.get('b'));
    const load = (d) => { try { return JSON.parse(fs.readFileSync(path.join(RESULTS, d, '_summary.json'), 'utf8')); } catch { return { summary: {}, rows: [] }; } };
    const A = load(a), B = load(b);
    const flips = [];
    const byId = (rows) => Object.fromEntries((rows || []).map((r) => [r.id, r]));
    const ai = byId(A.rows), bi = byId(B.rows);
    for (const id of new Set([...Object.keys(ai), ...Object.keys(bi)])) {
      flips.push({ id, a: ai[id] || null, b: bi[id] || null });
    }
    return json(res, 200, { a: A.summary, b: B.summary, fixtures: flips });
  }

  // ── prompts registry ───────────────────────────────────────────────────────
  if (p === '/api/prompts' && req.method === 'GET') {
    return json(res, 200, { readOnly: PROMPTS_READONLY, prompts: listPromptRecs().map((r) => ({
      id: r.id, agent: r.agent, file: r.file, label: r.label, stage: r.stage, description: r.description || '',
      kind: r.kind || 'agent', vars: r.vars || [], active: r.active === true, order: (typeof r.order === 'number' ? r.order : null),
      freeform: r.freeform === true, maxOutputTokens: (typeof r.maxOutputTokens === 'number' ? r.maxOutputTokens : null),
      publishedVersion: r.publishedVersion || null, hasDraft: !!r.draft, updatedAt: r.updatedAt })) });
  }
  if ((m = p.match(/^\/api\/prompts\/([^/]+)$/)) && req.method === 'GET') {
    const id = promptId(m[1]); const rec = id && readPromptRec(id); if (!rec) return json(res, 404, { error: 'no prompt' });
    const pub = rec.publishedVersion ? readPromptVersion(id, rec.publishedVersion) : null;
    return json(res, 200, { ...rec, published: pub, versions: listPromptVersions(id) });
  }
  if ((m = p.match(/^\/api\/prompts\/([^/]+)\/version\/(\d+)$/)) && req.method === 'GET') {
    const id = promptId(m[1]); const v = readPromptVersion(id, Number(m[2])); if (!v) return json(res, 404, {}); return json(res, 200, v);
  }
  if ((m = p.match(/^\/api\/prompts\/([^/]+)\/logs$/)) && req.method === 'GET') {
    const id = promptId(m[1]); const rec = id && readPromptRec(id); if (!rec) return json(res, 404, {}); return json(res, 200, agentLogs(id));
  }
  if ((m = p.match(/^\/api\/prompts\/([^/]+)$/)) && req.method === 'PUT') {
    if (PROMPTS_READONLY) return json(res, 403, { error: 'read-only mode' });
    const id = promptId(m[1]); const { systemInstruction, note } = await readBody(req);
    const rec = savePromptDraft(id, systemInstruction, note); if (!rec) return json(res, 404, { error: 'no prompt' });
    return json(res, 200, { ok: true, draft: rec.draft });
  }
  if ((m = p.match(/^\/api\/prompts\/([^/]+)\/publish$/)) && req.method === 'POST') {
    if (PROMPTS_READONLY) return json(res, 403, { error: 'read-only mode' });
    const id = promptId(m[1]); const rec = publishPromptDraft(id, 'admin'); if (!rec) return json(res, 400, { error: 'no draft to publish' });
    return json(res, 200, { ok: true, publishedVersion: rec.publishedVersion });
  }
  if ((m = p.match(/^\/api\/prompts\/([^/]+)\/config$/)) && req.method === 'POST') {
    if (PROMPTS_READONLY) return json(res, 403, { error: 'read-only mode' });
    const id = promptId(m[1]); const rec = id && readPromptRec(id); if (!rec) return json(res, 404, { error: 'no prompt' });
    const body = await readBody(req);
    if (typeof body.freeform === 'boolean') rec.freeform = body.freeform;
    if (typeof body.schema === 'string') rec.schema = body.schema;
    if (body.maxOutputTokens === null || body.maxOutputTokens === '') rec.maxOutputTokens = null;
    else if (body.maxOutputTokens !== undefined) { const n = Number(body.maxOutputTokens); if (Number.isFinite(n) && n > 0) rec.maxOutputTokens = Math.floor(n); }
    rec.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(PROMPTS, id + '.json'), JSON.stringify(rec, null, 2));
    return json(res, 200, { ok: true, freeform: rec.freeform === true, maxOutputTokens: rec.maxOutputTokens ?? null, schema: rec.schema || '' });
  }
  if ((m = p.match(/^\/api\/prompts\/([^/]+)\/revert$/)) && req.method === 'POST') {
    if (PROMPTS_READONLY) return json(res, 403, { error: 'read-only mode' });
    const id = promptId(m[1]); const rec = readPromptRec(id); if (!rec) return json(res, 404, {});
    rec.draft = null; rec.updatedAt = new Date().toISOString(); fs.writeFileSync(path.join(PROMPTS, id + '.json'), JSON.stringify(rec, null, 2));
    return json(res, 200, { ok: true });
  }

  // ── sessions (Debug tab) ────────────────────────────────────────────────────
  if (p === '/api/sessions' && req.method === 'GET') return json(res, 200, listSessionFiles());
  if (p === '/api/sessions/file') {
    const f = safeName(u.searchParams.get('name')); if (!f) return json(res, 400, {});
    try { return json(res, 200, JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'))); } catch { return json(res, 404, { error: 'not found' }); }
  }

  // ── judge run (uses the pipeline LLM service; degrades gracefully) ───────────
  if (p === '/api/judge/run' && req.method === 'POST') {
    const { systemInstruction, transcript = '', note = '', gold = '' } = await readBody(req);
    try {
      const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
      const llm = await createGeminiService();
      const userPrompt = `SOURCE TRANSCRIPT:\n\n${transcript}\n\n=== GENERATED NOTE ===\n\n${note}\n\n${gold ? `=== GOLD REFERENCE ===\n\n${gold}\n\n` : ''}Evaluate and return ONLY the JSON verdict.`;
      const out = await llm.generateContent(String(systemInstruction || ''), userPrompt);
      let parsed = null; try { parsed = JSON.parse(String(out).replace(/```json/g, '').replace(/```/g, '').trim()); } catch {}
      return json(res, 200, { ok: true, raw: out, verdict: parsed });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, hint: 'Judge needs GEMINI_API_KEY (or GEMINI_PROXY_URL) in the admin server env.' });
    }
  }

  json(res, 404, { error: 'not found' });
}
