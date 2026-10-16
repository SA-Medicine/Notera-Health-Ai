// ─────────────────────────────────────────────────────────────────────────────
// Notera Lab — the testing + self-improvement service (runs on the Google VM, NOT part of the production backend).
//   evaluate  : run the real v2 pipeline over gold (transcript → expert note) pairs, score every note
//   compare   : blind pairwise LLM judge between two runs (completeness / accuracy / concision)
//   improve   : a stronger model reads the worst failures + the current prompt and proposes a better prompt
//   validate  : re-run a candidate prompt on the SAME notes (A/B) and on a FRESH sample (generalisation)
// Promotion to production happens in the admin console (POST /api/console/prompts/promote), never here.
// Auth: every request must carry X-Lab-Key (injected by the admin site's Worker after it verified an admin session).
// Storage: JSON files under LAB_DATA_DIR (a docker volume) so runs survive restarts.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateNote } from '../src/orchestrator/generateNote.js';
import { defaultWriterPrompt } from '../src/orchestrator/generateNoteV2.js';
import { getActivePrompt } from '../src/orchestrator/promptStore.js';
import { createGeminiService } from '../src/services/LLMService.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const GOLD = process.env.LAB_GOLD_DIR || path.join(ROOT, 'data', 'gold');
const DATA = process.env.LAB_DATA_DIR || path.join(ROOT, 'lab-data');
const KEY = process.env.LAB_KEY || '';
const JUDGE_MODEL = process.env.LAB_JUDGE_MODEL || 'gemini-2.5-pro';
const IMPROVE_MODEL = process.env.LAB_IMPROVE_MODEL || 'gemini-2.5-pro';
for (const d of ['runs', 'judges', 'candidates']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
if (process.env.NORMALIZE_DEID_DATES === undefined) process.env.NORMALIZE_DEID_DATES = '1';   // gold corpus uses synthetic ISO date placeholders

const M = await import(pathToFileURL(path.join(ROOT, 'eval', 'metrics.mjs')).href);

// ── helpers ─────────────────────────────────────────────────────────────────
const uid = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const splitGold = (raw) => { const i = raw.search(/^\s*Subjective\s*:/im); return i === -1 ? { transcript: raw.trim(), gold: '' } : { transcript: raw.slice(0, i).trim(), gold: raw.slice(i).trim() }; };
const noteToText = (note) => {
  const s = note.subjective || {}, pmh = note.past_medical_history || {}, o = note.objective || {};
  const ap = (note.assessment_and_plan || []).map((i) => [i.issue, i.diagnosis, i.assessment, (i.differential_diagnoses || []).join(' '), i.investigations_planned, i.treatment_planned, i.referrals].filter(Boolean).join(' ')).join('\n');
  return [...Object.values(s), ...Object.values(pmh), ...Object.values(o), ap].filter(Boolean).join('\n');
};
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// gold index: only fixtures that can be scored fairly (real transcript, non-corrupt gold)
let _index = null;
function goldIndex() {
  if (_index) return _index;
  _index = fs.readdirSync(GOLD).filter((f) => f.endsWith('.txt')).sort().map((f) => {
    const id = f.replace(/\.txt$/, ''); const raw = fs.readFileSync(path.join(GOLD, f), 'utf8'); const { transcript, gold } = splitGold(raw);
    return { id, tChars: transcript.length, gChars: gold.length, ok: transcript.length >= 400 && gold.length >= 300 && !M.isGoldCorrupt(gold) };
  });
  return _index;
}
const loadFixture = (id) => { if (!/^[\w.\-]+$/.test(id)) throw new Error('bad id'); return splitGold(fs.readFileSync(path.join(GOLD, id + '.txt'), 'utf8')); };

// ── runs ────────────────────────────────────────────────────────────────────
const runs = new Map();   // id -> run (in memory while active; persisted always)
const runFile = (id) => path.join(DATA, 'runs', id + '.json');
const notesFile = (id) => path.join(DATA, 'runs', id + '.notes.json');
const persist = (run) => writeJson(runFile(run.id), { ...run, cancel: undefined });

async function resolvePrompt(cfg) {
  if (cfg.promptText) return { text: cfg.promptText, source: cfg.promptSource || 'custom' };
  if (cfg.candidateId) { const c = readJson(path.join(DATA, 'candidates', cfg.candidateId + '.json')); if (!c) throw new Error('candidate not found'); return { text: c.text, source: 'candidate:' + cfg.candidateId }; }
  if (cfg.prompt === 'default') return { text: defaultWriterPrompt(), source: 'default' };
  const active = await getActivePrompt('v2-writer');
  return { text: active || defaultWriterPrompt(), source: active ? 'production-active' : 'default' };
}

function pickIds(cfg) {
  if (Array.isArray(cfg.ids) && cfg.ids.length) return cfg.ids.slice(0, 400);
  const pool = goldIndex().filter((x) => x.ok && !(cfg.exclude || []).includes(x.id));
  const rnd = mulberry32(Number(cfg.seed) || 1);
  const arr = pool.map((x) => x.id); for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, Math.min(Math.max(1, Number(cfg.n) || 20), 400));
}

