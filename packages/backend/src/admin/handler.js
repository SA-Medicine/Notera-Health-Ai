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
import { makeSession } from './session.js';

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
const session = makeSession(DATA);   // stateless signed-cookie auth (survives restarts)
const runs = new Map();
loadRuns();

function loadRuns() {
  try {
    const arr = JSON.parse(fs.readFileSync(RUNS_DB, 'utf8'));
    for (const r of arr) {
      let status = r.status;
      if (status === 'running') {
        // The scan is detached, so after a backend restart it may STILL be running. Only
        // mark it interrupted if its process is gone AND it didn't finish on disk.
        const alive = r.pid && (() => { try { process.kill(r.pid, 0); return true; } catch { return false; } })();
        if (!alive) {
          let phase = null; try { phase = JSON.parse(fs.readFileSync(path.join(RESULTS, r.resultDir || '', '_progress.json'), 'utf8')).phase; } catch {}
          status = phase === 'done' ? 'passed' : 'interrupted';
        }
      }
      runs.set(r.id, { ...r, status, lines: [], listeners: new Set(), proc: null });
    }
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
function authed(req) { return !!session.verify(parseCookies(req)[session.COOKIE]); }
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
function startRun(fixtures = [], { resumeDir = null } = {}) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
  const clean = fixtures.filter(Boolean).map(safeName);
  const entry = process.env.ADMIN_EVAL_ENTRY || 'eval/run_eval.mjs';
  const args = [entry, ...(resumeDir ? ['--resume', resumeDir] : []), ...clean];
  const command = 'node ' + args.join(' ');
  const rec = { id, command, fixtures: clean, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, resultDir: resumeDir || null, lines: [], listeners: new Set(), proc: null };
  runs.set(id, rec);
  const logStream = fs.createWriteStream(path.join(LOGDIR, id + '.log'), { flags: 'a' });
  // detached + unref: the scan runs in its OWN process group, so a backend `--watch`
  // reload / crash / deploy does NOT kill a long (150+ patient) run midway. We still pipe
  // stdout for live streaming while the backend is up; the run also writes its own logs +
  // incremental _summary.json / _progress.json, so nothing is lost if the pipe closes.
  const proc = spawn('node', args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '1' }, detached: true });
  rec.proc = proc; rec.pid = proc.pid;
  try { proc.unref(); } catch {}
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

