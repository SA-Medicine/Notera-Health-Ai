// ─────────────────────────────────────────────────────────────────────────────
// Notera Auto-Tester — Admin Dashboard server (zero-dependency, pure Node http).
//   • spawns `node eval/run_eval.mjs [fixtures]`, streams stdout/stderr over SSE
//   • persists run history to admin/data/runs.json
//   • serves results (rendered md + raw + diff) and metrics from eval/results/*
//   • simple single-admin password/session (ADMIN_PASSWORD, default "notera")
// Run:  node admin/server.mjs      (then open http://localhost:4300)
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'eval', 'results');
const GOLD = path.join(ROOT, 'data', 'gold');
const DATA = path.join(__dirname, 'data');
const LOGDIR = path.join(DATA, 'logs');
const RUNS_DB = path.join(DATA, 'runs.json');
const PORT = Number(process.env.ADMIN_PORT) || 4300;
const PASSWORD = process.env.ADMIN_PASSWORD || 'notera';
fs.mkdirSync(LOGDIR, { recursive: true });

// ── tiny state ───────────────────────────────────────────────────────────────
const sessions = new Set();
const runs = new Map();               // id -> { id, command, status, startedAt, finishedAt, exitCode, resultDir, lines[], listeners:Set, proc }
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
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e7) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); }); }

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

// ── router ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  // static
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try { const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); return res.end(html); }
    catch { return json(res, 500, { error: 'index.html missing' }); }
  }

  // auth
  if (p === '/api/login' && req.method === 'POST') {
    const { password } = await readBody(req);
    if (password === PASSWORD) { const tok = crypto.randomBytes(24).toString('hex'); sessions.add(tok); res.writeHead(200, { 'Set-Cookie': `notera_admin=${tok}; Path=/; HttpOnly; SameSite=Lax`, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    return json(res, 401, { error: 'wrong password' });
  }
  if (p === '/api/session') return json(res, 200, { authed: authed(req) });
  if (p === '/api/logout' && req.method === 'POST') { sessions.delete(parseCookies(req).notera_admin); return json(res, 200, { ok: true }); }

  // gate everything else
  if (p.startsWith('/api/') && !authed(req)) return json(res, 401, { error: 'unauthorized' });

  // scripts / fixtures
  if (p === '/api/scripts') {
    const fx = listFixtures();
    return json(res, 200, { presets: [{ id: 'all', label: `All fixtures (${fx.length})`, fixtures: [] }, ...fx.map((f) => ({ id: f, label: f, fixtures: [f] }))] });
  }

  // runs
  if (p === '/api/runs' && req.method === 'POST') { const { fixtures = [] } = await readBody(req); return json(res, 200, { runId: startRun(fixtures) }); }
  if (p === '/api/runs' && req.method === 'GET') {
    return json(res, 200, [...runs.values()].map(({ proc, listeners, lines, ...r }) => ({ ...r, liveLines: (runs.get(r.id)?.lines || []).length })).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')).slice(0, 50));
  }
  let m;
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/kill$/)) && req.method === 'POST') { const r = runs.get(m[1]); if (r?.proc) { r.proc.kill('SIGTERM'); r.status = 'killed'; } return json(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/stream$/))) {
    const r = runs.get(m[1]); if (!r) return json(res, 404, { error: 'no run' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const ln of r.lines) res.write(`data: ${JSON.stringify({ type: 'line', stream: ln.stream, line: ln.line })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'status', status: r.status, resultDir: r.resultDir })}\n\n`);
    if (r.status !== 'running') { return res.end(); }
    const listener = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    r.listeners.add(listener);
    req.on('close', () => r.listeners.delete(listener));
    return;
  }
  if ((m = p.match(/^\/api\/runs\/([^/]+)$/)) && req.method === 'GET') { const r = runs.get(m[1]); if (!r) return json(res, 404, {}); const { proc, listeners, ...rest } = r; return json(res, 200, rest); }

  // results
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

  // metrics
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
      const pa = ai[id]?.status, pb = bi[id]?.status;
      flips.push({ id, a: ai[id] || null, b: bi[id] || null });
    }
    return json(res, 200, { a: A.summary, b: B.summary, fixtures: flips });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`Notera admin dashboard → http://localhost:${PORT}  (password: ${PASSWORD === 'notera' ? 'notera [set ADMIN_PASSWORD to change]' : '••••'})`));