async function startRun(cfg) {
  const prompt = await resolvePrompt(cfg);
  const ids = pickIds(cfg);
  const run = { id: uid('run'), label: String(cfg.label || '').slice(0, 80), status: 'running', createdAt: new Date().toISOString(), finishedAt: null,
    config: { n: ids.length, seed: cfg.seed || 1, exclude: cfg.exclude?.length || 0, promptSource: prompt.source, promptChars: prompt.text.length, writerModel: cfg.writerModel || null, writerTemp: cfg.writerTemp ?? null, writerTopP: cfg.writerTopP ?? null },
    ids, prompt: prompt.text, progress: { done: 0, total: ids.length }, rows: [], summary: null };
  runs.set(run.id, run); persist(run);
  const notes = {};
  (async () => {
    let next = 0;
    const worker = async () => {
      while (next < ids.length && run.status === 'running') {
        const id = ids[next++]; const t0 = Date.now();
        try {
          const { transcript, gold } = loadFixture(id);
          const r = await generateNote({ transcript, specialty: 'auto', noteType: 'consultation', clinicianId: 'lab' },
            { persist: false, mode: 'v2', writerPrompt: prompt.text, writerModel: cfg.writerModel || undefined, writerTemp: cfg.writerTemp, writerTopP: cfg.writerTopP });
          const noteText = noteToText(r.note);
          const sc = M.scoreNote({ note: r.note, noteText, goldText: gold, entities: [] });
          run.rows.push({ id, ms: Date.now() - t0, note_words: noteText.split(/\s+/).filter(Boolean).length, schema_valid: sc.schema_valid, section_coverage: sc.section_coverage, similarity_to_gold: sc.similarity_to_gold, omission_rate: sc.omission_rate, story_flow: sc.story_flow, gold_corrupt: sc.gold_corrupt, meds_unsupported: sc.meds_unsupported, omission_missed: sc.omission_missed });
          notes[id] = r.renderedNote || '';
        } catch (e) { run.rows.push({ id, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200), schema_valid: false, section_coverage: 0, similarity_to_gold: 0, meds_unsupported: [] }); }
        run.progress.done = run.rows.length; run.summary = M.aggregate(run.rows);
        if (run.rows.length % 3 === 0) { persist(run); writeJson(notesFile(run.id), notes); }
      }
    };
    await Promise.all(Array.from({ length: Number(process.env.LAB_CONCURRENCY) || 3 }, worker));
    run.status = run.status === 'cancelled' ? 'cancelled' : 'done'; run.finishedAt = new Date().toISOString(); run.summary = M.aggregate(run.rows);
    persist(run); writeJson(notesFile(run.id), notes);
  })().catch((e) => { run.status = 'error'; run.error = String(e.message || e); persist(run); });
  return run.id;
}
const runView = (r, full = false) => ({ id: r.id, label: r.label, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, config: r.config, progress: r.progress, summary: r.summary, error: r.error, ...(full ? { rows: r.rows } : {}) });
const loadRun = (id) => runs.get(id) || readJson(runFile(id));
// a run that was "running" when the process died is interrupted, not eternally spinning
for (const f of fs.readdirSync(path.join(DATA, 'runs')).filter((x) => /^run_.*\d\.json$|^run_[a-z0-9]+\.json$/.test(x) && !x.endsWith('.notes.json'))) {
  const r = readJson(path.join(DATA, 'runs', f)); if (r && r.status === 'running') { r.status = 'interrupted'; writeJson(path.join(DATA, 'runs', f), r); }
}