// ── run status reconciliation + log-tail (survives a backend restart) ─────────
const _procAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const _progressOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(RESULTS, dir || '', '_progress.json'), 'utf8')); } catch { return null; } };
// A run whose process is gone, whose progress file finished, or which hasn't advanced in a
// long time is NOT really "running" — flip it so the UI stops showing an eternal spinner and
// the run becomes resumable. STALE window is well above the per-fixture timeout.
function reconcileRunStatus(rec) {
  if (!rec || rec.status !== 'running') return rec;
  const pg = _progressOf(rec.resultDir);
  if (pg && pg.phase === 'done') { rec.status = 'passed'; rec.finishedAt = rec.finishedAt || new Date().toISOString(); persistRuns(); return rec; }
  const alive = _procAlive(rec.pid);
  const updatedAt = pg && pg.updatedAt ? Date.parse(pg.updatedAt) : null;
  const STALE = Number(process.env.RUN_STALE_MS) || 900000;   // 15 min (> 5 min fixture timeout + slack)
  const stale = updatedAt ? (Date.now() - updatedAt > STALE) : !alive;
  if (!alive || stale) { rec.status = 'interrupted'; rec.finishedAt = rec.finishedAt || new Date().toISOString(); persistRuns(); }
  return rec;
}
// When the in-memory line buffer is empty (backend restarted while a detached run keeps
// going), fall back to the run's own _pipeline.log so the UI still shows live output.
function tailPipelineLog(dir, maxLines = 800) {
  try { return fs.readFileSync(path.join(RESULTS, dir, '_pipeline.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines).map((line) => ({ stream: 'out', line })); } catch { return []; }
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
// Materialize .txt run fixtures ON DEMAND for a set of slugs, pulling transcript + gold
// from the DB. Only the SELECTED slugs are written, so a dataset of any size (e.g. 7k
// patients imported DB-only, past ADMIN_MAX_FIXTURES) is fully runnable by selecting a
// subset — no need to flood data/gold with thousands of files up front. Returns count.
async function ensureFixtures(lab, slugs = []) {
  let written = 0;
  for (const slug of slugs) {
    if (!slug) continue;
    const fp = path.join(GOLD, `${safeName(slug)}.txt`);
    try { fs.accessSync(fp); continue; } catch { /* not on disk → build it */ }
    let p; try { p = await lab.getPatientBySlug(slug); } catch { p = null; }
    if (!p) continue;
    const transcript = (p.transcript_clean || p.transcript_raw || '').trim();
    if (!transcript) continue;                                   // nothing runnable
    const gold = (p.gold_note || '').trim();
    const golden = gold ? (/Subjective\s*:/i.test(gold) ? gold : 'Subjective:\n' + gold) : '';
    try { fs.writeFileSync(fp, transcript + (golden ? '\n\n' + golden : ''), 'utf8'); written++; } catch { /* best effort */ }
  }
  return written;
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

// ── minimal, dependency-free ZIP writer (store method) — used to export prompts ──
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function zipStore(files) {
  const parts = [], central = []; let offset = 0;
  const T = 0, D = 0x21;   // fixed DOS time/date (1980-01-01) for reproducible archives
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(T, 10); lh.writeUInt16LE(D, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(T, 12); cd.writeUInt16LE(D, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += lh.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, eocd]);
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

// ── System Upgrader helpers ───────────────────────────────────────────────────
// The note-shaping LLM agents the upgrader may improve (per-agent, clean attribution).
const UPGRADER_AGENTS = ['observation-extractor', 'clinical-story', 'qa-validator', 'fact-recovery', 'encounter-classifier'];

// Safety-critical instruction classes an edit must never remove or weaken.
const PROTECTED_PATTERNS = [
  { name: 'de-identification', rx: /de-?identif|\bPHI\b/i },
  { name: 'no-fabrication', rx: /\b(do not|never|don't)\b[^.]{0,40}\b(invent|fabricate|hallucinat|make up)/i },
  { name: 'negation-handling', rx: /negat(e|ion|ed)/i },
  { name: 'medication-grounding', rx: /unsupported|not supported by|grounded|grounding/i },
  { name: 'schema/format', rx: /schema|JSON|format/i },
];
/** A patch is unsafe if its `before` asserts a protected rule that `after` drops. */
function protectedViolation(patches = []) {
  for (const pt of patches) {
    for (const P of PROTECTED_PATTERNS) {
      if (P.rx.test(pt.before || '') && !P.rx.test(pt.after || '')) {
        return `removes/weakens ${P.name} instruction`;
      }
    }
  }
  return null;
}

/** Published system instruction for a registry prompt id (or a fallback). */
function loadPromptSrv(id, fallback = '') {
  const rec = readPromptRec(id);
  if (!rec || !rec.publishedVersion) return fallback;
  const ver = readPromptVersion(id, rec.publishedVersion);
  return (ver && typeof ver.systemInstruction === 'string') ? ver.systemInstruction : fallback;
}

/** Current published prompt for an agent (or null version → inline fallback used at runtime). */
function resolveCurrentPrompt(agentId) {
  const rec = readPromptRec(agentId);
  if (rec && rec.publishedVersion) {
    const ver = readPromptVersion(agentId, rec.publishedVersion);
    if (ver && typeof ver.systemInstruction === 'string') return { version: rec.publishedVersion, text: ver.systemInstruction, hasRec: true };
  }
  return { version: rec ? (rec.publishedVersion || null) : null, text: '', hasRec: !!rec };
}

/** Apply anchored find→replace patches to a base prompt. Returns text + which applied. */
function applyPatches(base, patches = []) {
  let text = String(base || ''); const applied = [], failed = [];
  for (const pt of patches) {
    const before = pt.before || '';
    if (before && text.includes(before)) { text = text.replace(before, pt.after || ''); applied.push(pt); }
    else failed.push(pt);
  }
  return { text, applied, failed };
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
function compositeScore(m) {
  if (!m) return 0;
  const cov = num(m.section_coverage) ?? 0, sim = num(m.similarity_to_gold) ?? 0,
        flow = num(m.story_flow) ?? 0, om = num(m.omission_rate) ?? 0;
  return (cov + sim + flow + (1 - om)) / 4;
}
const trim = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s; };
// Like trim(), but the marker makes explicit it's a DISPLAY cap (not a runtime truncation)
// so the optimizer never proposes a phantom "prompt got truncated" fix.
const trimForView = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + `\n…[VIEW CAP ONLY — the live prompt is COMPLETE; ${s.length - n} chars omitted from this view]` : s; };

/**
 * Assemble the contrastive evidence for one agent from a run:
 * worst-K failing records + best-M anchors, each with metrics + note-vs-gold comparison,
 * split into optimize/validate sets by ratio. Pure data — no LLM.
 */
async function buildUpgradeContext(lab, runId, agentId, { failK = 4, anchorM = 2, ratio = 0.5 } = {}) {
  const run = await lab.getRun(runId);
  if (!run) throw new Error('run not found');
  const records = await lab.agentRunsForRunAgent(runId, agentId);
  if (!records.length) throw new Error(`no '${agentId}' agent runs stored for this run`);
  const metricRows = await lab.metricsForRunByRecord(runId);
  const mByRp = {}; for (const r of metricRows) { (mByRp[r.run_patient_id] ||= {})[r.metric_key] = Number(r.metric_value); }
  const dir = run.label;
  const enrich = (r) => {
    const m = mByRp[r.run_patient_id] || {};
    // Cache files are named after the fixture basename, which is the patient NAME for
    // backfilled gold cases (e.g. "Patient2") and the SLUG for imported ones. Try both.
    let compare = null;
    for (const cand of [r.name, r.slug]) {
      if (!cand) continue;
      try { compare = JSON.parse(fs.readFileSync(path.join(RESULTS, dir, cand + '.compare.json'), 'utf8')); break; } catch {}
    }
    return {
      slug: r.slug, name: r.name, run_patient_id: r.run_patient_id, patient_id: r.patient_id,
      metrics: m, score: compositeScore(m), status: r.status,
      input: r.input || {}, output_raw: r.output_raw, output_parsed: r.output_parsed,
      compare: compare && {
        overall_score: compare.overall_score, verdict: compare.verdict,
        notera_missing: compare.notera_missing, notera_extra: compare.notera_extra,
        key_differences: compare.key_differences, summary: compare.summary, dimensions: compare.dimensions,
      },
    };
  };
  const all = records.map(enrich).sort((a, b) => a.slug.localeCompare(b.slug));
  // optimize/validate split (deterministic by slug so it's stable across runs)
  const nOpt = Math.max(1, Math.round(all.length * ratio));
  const optimize = all.slice(0, nOpt), validate = all.slice(nOpt);
  const byScore = [...optimize].sort((a, b) => a.score - b.score);
  const failures = byScore.slice(0, Math.min(failK, byScore.length));
  const anchors = byScore.slice(-Math.min(anchorM, byScore.length)).filter((a) => !failures.includes(a));
  const cur = resolveCurrentPrompt(agentId);
  // the prompt actually sent at runtime (captured per record) is the most accurate "current"
  const runtimePrompt = records.find((r) => r.system_prompt)?.system_prompt || '';
  return {
    run: { id: run.id, run_no: run.run_no, label: run.label },
    agentId, hasRegistryRec: cur.hasRec, baseVersion: cur.version,
    currentPrompt: runtimePrompt || cur.text || '',
    counts: { records: all.length, optimize: optimize.length, validate: validate.length, failures: failures.length, anchors: anchors.length },
    failures, anchors,
    optimizeSlugs: optimize.map((r) => r.slug), validateSlugs: validate.map((r) => r.slug),
  };
}

/** Build the optimizer's user prompt from context (token-bounded). */
function formatUpgradeUserPrompt(ctx) {
  const L = [];
  L.push(`AGENT TO IMPROVE: ${ctx.agentId}`);
  L.push(`RUN: #${ctx.run.run_no} (${ctx.run.label}) — ${ctx.counts.records} records, ${ctx.counts.failures} failing samples, ${ctx.counts.anchors} passing anchors.`);
  L.push('');
  L.push('=== CURRENT PROMPT (verbatim, COMPLETE — your `before` snippets must come from this) ===');
  // Show the full current prompt so `before` snippets anchor and the optimizer never
  // mistakes a display cap for a runtime truncation bug. Only a runaway prompt is capped,
  // and the marker makes clear it's a view limit, not the live value.
  L.push(trimForView(ctx.currentPrompt, 60000));
  L.push('');
  L.push('=== FAILING RECORDS (edit the prompt to fix these) ===');
  for (const f of ctx.failures) {
    L.push(`--- ${f.name} [${f.slug}]  composite=${f.score.toFixed(2)}${f.compare?.overall_score != null ? `  compare=${f.compare.overall_score}/100 (${f.compare.verdict})` : ''} ---`);
    if (f.compare) {
      if (f.compare.notera_missing?.length) L.push(`MISSING (in gold, absent from note): ${f.compare.notera_missing.slice(0, 8).join(' | ')}`);
      if (f.compare.notera_extra?.length) L.push(`EXTRA (in note, unsupported by gold): ${f.compare.notera_extra.slice(0, 8).join(' | ')}`);
      if (f.compare.key_differences?.length) L.push(`KEY DIFFERENCES: ${f.compare.key_differences.slice(0, 8).join(' | ')}`);
    } else {
      L.push('(no comparison available — infer from metrics)');
    }
    L.push(`metrics: ${Object.entries(f.metrics).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(', ')}`);
    L.push(`this agent's output (excerpt): ${trim(f.output_raw, 700)}`);
    L.push('');
  }
  if (ctx.anchors.length) {
    L.push('=== PASSING ANCHORS (do NOT break these — preserve what makes them work) ===');
    for (const a of ctx.anchors) {
      L.push(`--- ${a.name} [${a.slug}]  composite=${a.score.toFixed(2)}${a.compare?.overall_score != null ? `  compare=${a.compare.overall_score}/100` : ''} ---`);
      if (a.compare?.summary) L.push(trim(a.compare.summary, 300));
    }
    L.push('');
  }
  L.push('Now improve the prompt per your instructions. Return ONLY the JSON.');
  return L.join('\n');
}

const stripFencesSrv = (s) => String(s || '').replace(/```json/gi, '').replace(/```/g, '').trim();
const tryParseJsonSrv = (s) => { try { return JSON.parse(stripFencesSrv(s)); } catch { return null; } };
const dropTrailingCommas = (s) => s.replace(/,(\s*[}\]])/g, '$1');

// Escape raw control chars (literal newlines/tabs/etc.) that appear INSIDE JSON string
// values — the #1 reason LLM JSON fails to parse (e.g. a multi-line prompt embedded in
// a "full_prompt" string). Walks char-by-char tracking string state; only touches bytes
// inside strings, so structure is preserved.
function escapeCtrlInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k], code = s.charCodeAt(k);
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      if (code < 0x20) { out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + code.toString(16).padStart(4, '0'); continue; }
      out += c; continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

// Repair LLM JavaScript-style string concatenation inside JSON — a real failure mode
// where the model writes  "A" + "B"  or  "A" + 'B'  (breaking out of the JSON string to
// avoid escaping an inner quote). Merges the pieces into one valid JSON string.
function mergeStringConcat(s) {
  let out = String(s || '');
  out = out.replace(/"(\s*)\+(\s*)"/g, '');                       // "A" + "B" -> "AB"
  out = out.replace(/"\s*\+\s*'((?:\\.|[^'])*)'/g, (m, body) => { // "A" + 'B' -> "AB"
    const conv = body.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"');
    return conv + '"';
  });
  return out;
}

// Fix UNESCAPED double-quotes inside JSON string values — the model embeds huge prompts
// with quoted terms and escapes them inconsistently (\"Age: X"  or  \"Diagnosis", ...).
// A bare " before a comma is otherwise indistinguishable from a real string end, so we
// use the fact that this optimizer JSON has a FIXED key set: a " terminates a string only
// when followed by } ] : or  , "<known-key>": / , { / , ] . Everything else is a literal.
const UPGRADE_JSON_KEYS = ['anchor', 'before', 'after', 'reason', 'agent_id', 'confidence', 'rationale', 'patches', 'full_prompt', 'summary', 'prompt_patches', 'system_suggestions', 'category', 'severity', 'title', 'detail'];
const UPGRADE_KEY_AHEAD = new RegExp('^\\s*,\\s*"(' + UPGRADE_JSON_KEYS.join('|') + ')"\\s*:');
function fixUnescapedQuotes(s) {
  let out = '', inStr = false, esc = false;
  const str = String(s || '');
  for (let k = 0; k < str.length; k++) {
    const c = str[k];
    if (!inStr) { out += c; if (c === '"') inStr = true; continue; }
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c !== '"') { out += c; continue; }
    let m = k + 1; while (m < str.length && /\s/.test(str[m])) m++;
    const nxt = str[m]; const rest = str.slice(k + 1);
    let term = false;
    if (m >= str.length) term = true;
    else if (nxt === '}' || nxt === ']' || nxt === ':') term = true;
    else if (nxt === ',') term = UPGRADE_KEY_AHEAD.test(rest) || /^\s*,\s*[{[]/.test(rest) || /^\s*,\s*[}\]]/.test(rest);
    if (term) { out += '"'; inStr = false; } else { out += '\\"'; }
  }
  return out;
}

// Apply every string-level repair in the right order (concat → stray quotes → control
// chars → trailing commas). Used as the most aggressive parse attempt.
function salvageJsonString(s) {
  return dropTrailingCommas(escapeCtrlInStrings(fixUnescapedQuotes(mergeStringConcat(String(s || '')))));
}

// Best-effort repair for a TRUNCATED JSON object (the model hit the output-token
// cap mid-structure). Walks the text tracking strings + bracket depth, closes an
// open string, trims a dangling partial key/value, and appends the missing closers.
function repairTruncatedJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const s = text.slice(start);
  let inStr = false, esc = false;
  const stack = [];
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';                                   // close an unterminated string
  out = out.replace(/,\s*$/, '');                          // dangling comma
  out = out.replace(/,\s*"[^"]*"\s*:?\s*$/, '');           // dangling partial key like: , "foo":
  while (stack.length) out += stack.pop();                 // close open brackets/braces
  out = dropTrailingCommas(out);
  try { return JSON.parse(out); } catch {}
  try { return JSON.parse(escapeCtrlInStrings(out)); } catch {}
  try { return JSON.parse(salvageJsonString(out)); } catch { return null; }
}

// Robust: models wrap JSON in prose/markdown, emit trailing commas, or get cut off
// at the token limit. Try clean parse → outermost {...} slice → comma-fixed slice →
// truncation repair. Returns { parsed, method } so the diagnostics show what happened.
function extractUpgradeJson(out) {
  const clean = tryParseJsonSrv(out);
  if (clean) return { parsed: clean, method: 'clean' };
  const s = stripFencesSrv(out); const i = s.indexOf('{'); const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    const slice = s.slice(i, j + 1);
    try { return { parsed: JSON.parse(slice), method: 'sliced' }; } catch {}
    try { return { parsed: JSON.parse(dropTrailingCommas(slice)), method: 'sliced-fixed' }; } catch {}
    // Escape raw control chars inside strings (literal newlines in an embedded prompt).
    try { return { parsed: JSON.parse(dropTrailingCommas(escapeCtrlInStrings(slice))), method: 'ctrl-fixed' }; } catch {}
    // Full salvage: merge JS concatenation → escape stray quotes → escape control chars.
    try { return { parsed: JSON.parse(salvageJsonString(slice)), method: 'salvaged' }; } catch {}
  }
  const repaired = repairTruncatedJson(s);
  if (repaired) return { parsed: repaired, method: 'repaired' };
  return { parsed: null, method: 'failed' };
}

