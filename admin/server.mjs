// ─────────────────────────────────────────────────────────────────────────────
// Notera Auto-Tester — Admin Dashboard server (zero-dependency, pure Node http).
//   • spawns `node eval/run_eval.mjs [fixtures]`, streams stdout/stderr over SSE
//   • persists run history to admin/data/runs.json
//   • serves results (rendered md + raw + diff) and metrics from eval/results/*
//   • prompt registry (view/edit/version/publish) + sessions + editable judge
//   • simple single-admin password/session (ADMIN_PASSWORD, default "notera")
// Run:  node admin/server.mjs      (then open http://localhost:4300)
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'eval', 'results');
const GOLD = path.join(ROOT, 'data', 'gold');
const DATA = path.join(__dirname, 'data');
const LOGDIR = path.join(DATA, 'logs');
const RUNS_DB = path.join(DATA, 'runs.json');
const PROMPTS = path.join(ROOT, 'backend', 'prompts', 'store');
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
  'heidi-compression': [/\[PromptAgent\] heidi-compression/, /Compression Engine/i],
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
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try { const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); return res.end(html); }
    catch { return json(res, 500, { error: 'index.html missing' }); }
  }

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
    if (body.maxOutputTokens === null || body.maxOutputTokens === '') rec.maxOutputTokens = null;
    else if (body.maxOutputTokens !== undefined) { const n = Number(body.maxOutputTokens); if (Number.isFinite(n) && n > 0) rec.maxOutputTokens = Math.floor(n); }
    rec.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(PROMPTS, id + '.json'), JSON.stringify(rec, null, 2));
    return json(res, 200, { ok: true, freeform: rec.freeform === true, maxOutputTokens: rec.maxOutputTokens ?? null });
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
      const { createGeminiService } = await import(pathToFileURL(path.join(ROOT, 'backend', 'src', 'services', 'LLMService.js')).href);
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
});

server.listen(PORT, () => console.log(`Notera admin dashboard → http://localhost:${PORT}  (password: ${PASSWORD === 'notera' ? 'notera [set ADMIN_PASSWORD to change]' : 'set'})`));