// ── judge (blind pairwise) ──────────────────────────────────────────────────
const JUDGE_SYS = `You are a senior physician comparing two AI-written SOAP notes (A and B) for the SAME consultation.
You are given the TRANSCRIPT (ground truth of what was said) and a clinician-written GOLD note (reference for what a good note keeps).
Score each note 1-10 on:
- completeness: captures the clinically important facts the gold note keeps (diagnoses, meds+doses, results, plan, follow-up, referrals)
- accuracy: every statement is supported by the transcript (penalise invented or distorted facts hard)
- concision: specific facts only, no padding or repetition
Return JSON {"A":{"completeness":n,"accuracy":n,"concision":n},"B":{...},"winner":"A"|"B"|"tie","note":"one short sentence"}.`;
async function startJudge(aId, bId, limit = 30) {
  const A = loadRun(aId), B = loadRun(bId); if (!A || !B) throw new Error('run not found');
  const nA = readJson(notesFile(aId), {}), nB = readJson(notesFile(bId), {});
  const common = A.rows.filter((r) => !r.error && !r.gold_corrupt && nA[r.id] && nB[r.id] && B.rows.some((x) => x.id === r.id && !x.error)).map((r) => r.id).slice(0, limit);
  const job = { id: uid('judge'), a: aId, b: bId, status: 'running', createdAt: new Date().toISOString(), progress: { done: 0, total: common.length }, items: [], summary: null };
  writeJson(path.join(DATA, 'judges', job.id + '.json'), job);
  (async () => {
    const llm = await createGeminiService(null, { model: JUDGE_MODEL }); llm._agent = 'lab-judge'; let next = 0;
    const tot = { A: { completeness: 0, accuracy: 0, concision: 0 }, B: { completeness: 0, accuracy: 0, concision: 0 } }; const wins = { A: 0, B: 0, tie: 0 }; let n = 0;
    const worker = async () => { while (next < common.length) {
      const id = common[next++]; const { transcript, gold } = loadFixture(id); const flip = Math.random() < 0.5; const [x, y] = flip ? [nB[id], nA[id]] : [nA[id], nB[id]];
      try {
        const raw = await llm.generateContent(JUDGE_SYS, `=== TRANSCRIPT ===\n${transcript.slice(0, 60000)}\n\n=== GOLD NOTE ===\n${gold.slice(0, 8000)}\n\n=== NOTE A ===\n${x}\n\n=== NOTE B ===\n${y}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 2500, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 1024, hedgeMs: 0 });
        const r = JSON.parse(raw.replace(/^```json|```$/g, '')); const pa = flip ? r.B : r.A, pb = flip ? r.A : r.B;
        const w = r.winner === 'tie' ? 'tie' : ((r.winner === 'A') !== flip ? 'A' : 'B'); wins[w]++; n++;
        for (const k of Object.keys(tot.A)) { tot.A[k] += Number(pa?.[k] || 0); tot.B[k] += Number(pb?.[k] || 0); }
        job.items.push({ id, winner: w, A: pa, B: pb, note: r.note || '' });
      } catch (e) { job.items.push({ id, error: String(e.message).slice(0, 120) }); }
      job.progress.done = job.items.length;
    } };
    await Promise.all(Array.from({ length: 3 }, worker));
    const avg = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, n ? +(v / n).toFixed(2) : 0]));
    job.summary = { n, wins, A: avg(tot.A), B: avg(tot.B) }; job.status = 'done'; writeJson(path.join(DATA, 'judges', job.id + '.json'), job);
  })().catch((e) => { job.status = 'error'; job.error = String(e.message); writeJson(path.join(DATA, 'judges', job.id + '.json'), job); });
  return job.id;
}

// ── improve: propose a better prompt from the worst failures ───────────────
const IMPROVE_SYS = `You are a prompt engineer improving the system prompt of a clinical scribe that writes SOAP notes as strict JSON from a consultation transcript.
You get the CURRENT PROMPT and several FAILURES: for each, the transcript excerpt, the note the model wrote, the clinician's GOLD note, the gold terms the note missed, and its scores.
1. Diagnose the RECURRING failure patterns across the failures (facts dropped, wrong section, invented content, padding, missing diagnosis/plan lines, wrong tone, over-long lines...).
2. Write an IMPROVED prompt that fixes those patterns.
Hard constraints: keep every existing hard rule, the field-placement rules and the strict-JSON/schema instruction; make targeted additions or rewordings, not a rewrite; add NOTHING specific to the examples (no names, drugs, dates or numbers from them); keep the length within +/-20% of the current prompt; do not weaken grounding or anti-hallucination rules.
Return JSON: {"patterns":["..."],"changes":["what you changed and why"],"prompt":"<the full improved prompt text>"}.`;
async function improve(runId, k = 6) {
  const run = loadRun(runId); if (!run) throw new Error('run not found');
  const notes = readJson(notesFile(runId), {});
  const worst = run.rows.filter((r) => !r.error && !r.gold_corrupt && notes[r.id]).map((r) => ({ ...r, badness: (r.omission_rate || 0) * 0.6 + (1 - (r.similarity_to_gold || 0)) * 0.4 })).sort((a, b) => b.badness - a.badness).slice(0, Math.min(Math.max(2, k), 10));
  if (!worst.length) throw new Error('no scored notes in this run');
  const cases = worst.map((r, i) => { const { transcript, gold } = loadFixture(r.id); return `--- FAILURE ${i + 1} (similarity ${r.similarity_to_gold}, omission ${r.omission_rate}) ---\nTRANSCRIPT (excerpt):\n${transcript.slice(0, 3500)}\n\nMODEL NOTE:\n${notes[r.id].slice(0, 3500)}\n\nGOLD NOTE:\n${gold.slice(0, 3500)}\n\nGOLD TERMS MISSED: ${(r.omission_missed || []).slice(0, 25).join(', ')}`; }).join('\n\n');
  const llm = await createGeminiService(null, { model: IMPROVE_MODEL }); llm._agent = 'lab-improve';
  const raw = await llm.generateContent(IMPROVE_SYS, `=== CURRENT PROMPT ===\n${run.prompt}\n\n=== FAILURES ===\n${cases}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 24000, temperature: 0.4, responseMimeType: 'application/json', timeoutMs: 240000, retries: 1, thinkingBudget: 2048, hedgeMs: 0 });
  const out = JSON.parse(raw.replace(/^```json|```$/g, ''));
  const text = String(out.prompt || '');
  if (text.length < run.prompt.length * 0.7 || text.length > run.prompt.length * 1.4) throw new Error(`improved prompt length ${text.length} is outside the allowed range of the current ${run.prompt.length}`);
  if (!/STRICT JSON|schema/i.test(text)) throw new Error('improved prompt dropped the strict-JSON instruction');
  const cand = { id: uid('cand'), createdAt: new Date().toISOString(), basedOnRun: runId, basePromptChars: run.prompt.length, chars: text.length, patterns: out.patterns || [], changes: out.changes || [], usedFixtures: worst.map((w) => w.id), text };
  writeJson(path.join(DATA, 'candidates', cand.id + '.json'), cand);
  return cand;
}

// ── http ────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, service: 'notera-lab', gold: goldIndex().length, usable: goldIndex().filter((x) => x.ok).length }));
app.use((req, res, next) => {
  const got = Buffer.from(String(req.headers['x-lab-key'] || '')); const want = Buffer.from(KEY);
  if (!KEY || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(403).json({ error: 'forbidden' });
  next();
});
app.use(express.json({ limit: '2mb' }));
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[lab]', e.message); res.status(500).json({ error: e.message }); } };

app.get('/info', wrap(async (_req, res) => { const idx = goldIndex(); res.json({ fixtures: idx.length, usable: idx.filter((x) => x.ok).length, models: { judge: JUDGE_MODEL, improve: IMPROVE_MODEL }, writerModel: process.env.V2_WRITER_MODEL || 'gemini-2.5-flash', concurrency: Number(process.env.LAB_CONCURRENCY) || 3 }); }));
app.get('/baseline', wrap(async (_req, res) => { const a = await getActivePrompt('v2-writer'); res.json({ source: a ? 'production-active' : 'default', chars: (a || defaultWriterPrompt()).length, text: a || defaultWriterPrompt() }); }));
app.get('/fixtures', wrap(async (req, res) => { const q = String(req.query.q || '').toLowerCase(); res.json({ fixtures: goldIndex().filter((x) => x.ok && (!q || x.id.toLowerCase().includes(q))).slice(0, 200) }); }));
app.get('/fixtures/:id', wrap(async (req, res) => res.json(loadFixture(req.params.id))));
app.post('/runs', wrap(async (req, res) => res.json({ id: await startRun(req.body || {}) })));
app.get('/runs', wrap(async (_req, res) => {
  const ids = fs.readdirSync(path.join(DATA, 'runs')).filter((f) => f.startsWith('run_') && !f.endsWith('.notes.json')).map((f) => f.replace('.json', ''));
  const list = ids.map((id) => loadRun(id)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60).map((r) => runView(r));
  res.json({ runs: list });
}));
app.get('/runs/:id', wrap(async (req, res) => { const r = loadRun(req.params.id); r ? res.json(runView(r, true)) : res.status(404).json({ error: 'not found' }); }));
app.get('/runs/:id/prompt', wrap(async (req, res) => { const r = loadRun(req.params.id); r ? res.json({ text: r.prompt, source: r.config.promptSource }) : res.status(404).json({ error: 'not found' }); }));
app.get('/runs/:id/rows/:fid', wrap(async (req, res) => { const notes = readJson(notesFile(req.params.id), {}); const { transcript, gold } = loadFixture(req.params.fid); res.json({ note: notes[req.params.fid] || '', transcript, gold }); }));
app.post('/runs/:id/cancel', wrap(async (req, res) => { const r = runs.get(req.params.id); if (r && r.status === 'running') { r.status = 'cancelled'; } res.json({ ok: true }); }));
app.post('/judge', wrap(async (req, res) => res.json({ id: await startJudge(req.body?.a, req.body?.b, Math.min(Number(req.body?.limit) || 30, 60)) })));
app.get('/judge/:id', wrap(async (req, res) => { const j = readJson(path.join(DATA, 'judges', req.params.id + '.json')); j ? res.json(j) : res.status(404).json({ error: 'not found' }); }));
app.post('/improve', wrap(async (req, res) => res.json(await improve(req.body?.runId, Number(req.body?.k) || 6))));
app.get('/candidates', wrap(async (_req, res) => res.json({ candidates: fs.readdirSync(path.join(DATA, 'candidates')).map((f) => readJson(path.join(DATA, 'candidates', f))).filter(Boolean).map(({ text, ...c }) => c).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40) })));
app.get('/candidates/:id', wrap(async (req, res) => { const c = readJson(path.join(DATA, 'candidates', req.params.id + '.json')); c ? res.json(c) : res.status(404).json({ error: 'not found' }); }));

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`[lab] notera-lab on :${port} · gold=${GOLD} · data=${DATA} · writer=${process.env.V2_WRITER_MODEL || 'gemini-2.5-flash'} · key=${KEY ? 'set' : 'MISSING'}`));