// A model with a big token budget can fall into a repetition loop, producing degenerate
// text (a phrase or "_And_X" fragment repeated hundreds of times). Detect it by the ratio
// of unique to total words — very low ratio on a long string = degenerate.
function isDegenerateText(s) {
  const str = String(s || '');
  if (str.length < 120) return false;
  if (/(.{6,80}?)\1{4,}/.test(str)) return true;                 // same chunk repeated 5+ times
  const words = str.split(/[\s_]+/).filter(Boolean);
  if (words.length < 16) return false;
  const uniq = new Set(words.map((w) => w.toLowerCase())).size;
  return uniq / words.length < 0.35;
}

// Collapse obvious repetition and cap length so a stored suggestion is always readable.
function cleanText(s, maxLen) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/(\b.{4,60}?\b)(?:\s*\1){2,}/g, '$1');           // "phrase phrase phrase" -> "phrase"
  t = t.replace(/\b(\w+)(?:\s+\1\b){2,}/gi, '$1');               // "word word word" -> "word"
  t = t.replace(/(_[A-Za-z][A-Za-z]*)\1{2,}/g, '$1');            // "_And_And_And" -> "_And"
  if (t.length > maxLen) t = t.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  return t;
}

// Normalize one system suggestion; returns null if it's empty or irredeemably degenerate.
function sanitizeSuggestion(s) {
  const rawTitle = String(s.title || '').trim();
  const rawDetail = String(s.detail || '').trim();
  if (isDegenerateText(rawTitle) && isDegenerateText(rawDetail)) return null;     // pure garbage → drop
  const title = cleanText(rawTitle || rawDetail || '', 140) || '(untitled)';
  const detail = cleanText(rawDetail || rawTitle || '', 1200);
  if (title === '(untitled)' && !detail) return null;
  const cat = String(s.category || 'other').toLowerCase();
  const category = ['pipeline', 'metric', 'guardrail', 'data', 'other'].includes(cat) ? cat : 'other';
  const sev = String(s.severity || 'info').toLowerCase();
  const severity = ['info', 'low', 'high'].includes(sev) ? sev : 'info';
  return { category, title, detail, severity };
}

// Run the optimizer for ONE agent and persist its suggestions. Shared by the
// single-shot /api/lab/upgrade endpoint and the incremental whole-system flow
// (/upgrade/start + /upgrade/agent + /upgrade/finish). Never throws: any failure
// is captured in the returned diag so callers can keep going. Returns
// { diag, promptIds, systemIds, summary, raw }.
async function processAgentUpgrade(lab, llm, sysPrompt, upgradeRunId, runId, agentId, opts) {
  const d = { agentId, status: 'ok', reason: '', records: 0, failures: 0, anchors: 0, hasCompare: 0, promptChars: 0, outputChars: 0, parse: '', patches: 0, systems: 0 };
  const promptIds = [], systemIds = [];
  let summary = '', raw = '';
  let ctx;
  try { ctx = await buildUpgradeContext(lab, runId, agentId, opts); }
  catch (e) { d.status = 'skipped'; d.reason = e.message; return { diag: d, promptIds, systemIds, summary, raw: `[${agentId}] SKIPPED: ${e.message}` }; }
  d.records = ctx.counts.records; d.failures = ctx.counts.failures; d.anchors = ctx.counts.anchors;
  d.hasCompare = ctx.failures.filter((f) => f.compare).length; d.promptChars = (ctx.currentPrompt || '').length;
  if (!ctx.currentPrompt) { d.status = 'no_prompt'; d.reason = 'no captured prompt for this agent in the run (was the run mirrored to the DB with trace capture?)'; return { diag: d, promptIds, systemIds, summary, raw: `[${agentId}] no current prompt` }; }
  const userPrompt = formatUpgradeUserPrompt(ctx);
  let out = '';
  // Big optimizer responses (rich agents like observation-extractor / clinical-story)
  // were truncating at 8192 tokens → invalid/incomplete JSON. Give it the full ceiling.
  const maxTok = Number(process.env.UPGRADER_MAX_OUTPUT_TOKENS) || Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536;
  // Plain generation. NOTE: a responseSchema was tried here and made things worse — with the
  // large token budget the model fell into repetition loops (degenerate suggestions, dropped
  // patches, 500s). The robust parser below (incl. concat-fixed) handles malformed JSON, and
  // sanitizeSuggestion() downstream filters any degenerate output.
  try { out = await llm.generateContent(sysPrompt, userPrompt, null, { maxOutputTokens: maxTok }); }
  catch (e) { d.status = 'llm_error'; d.reason = e.message; return { diag: d, promptIds, systemIds, summary, raw: `[${agentId}] LLM ERROR: ${e.message}` }; }
  d.outputChars = (out || '').length;
  raw = `===== ${agentId} (${d.records} records, ${d.failures} failing, ${d.hasCompare} with comparison) =====\n${out}`;
  const { parsed, method } = extractUpgradeJson(out); d.parse = method;
  if (!parsed) { d.status = 'parse_failed'; d.reason = 'optimizer output was not valid JSON — see raw output'; return { diag: d, promptIds, systemIds, summary, raw }; }
  if (parsed.summary) summary = parsed.summary;
  for (const patch of (parsed.prompt_patches || [])) {
    const violation = protectedViolation(patch.patches || []);
    const id = await lab.insertPromptSuggestion({
      upgradeRunId, agentId: patch.agent_id || agentId, baseVersion: ctx.baseVersion, basePrompt: ctx.currentPrompt,
      rationale: patch.rationale, patches: patch.patches || [], fullPrompt: patch.full_prompt,
      confidence: num(patch.confidence), protectedBlocked: !!violation, protectedReason: violation,
    });
    promptIds.push(id); d.patches++;
  }
  for (const s of (parsed.system_suggestions || [])) {
    const clean = sanitizeSuggestion(s);
    if (!clean) continue;   // dropped: empty or degenerate repetition-loop output
    const id = await lab.insertSystemSuggestion({ upgradeRunId, ...clean });
    systemIds.push(id); d.systems++;
  }
  if (!d.patches && !d.systems) { d.status = 'no_changes'; d.reason = parsed.summary ? 'optimizer judged the prompt adequate' : 'optimizer returned no patches'; }
  return { diag: d, promptIds, systemIds, summary, raw };
}

const COMPARATOR_SYS = `You are a clinical documentation comparator scoring two SOAP notes. Compare the NOTERA note (system under test) against the GOLD reference note.
Score objectively, evidence-based, never rewarding fluent-but-unsupported text. Return ONLY valid JSON — no prose, no markdown:
{ "overall_score": 0-100, "verdict": "notera_better | gold_better | equivalent",
  "dimensions": [ {"name":"Faithfulness","notera":0-5,"gold":0-5,"comment":"short"},
                  {"name":"Completeness","notera":0-5,"gold":0-5,"comment":"short"},
                  {"name":"Structure","notera":0-5,"gold":0-5,"comment":"short"},
                  {"name":"Clarity","notera":0-5,"gold":0-5,"comment":"short"} ],
  "notera_missing": ["facts in gold missing from notera"],
  "notera_extra": ["facts in notera not supported by gold"],
  "key_differences": ["short phrases"], "summary": "2-3 sentence verdict" }`;

// A gold reference is "corrupt" when it is scheduling/admin/de-id noise rather than a real
// clinical note (mirrors eval/metrics.mjs isGoldCorrupt). Scoring Notera against it yields a
// false-low verdict (e.g. untitled-session-5 → 20), so we flag such fixtures and EXCLUDE them
// from the run-report aggregate + verdict counts.
function isGoldCorruptSrv(goldText) {
  const t = String(goldText || '');
  if (t.trim().length < 40) return true;
  if (/\b(subjective|objective|assessment|plan|hpi|chief complaint|presenting complaint|diagnosis|history of)\b/i.test(t)) return false;
  const words = (t.toLowerCase().match(/[a-z0-9][a-z0-9\-']*/g) || []);
  const dateish = words.filter((w) => /^\d+$/.test(w) || /\d{4}-\d{1,2}-\d{1,2}/.test(w)).length;
  const clinical = words.filter((w) => w.length > 3 && !/^\d+$/.test(w) && !/\d{4}-\d{1,2}-\d{1,2}/.test(w)).length;
  return clinical < 15 && dateish >= clinical;
}

/** Compute (and cache) a note-vs-gold comparison for one fixture .md. Reused by autocompare. */
async function computeComparison(dir, fileName, llm) {
  const cacheFp = path.join(RESULTS, dir, fileName.replace(/\.md$/, '') + '.compare.json');
  try { const cached = JSON.parse(fs.readFileSync(cacheFp, 'utf8')); return { ok: true, cached: true, ...cached }; } catch {}
  let generated = '', gold = '';
  try {
    const mdText = fs.readFileSync(path.join(RESULTS, dir, fileName), 'utf8');
    const secs = []; let cur = { title: '_head', body: [] };
    for (const ln of mdText.split('\n')) { const mm = ln.match(/──\s*(.+?)\s*──/); if (mm) { secs.push(cur); cur = { title: mm[1], body: [] }; } else cur.body.push(ln); }
    secs.push(cur);
    const findSec = (rx) => { const s = secs.find((x) => rx.test(x.title)); return s ? s.body.join('\n').trim() : ''; };
    generated = findSec(/generated/i); gold = findSec(/gold/i);
  } catch { return { ok: false, error: 'fixture not found' }; }
  if (!generated) return { ok: false, error: 'no generated note in fixture' };
  const goldCorrupt = isGoldCorruptSrv(gold);
  const prompt = `=== NOTERA NOTE (system under test) ===\n\n${generated}\n\n=== GOLD NOTE (reference) ===\n\n${gold || '(no gold reference available)'}\n\nCompare and return ONLY the JSON.`;
  const out = await llm.generateContent(COMPARATOR_SYS, prompt);
  const parsed = tryParseJsonSrv(out);
  if (!parsed) return { ok: false, error: 'could not parse comparison output' };
  parsed.gold_corrupt = goldCorrupt;   // flag so the aggregate can exclude corrupt-reference fixtures
  parsed.generatedAt = new Date().toISOString();
  try { fs.writeFileSync(cacheFp, JSON.stringify(parsed, null, 2)); } catch {}
  return { ok: true, cached: true, ...parsed };
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
  'hallucination-remover': [/\[PromptAgent\] hallucination-remover/, /\[hallucination-remover\]/i],
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
    if (password === PASSWORD) { res.writeHead(200, { 'Set-Cookie': session.cookie(session.issue()), 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    return json(res, 401, { error: 'wrong password' });
  }
  if (p === '/api/session') {
    const payload = session.verify(parseCookies(req)[session.COOKIE]);
    // sliding expiry: silently re-issue the cookie once it passes the halfway mark so an
    // actively-used session never lapses (industry "keep me signed in" behaviour).
    const headers = { 'Content-Type': 'application/json' };
    if (payload && session.needsRefresh(payload)) headers['Set-Cookie'] = session.cookie(session.issue());
    res.writeHead(200, headers); return res.end(JSON.stringify({ authed: !!payload }));
  }
  if (p === '/api/logout' && req.method === 'POST') { res.writeHead(200, { 'Set-Cookie': session.clearCookie(), 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }

  if (p.startsWith('/api/') && !authed(req)) return json(res, 401, { error: 'unauthorized' });

  if (p === '/api/scripts') {
    const fx = listFixtures();
    return json(res, 200, { presets: [{ id: 'all', label: `All fixtures (${fx.length})`, fixtures: [] }, ...fx.map((f) => ({ id: f, label: f, fixtures: [f] }))] });
  }

  if (p === '/api/runs' && req.method === 'POST') {
    const { fixtures = [] } = await readBody(req);
    // Materialize .txt for any selected slug that isn't on disk yet (DB-only patients).
    // Bounded by a timeout so a slow/unreachable DB can never hang the run start — any
    // slug that already has an on-disk fixture is unaffected.
    if (fixtures.length) {
      try {
        const lab = await getLab();
        await Promise.race([ensureFixtures(lab, fixtures), new Promise((_, rej) => setTimeout(() => rej(new Error('materialize timeout')), 20000))]);
      } catch { /* DB optional — run whatever exists on disk */ }
    }
    return json(res, 200, { runId: startRun(fixtures) });
  }
  // Full patient universe for the Run picker — sourced from the DB so ALL imported
  // patients are selectable by name even when they have no .txt fixture yet (scales to
  // any N). Falls back to on-disk fixtures when the DB is unavailable.
  if (p === '/api/run-patients' && req.method === 'GET') {
    const onDisk = new Set(listFixtures());
    let db = [];
    try { const lab = await getLab(); db = await lab.listPatients(); } catch { db = []; }
    if (db.length) {
      const patients = db
        .filter((r) => (r.transcript_len || 0) > 0)          // only runnable (has a transcript)
        .map((r) => ({ slug: r.slug, name: r.name || r.slug, hasFixture: onDisk.has(r.slug), hasGold: (r.gold_len || 0) > 0 }));
      return json(res, 200, { patients, total: patients.length, onDiskCount: onDisk.size, source: 'db' });
    }
    const patients = [...onDisk].sort().map((f) => ({ slug: f, name: f, hasFixture: true, hasGold: true }));
    return json(res, 200, { patients, total: patients.length, onDiskCount: onDisk.size, source: 'fixtures' });
  }
  if (p === '/api/runs' && req.method === 'GET') {
    for (const r of runs.values()) reconcileRunStatus(r);   // flip eternal-spinner / finished runs
    const progressOf = (dir) => { try { const p = JSON.parse(fs.readFileSync(path.join(RESULTS, dir, '_progress.json'), 'utf8')); return { done: p.done, total: p.total, current: p.current, phase: p.phase }; } catch { return null; } };
    return json(res, 200, [...runs.values()].map(({ proc, listeners, lines, ...r }) => ({ ...r, liveLines: (runs.get(r.id)?.lines || []).length, progress: r.resultDir ? progressOf(r.resultDir) : null })).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')).slice(0, 50));
  }
  let m;
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/kill$/)) && req.method === 'POST') { const r = runs.get(m[1]); if (r?.proc) { try { process.kill(-r.proc.pid, 'SIGTERM'); } catch { r.proc.kill('SIGTERM'); } r.status = 'killed'; } return json(res, 200, { ok: true }); }
  // Resume an interrupted scan: continue in its own result dir, skipping finished fixtures.
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/resume$/)) && req.method === 'POST') {
    const r = runs.get(m[1]); if (!r || !r.resultDir) return json(res, 400, { error: 'run has no result dir to resume' });
    if (r.status === 'running') return json(res, 400, { error: 'run is still running' });
    const newId = startRun(r.fixtures || [], { resumeDir: r.resultDir });
    return json(res, 200, { ok: true, runId: newId, resumeDir: r.resultDir });
  }
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
  if ((m = p.match(/^\/api\/runs\/([^/]+)$/)) && req.method === 'GET') {
    const r = runs.get(m[1]); if (!r) return json(res, 404, {});
    reconcileRunStatus(r);
    const { proc, listeners, lines, ...rest } = r;
    // after a backend restart the in-memory buffer is empty → serve the run's own log tail
    const outLines = (lines && lines.length) ? lines : (r.resultDir ? tailPipelineLog(r.resultDir) : []);
    return json(res, 200, { ...rest, lines: outLines, progress: r.resultDir ? _progressOf(r.resultDir) : null });
  }
  // Retry a finished/interrupted run FRESH (new result dir, same fixtures).
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/retry$/)) && req.method === 'POST') {
    const r = runs.get(m[1]); if (!r) return json(res, 400, { error: 'no run' });
    if (r.status === 'running') return json(res, 400, { error: 'run is still running' });
    const newId = startRun(r.fixtures || []);
    return json(res, 200, { ok: true, runId: newId });
  }

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
    // flood the run selector and the disk). The threshold is judged on the count of VALID
    // rows (empty sessions are skipped and don't count), so a real dataset of a few hundred
    // transcript/note pairs still gets fixtures even inside a much larger export.
    const FIXTURE_LIMIT = Number(process.env.ADMIN_MAX_FIXTURES || 1000);

    // 1) prepare rows synchronously so slugs are assigned deterministically, in order.
    // Support both nested Heidi shapes: transcript {raw_text|clean_text} and
    // soap_note {soap_note|assessment|plan|summary} or a plain string note.
    const rows = [], skipped = [];
    const noteOf = (sn) => {
      if (!sn) return '';
      if (typeof sn === 'string') return sn.trim();
      return [sn.soap_note, sn.assessment, sn.plan, sn.summary].filter(Boolean).map((x) => String(x).trim()).filter(Boolean).join('\n\n');
    };
    for (const s of sessions) {
      const name = (s.session_title || s.patient_name_fallback || s.subtitle || `Session ${s.id ?? ''}`).toString().trim() || 'Session';
      const t = s.transcript || {};
      const transcript_clean = ((typeof t === 'string' ? t : (t.clean_text || t.raw_text)) || '').trim();
      const transcript_raw = ((typeof t === 'string' ? t : (t.raw_text || t.clean_text)) || '').trim();
      const gold_note = noteOf(s.soap_note ?? s.note ?? s.notes);
      if (!transcript_clean && !gold_note) { skipped.push({ name, reason: 'empty session (no transcript and no note)' }); continue; }
      rows.push({ slug: uniqueSlug(name, s.heidi_session_id), name, s, transcript_raw, transcript_clean, gold_note });
    }
    const writeFixtures = rows.length <= FIXTURE_LIMIT;

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
        : `Imported ${rows.length} valid patients to the database, but did NOT write .txt run fixtures because that exceeds ADMIN_MAX_FIXTURES=${FIXTURE_LIMIT}. Without fixtures they won't appear in the Run tab. To get fixtures: set ADMIN_MAX_FIXTURES=${Math.max(rows.length, FIXTURE_LIMIT + 100)} in .env, restart the backend, and re-import (upsert is idempotent).`,
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

  // ── U-2: auto-run the comparison for every record of a run (safety-check corpus) ──
  if ((m = p.match(/^\/api\/lab\/runs\/(\d+)\/autocompare$/)) && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    try {
      const run = await lab.getRun(Number(m[1]));
      if (!run) return json(res, 404, { ok: false, error: 'run not found' });
      const dir = run.label;
      const fixtures = runFiles(dir).map((f) => f.fixture);
      const todo = fixtures.filter((fx) => { try { fs.accessSync(path.join(RESULTS, dir, fx + '.compare.json')); return false; } catch { return true; } });
      let done = 0, failed = 0;
      if (todo.length) {
        const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
        const llm = await createGeminiService();
        const CONC = Math.max(1, Number(process.env.ADMIN_COMPARE_CONCURRENCY || 4));
        let i = 0;
        const worker = async () => { while (i < todo.length) { const fx = todo[i++]; try { const r = await computeComparison(dir, fx + '.md', llm); r.ok ? done++ : failed++; } catch { failed++; } } };
        await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, () => worker()));
      }
      return json(res, 200, { ok: true, run: { id: run.id, label: dir }, total: fixtures.length, alreadyCached: fixtures.length - todo.length, generated: done, failed });
    } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: 'Auto-compare needs a valid GEMINI_API_KEY.' }); }
  }

  // ── U-3: preview the evidence that would be fed to the optimizer (no LLM spend) ──
  if (p === '/api/lab/upgrade/preview' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const { runId, agentId, failK, anchorM, ratio } = await readBody(req);
    if (!runId || !agentId) return json(res, 400, { ok: false, error: 'runId and agentId required' });
    if (!UPGRADER_AGENTS.includes(agentId)) return json(res, 400, { ok: false, error: `agent '${agentId}' is not upgrade-eligible` });
    try {
      const ctx = await buildUpgradeContext(lab, Number(runId), agentId, { failK: Number(failK) || 4, anchorM: Number(anchorM) || 2, ratio: ratio == null ? 0.5 : Number(ratio) });
      // don't ship full prompts/outputs to the client — just what the reviewer needs
      const slim = (r) => ({ slug: r.slug, name: r.name, score: r.score, metrics: r.metrics, compare: r.compare ? { overall_score: r.compare.overall_score, verdict: r.compare.verdict, notera_missing: r.compare.notera_missing, notera_extra: r.compare.notera_extra, key_differences: r.compare.key_differences } : null });
      return json(res, 200, { ok: true, run: ctx.run, agentId, hasRegistryRec: ctx.hasRegistryRec, baseVersion: ctx.baseVersion, counts: ctx.counts, currentPromptChars: (ctx.currentPrompt || '').length, failures: ctx.failures.map(slim), anchors: ctx.anchors.map(slim), optimizeSlugs: ctx.optimizeSlugs, validateSlugs: ctx.validateSlugs });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  // ── U-4: run the optimizer, persist suggestions ──────────────────────────────
  if (p === '/api/lab/upgrade' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const body = await readBody(req);
    const scope = body.scope === 'system' ? 'system' : 'agent';
    const runId = Number(body.runId);
    const opts = { failK: Number(body.failK) || 4, anchorM: Number(body.anchorM) || 2, ratio: body.ratio == null ? 0.5 : Number(body.ratio) };
    if (!runId) return json(res, 400, { ok: false, error: 'runId required' });
    const agents = scope === 'system' ? UPGRADER_AGENTS : [body.agentId];
    if (scope === 'agent' && (!body.agentId || !UPGRADER_AGENTS.includes(body.agentId))) return json(res, 400, { ok: false, error: 'valid agentId required for per-agent scope' });
    try {
      const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
      const llm = await createGeminiService();
      const sysPrompt = loadPromptSrv('system-upgrader');
      const upgradeRunId = await lab.createUpgradeRun({ sourceRunId: runId, scope, agentId: scope === 'agent' ? body.agentId : null, model: llm.model, inputSummary: { agents, opts } });
      const promptSuggestions = [], systemSuggestions = []; const rawParts = []; const diag = []; let summary = '';
      for (const agentId of agents) {
        const r = await processAgentUpgrade(lab, llm, sysPrompt, upgradeRunId, runId, agentId, opts);
        diag.push(r.diag); if (r.raw) rawParts.push(r.raw);
        for (const id of r.promptIds) promptSuggestions.push(id);
        for (const id of r.systemIds) systemSuggestions.push(id);
        if (r.summary && !summary) summary = r.summary;
      }
      await lab.finishUpgradeRun(upgradeRunId, { status: 'done', rawOutput: rawParts.join('\n\n').slice(0, 300000), summary, inputSummary: { agents, opts, diag } });
      return json(res, 200, { ok: true, upgradeRunId, scope, promptSuggestions: promptSuggestions.length, systemSuggestions: systemSuggestions.length, summary, diag });
    } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: 'Upgrade needs a valid GEMINI_API_KEY and a reachable Testing Lab DB.' }); }
  }

  // ── U-4b: INCREMENTAL whole-system upgrade (one short request per agent). ──────
  // Whole-system runs many sequential LLM calls; doing them in a single request can
  // exceed the dev-proxy / socket timeout and the connection gets reset. Instead the
  // client calls /start once, /agent per agent (each ~one LLM call, like per-agent),
  // then /finish. Robust: each step is independent and returns its own diag.
  if (p === '/api/lab/upgrade/start' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const body = await readBody(req);
    const scope = body.scope === 'system' ? 'system' : 'agent';
    const runId = Number(body.runId);
    const opts = { failK: Number(body.failK) || 4, anchorM: Number(body.anchorM) || 2, ratio: body.ratio == null ? 0.5 : Number(body.ratio) };
    if (!runId) return json(res, 400, { ok: false, error: 'runId required' });
    try {
      // Only process agents that actually have captured I/O in this run — keeps the
      // progress bar honest and avoids spending LLM calls on guaranteed skips.
      const captured = (await lab.agentsOfRun(runId)).map((r) => r.agent_id);
      let agents;
      if (scope === 'system') {
        agents = UPGRADER_AGENTS.filter((a) => captured.includes(a));
        if (!agents.length) return json(res, 200, { ok: false, error: 'This run has no captured agent I/O for any upgrade-eligible agent. Run a fresh batch (Run tab) so the pipeline is mirrored to the DB, then upgrade that run.' });
      } else {
        if (!body.agentId || !UPGRADER_AGENTS.includes(body.agentId)) return json(res, 400, { ok: false, error: 'valid agentId required for per-agent scope' });
        agents = [body.agentId];
      }
      const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
      const llm = await createGeminiService();
      const upgradeRunId = await lab.createUpgradeRun({ sourceRunId: runId, scope, agentId: scope === 'agent' ? body.agentId : null, model: llm.model, inputSummary: { agents, opts, incremental: true } });
      return json(res, 200, { ok: true, upgradeRunId, scope, agents, opts });
    } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
  }
  if (p === '/api/lab/upgrade/agent' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const body = await readBody(req);
    const upgradeRunId = Number(body.upgradeRunId), runId = Number(body.runId), agentId = body.agentId;
    const opts = { failK: Number(body.failK) || 4, anchorM: Number(body.anchorM) || 2, ratio: body.ratio == null ? 0.5 : Number(body.ratio) };
    if (!upgradeRunId || !runId || !agentId) return json(res, 400, { ok: false, error: 'upgradeRunId, runId and agentId required' });
    if (!UPGRADER_AGENTS.includes(agentId)) return json(res, 400, { ok: false, error: `agent '${agentId}' is not upgrade-eligible` });
    try {
      const { createGeminiService } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'LLMService.js')).href);
      const llm = await createGeminiService();
      const sysPrompt = loadPromptSrv('system-upgrader');
      const r = await processAgentUpgrade(lab, llm, sysPrompt, upgradeRunId, runId, agentId, opts);
      return json(res, 200, { ok: true, diag: r.diag, promptSuggestions: r.promptIds.length, systemSuggestions: r.systemIds.length, summary: r.summary, raw: r.raw });
    } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: 'Upgrade needs a valid GEMINI_API_KEY and a reachable Testing Lab DB.' }); }
  }
  if (p === '/api/lab/upgrade/finish' && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const body = await readBody(req);
    const upgradeRunId = Number(body.upgradeRunId);
    if (!upgradeRunId) return json(res, 400, { ok: false, error: 'upgradeRunId required' });
    try {
      const diag = Array.isArray(body.diag) ? body.diag : [];
      const agents = diag.map((d) => d && d.agentId).filter(Boolean);
      const rawOutput = typeof body.raw === 'string' ? body.raw.slice(0, 300000) : (Array.isArray(body.rawParts) ? body.rawParts.join('\n\n').slice(0, 300000) : null);
      await lab.finishUpgradeRun(upgradeRunId, { status: body.status === 'error' ? 'error' : 'done', rawOutput, summary: body.summary || null, errorMessage: body.errorMessage || null, inputSummary: { agents, opts: body.opts || {}, diag, incremental: true } });
      return json(res, 200, { ok: true, upgradeRunId });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  // ── U reads: list + one upgrade run (with children) ──────────────────────────
  if (p === '/api/lab/upgrades' && req.method === 'GET') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { runs: [], error: e.message, hint: labHint }); }
    try { return json(res, 200, { runs: await lab.listUpgradeRuns() }); } catch (e) { return json(res, 200, { runs: [], error: e.message }); }
  }
  // Global feed of every system-level (non-prompt) suggestion — for the System Ideas tab.
  if (p === '/api/lab/system-suggestions' && req.method === 'GET') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { suggestions: [], error: e.message, hint: labHint }); }
    try { return json(res, 200, { suggestions: await lab.allSystemSuggestions() }); } catch (e) { return json(res, 200, { suggestions: [], error: e.message }); }
  }
  if ((m = p.match(/^\/api\/lab\/upgrade\/(\d+)$/)) && req.method === 'GET') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { error: e.message, hint: labHint }); }
    try {
      const run = await lab.getUpgradeRun(Number(m[1]));
      if (!run) return json(res, 404, { error: 'not found' });
      const prompts = await lab.promptSuggestionsFor(run.id);
      // attach current prompt + patched preview so the UI can diff without a round-trip
      const withPreview = prompts.map((s) => {
        const cur = resolveCurrentPrompt(s.agent_id);
        // Diff against the exact prompt the patches were computed on (persisted), so
        // in-code prompts (e.g. clinical-story) diff correctly, not against ''.
        const baseText = s.base_prompt || cur.text || '';
        const applied = applyPatches(baseText, s.patches || []);
        const drift = s.base_version != null && cur.version != null && cur.version !== s.base_version;
        return { ...s, current_prompt: baseText, patched_prompt: applied.applied.length ? applied.text : (s.full_prompt || applied.text), patch_failed: applied.failed.length, base_drift: drift, current_version: cur.version };
      });
      return json(res, 200, { run, prompt_suggestions: withPreview, system_suggestions: await lab.systemSuggestionsFor(run.id) });
    } catch (e) { return json(res, 200, { error: e.message }); }
  }

  // ── U publish/dismiss a prompt suggestion (goes through the existing versioning) ──
  if ((m = p.match(/^\/api\/lab\/suggestions\/(\d+)\/publish$/)) && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message, hint: labHint }); }
    const { finalPrompt } = await readBody(req);
    try {
      const s = await lab.getPromptSuggestion(Number(m[1]));
      if (!s) return json(res, 404, { ok: false, error: 'suggestion not found' });
      if (s.protected_blocked) return json(res, 200, { ok: false, error: `blocked by safety guard: ${s.protected_reason}. Edit it manually in the Prompts tab if you're sure.` });
      if (!readPromptRec(s.agent_id)) return json(res, 200, { ok: false, error: `agent '${s.agent_id}' has no registry entry, so it can't be published from here.` });
      // final text: explicit override → applied patches on the persisted base → full rewrite
      let text = finalPrompt && String(finalPrompt).trim();
      if (!text) { const base = s.base_prompt || resolveCurrentPrompt(s.agent_id).text || ''; const ap = applyPatches(base, s.patches || []); text = ap.applied.length ? ap.text : (s.full_prompt || ''); }
      if (!text) return json(res, 200, { ok: false, error: 'nothing to publish (no patches applied and no full prompt)' });
      savePromptDraft(s.agent_id, text, `System Upgrader suggestion #${s.id}`);
      const rec = publishPromptDraft(s.agent_id, 'system-upgrader');
      await lab.setPromptSuggestionStatus(s.id, 'published', rec.publishedVersion);
      return json(res, 200, { ok: true, agentId: s.agent_id, publishedVersion: rec.publishedVersion });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if ((m = p.match(/^\/api\/lab\/suggestions\/(\d+)\/dismiss$/)) && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    try { await lab.setPromptSuggestionStatus(Number(m[1]), 'dismissed'); return json(res, 200, { ok: true }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if ((m = p.match(/^\/api\/lab\/system-suggestions\/(\d+)\/status$/)) && req.method === 'POST') {
    let lab; try { lab = await getLab(); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    const { status } = await readBody(req);
    try { await lab.setSystemSuggestionStatus(Number(m[1]), status === 'accepted' ? 'accepted' : status === 'dismissed' ? 'dismissed' : 'open'); return json(res, 200, { ok: true }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
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
      if ((mm = p.match(/^\/api\/lab\/run\/(\d+)\/upgrade-agents$/))) return json(res, 200, { agents: (await lab.agentsOfRun(Number(mm[1]))).map((r) => r.agent_id) });
      if (p === '/api/lab/compare') {
        const a = Number(u.searchParams.get('a')), b = Number(u.searchParams.get('b'));
        const [ma, mb] = await Promise.all([lab.metricsForRun(a), lab.metricsForRun(b)]);
        return json(res, 200, { a: ma, b: mb });
      }
    } catch (e) { return json(res, 200, { error: e.message, hint: labHint }); }
    // fall through for unknown /api/lab/* GETs handled elsewhere (e.g. rerun POST)
  }

  // ── original source transcript for a fixture (what the run was actually fed) ──
  if (p === '/api/results/transcript') {
    const base = safeName(u.searchParams.get('name') || '').replace(/\.(md|json|txt)$/i, '');
    if (!base) return json(res, 400, { ok: false, error: 'name required' });
    // 1) the gold fixture on disk IS the exact input the pipeline consumed
    try {
      const raw = fs.readFileSync(path.join(GOLD, base + '.txt'), 'utf8');
      const idx = raw.search(/^\s*Subjective\s*:/im);
      return json(res, 200, {
        ok: true, source: 'fixture', fixture: base + '.txt',
        transcript: (idx === -1 ? raw : raw.slice(0, idx)).trim(),
        gold: idx === -1 ? '' : raw.slice(idx).trim(),
      });
    } catch { /* not on disk — fall through to the DB */ }
    // 2) imported patients (large imports skip writing fixtures) live only in the DB
    try {
      const lab = await getLab();
      const pt = await lab.getPatientBySlug(base);
      if (pt) return json(res, 200, { ok: true, source: 'database', transcript: pt.transcript_clean || pt.transcript_raw || '', gold: pt.gold_note || '' });
    } catch { /* DB unavailable */ }
    return json(res, 200, { ok: false, error: `No source transcript found for "${base}".` });
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
Score objectively, evidence-based, never rewarding fluent-but-unsupported text.
IMPORTANT: the GOLD note is de-identified and may contain SYNTHETIC or corrupted DATE artifacts (shifted years, placeholder dates). Do NOT penalize Notera for not matching a corrupted or implausible gold date, and do not treat a date mismatch as a factual error unless the transcript itself gives the date.
Return ONLY valid JSON matching this schema — no prose, no markdown:
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
  // ── Second Opinion: independent DeepSeek critique of the generated note (no gold) ──
  if (p === '/api/results/critique') {
    const isPost = req.method === 'POST';
    const body = isPost ? await readBody(req) : {};
    const d = safeRunDir(isPost ? body.dir : u.searchParams.get('dir'));
    const f = safeName(isPost ? body.name : u.searchParams.get('name'));
    if (!d || !f) return json(res, 400, { error: 'bad args' });
    const cacheFp = path.join(RESULTS, d, f.replace(/\.md$/, '') + '.critique.json');
    if (!isPost) { try { return json(res, 200, { cached: true, ...JSON.parse(fs.readFileSync(cacheFp, 'utf8')) }); } catch { return json(res, 200, { cached: false }); } }
    // pull the GENERATED note out of the fixture .md
    let generated = '';
    try {
      const mdText = fs.readFileSync(path.join(RESULTS, d, f), 'utf8');
      const secs = []; let cur = { title: '_head', body: [] };
      for (const ln of mdText.split('\n')) { const mm = ln.match(/──\s*(.+?)\s*──/); if (mm) { secs.push(cur); cur = { title: mm[1], body: [] }; } else cur.body.push(ln); }
      secs.push(cur);
      const findSec = (rx) => { const s = secs.find((x) => rx.test(x.title)); return s ? s.body.join('\n').trim() : ''; };
      generated = findSec(/generated/i);
    } catch { return json(res, 404, { error: 'fixture not found' }); }
    if (!generated) return json(res, 404, { error: 'no generated note in fixture' });
    // resolve the source transcript (gold fixture on disk, else the imported patient in the DB)
    const base = f.replace(/\.(md|json|txt)$/i, '');
    let transcript = '';
    try { const raw = fs.readFileSync(path.join(GOLD, base + '.txt'), 'utf8'); const idx = raw.search(/^\s*Subjective\s*:/im); transcript = (idx === -1 ? raw : raw.slice(0, idx)).trim(); }
    catch { try { const lab = await getLab(); const pt = await lab.getPatientBySlug(base); transcript = pt ? (pt.transcript_clean || pt.transcript_raw || '') : ''; } catch { /* no transcript */ } }
    // optional: hand the reviewer the published generation prompts as context
    let promptContext = '';
    try { promptContext = listPromptRecs().map((r) => { const v = r.publishedVersion ? readPromptVersion(r.id, r.publishedVersion) : null; return v && v.systemInstruction ? `# ${r.label || r.id}\n${v.systemInstruction}` : ''; }).filter(Boolean).join('\n\n'); } catch { /* prompts optional */ }
    try {
      const { critiqueNote } = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'deepseek.js')).href);
      const out = await critiqueNote({ transcript, note: generated, promptContext });
      if (out.ok === false) return json(res, 200, out);
      try { fs.writeFileSync(cacheFp, JSON.stringify(out, null, 2)); } catch {}
      return json(res, 200, { cached: true, ...out });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, hint: 'The Second Opinion reviewer needs DEEPSEEK_API_KEY in the backend .env.' });
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

  // ── Metrics v2 · registry (typed metric defs for the UI) ──────────────────────
  if (p === '/api/metrics/registry') {
    const { describeMetric, FAMILIES, HEADLINE_KEYS } = await import(pathToFileURL(path.join(__dirname, '..', 'metrics', 'registry.js')).href);
    // describe whatever keys appear in the latest run so the UI has labels/polarity
    let keys = new Set(HEADLINE_KEYS);
    try { const latest = listResultRuns()[0]; if (latest) { const s = JSON.parse(fs.readFileSync(path.join(RESULTS, latest.dir, '_summary.json'), 'utf8')); for (const r of (s.rows || [])) for (const k of Object.keys(r)) keys.add(k); } } catch {}
    return json(res, 200, { families: FAMILIES, headline: HEADLINE_KEYS, defs: [...keys].map((k) => describeMetric(k)) });
  }

  // ── Metrics v2 · run report (Eval Analyst: aggregate all comparisons + LLM synth) ─
  if (p === '/api/metrics/run-summary') {
    const isPost = req.method === 'POST';
    const body = isPost ? await readBody(req) : {};
    const d = safeRunDir(isPost ? body.dir : u.searchParams.get('dir'));
    if (!d) return json(res, 400, { error: 'dir required' });
    const cacheFp = path.join(RESULTS, d, '_run_summary.json');
    if (!isPost) { try { return json(res, 200, { cached: true, ...JSON.parse(fs.readFileSync(cacheFp, 'utf8')) }); } catch { return json(res, 200, { cached: false }); } }
    // gather every per-fixture comparison + the metric summary
    let compares = [], metricSummary = null;
    try {
      const dir = path.join(RESULTS, d);
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.compare.json'))) {
        try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (c && c.ok !== false) compares.push({ fixture: f.replace(/\.compare\.json$/, ''), ...c }); } catch {}
      }
      try { metricSummary = JSON.parse(fs.readFileSync(path.join(dir, '_summary.json'), 'utf8')).summary || null; } catch {}
    } catch { return json(res, 404, { error: 'run not found' }); }
    if (!compares.length) return json(res, 200, { ok: false, error: 'no comparison scores in this run', hint: 'Open Results and generate comparisons (or turn on Auto) for this run first.' });
    try {
      const { buildRunSummary } = await import(pathToFileURL(path.join(__dirname, '..', 'metrics', 'runSummary.js')).href);
      const out = await buildRunSummary(compares, metricSummary);
      try { fs.writeFileSync(cacheFp, JSON.stringify(out, null, 2)); } catch {}
      return json(res, 200, { ok: true, cached: true, dir: d, ...out });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  // ── Metrics v2 · failure-taxonomy trend (M): aggregate run-report failure themes ─
  if (p === '/api/metrics/failure-trend') {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const totals = {}; const byRun = [];
    for (const rr of listResultRuns().slice(0, 20)) {
      let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(RESULTS, rr.dir, '_run_summary.json'), 'utf8')); } catch { continue; }
      const themes = Array.isArray(rep.failure_themes) ? rep.failure_themes : [];
      if (!themes.length) continue;
      byRun.push({ dir: rr.dir, avg: rep.avg_overall ?? null, themes: themes.map((t) => ({ theme: t.theme, count: t.count || 0 })) });
      for (const t of themes) { const k = norm(t.theme); if (!k) continue; (totals[k] ??= { theme: t.theme, total: 0, runs: 0 }); totals[k].total += (t.count || 0); totals[k].runs += 1; }
    }
    const themes = Object.values(totals).sort((a, b) => b.total - a.total).slice(0, 12);
    return json(res, 200, { themes, byRun });
  }

  // ── Metrics v2 · run index (fixture sets per run, for overlap-aware selection) ─
  if (p === '/api/metrics/run-index') {
    const out = [];
    for (const rr of listResultRuns()) {
      let rows = [], summary = null;
      try { const s = JSON.parse(fs.readFileSync(path.join(RESULTS, rr.dir, '_summary.json'), 'utf8')); rows = s.rows || []; summary = s.summary || null; } catch {}
      out.push({ dir: rr.dir, hasData: rows.length > 0, n: rows.length, fixtures: rows.map((r) => String(r.id)).filter(Boolean), summary });
    }
    return json(res, 200, out);
  }

  // ── Metrics v2 · N-run paired comparison workbench (P2) ───────────────────────
  if (p === '/api/metrics/compare-runs' && req.method === 'POST') {
    const body = await readBody(req);
    const baseDir = safeRunDir(body.baseDir);
    const runDirs = (Array.isArray(body.runDirs) ? body.runDirs : []).map(safeRunDir).filter((d) => d && d !== baseDir);
    if (!baseDir || !runDirs.length) return json(res, 400, { error: 'baseDir and at least one distinct runDir required' });
    const load = (d) => { try { return JSON.parse(fs.readFileSync(path.join(RESULTS, d, '_summary.json'), 'utf8')).rows || []; } catch { return []; } };
    const baseRows = load(baseDir);
    if (!baseRows.length) return json(res, 404, { error: 'baseline run has no per-fixture rows (re-run the tester)' });
    const targets = runDirs.map((d) => ({ dir: d, rows: load(d) }));
    const { buildComparison } = await import(pathToFileURL(path.join(__dirname, '..', 'metrics', 'compare.js')).href);
    const out = buildComparison(baseRows, targets, { focusKey: body.focusKey, system: body.system || null });
    return json(res, 200, { ok: true, baseDir, ...out });
  }

  // ── prompts registry ───────────────────────────────────────────────────────
  if (p === '/api/prompts' && req.method === 'GET') {
    return json(res, 200, { readOnly: PROMPTS_READONLY, prompts: listPromptRecs().map((r) => ({
      id: r.id, agent: r.agent, file: r.file, label: r.label, stage: r.stage, description: r.description || '',
      kind: r.kind || 'agent', vars: r.vars || [], active: r.active === true, order: (typeof r.order === 'number' ? r.order : null),
      freeform: r.freeform === true, maxOutputTokens: (typeof r.maxOutputTokens === 'number' ? r.maxOutputTokens : null),
      publishedVersion: r.publishedVersion || null, hasDraft: !!r.draft, updatedAt: r.updatedAt })) });
  }
  // Export EVERY prompt's latest stored version as a .txt inside one .zip (properly named).
  if (p === '/api/prompts/export' && req.method === 'GET') {
    const files = [];
    for (const rec of listPromptRecs()) {
      let text = '', suffix = '';
      if (rec.publishedVersion) { const v = readPromptVersion(rec.id, rec.publishedVersion); if (v && v.systemInstruction) { text = v.systemInstruction; suffix = `_v${rec.publishedVersion}`; } }
      if (!text && rec.draft && rec.draft.systemInstruction) { text = rec.draft.systemInstruction; suffix = '_draft'; }
      if (!text) continue;   // no stored version (uses in-code fallback) → nothing to export
      const header = `# ${rec.label || rec.id}\n# id: ${rec.id}${rec.agent ? `  · agent: ${rec.agent}` : ''}${rec.publishedVersion ? `  · published v${rec.publishedVersion}` : '  · draft (unpublished)'}\n# exported ${new Date().toISOString()}\n\n`;
      files.push({ name: `${safeName(rec.id)}${suffix}.txt`, data: Buffer.from(header + text, 'utf8') });
    }
    if (!files.length) return json(res, 200, { ok: false, error: 'No stored prompt versions to export.' });
    const zip = zipStore(files);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="notera-prompts-${stamp}.zip"`, 'Content-Length': zip.length });
    res.end(zip);
    return;
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
