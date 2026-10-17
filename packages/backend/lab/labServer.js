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
const runView = (r, full = false) => ({ id: r.id, label: r.label, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, config: r.config, progress: r.progress, summary: r.summary, error: r.error, ...(full ? { rows: r.rows, ids: r.ids } : {}) });
const loadRun = (id) => runs.get(id) || readJson(runFile(id));
// a run that was "running" when the process died is interrupted, not eternally spinning
for (const f of fs.readdirSync(path.join(DATA, 'runs')).filter((x) => /^run_.*\d\.json$|^run_[a-z0-9]+\.json$/.test(x) && !x.endsWith('.notes.json'))) {
  const r = readJson(path.join(DATA, 'runs', f)); if (r && r.status === 'running') { r.status = 'interrupted'; writeJson(path.join(DATA, 'runs', f), r); }
}

// ── judge (blind pairwise, order-swapped) ───────────────────────────────────
// Every pair is judged TWICE with the A/B order swapped. A win counts only if the same note wins in both orders;
// otherwise it is a tie (position bias is the best-documented failure of LLM judges). The judge also counts
// transcript-unsupported claims and missed critical facts, so hallucination and omission are measured directly,
// not inferred from a 1-10 score. Human labels (POST /judge/:id/label) calibrate the judge: agreement and kappa.
const JUDGE_SYS = `You are a senior physician comparing two AI-written SOAP notes (A and B) for the SAME consultation.
You are given the TRANSCRIPT (ground truth of what was said) and a clinician-written GOLD note (reference for what a good note keeps).
For EACH note give:
- completeness 1-10: captures the clinically important facts the gold note keeps (diagnoses, meds+doses, results, plan, follow-up, referrals)
- accuracy 1-10: every statement is supported by the transcript
- concision 1-10: specific facts only, no padding or repetition
- unsupported: integer count of statements in the note that the TRANSCRIPT does not support (invented or distorted facts: a wrong drug, dose, number, side, finding, plan). Count only real fabrications, not reasonable summaries.
- missed: integer count of CLINICALLY IMPORTANT facts in the transcript that the note omits (diagnosis, medication change, abnormal result, plan item, follow-up, referral).
Return JSON {"A":{"completeness":n,"accuracy":n,"concision":n,"unsupported":n,"missed":n},"B":{...},"winner":"A"|"B"|"tie","note":"one short sentence"}.`;
const KEYS = ['completeness', 'accuracy', 'concision', 'unsupported', 'missed'];
const kappa = (pairs) => {   // Cohen's kappa over categorical labels [[judge, human], …]
  if (!pairs.length) return null; const cats = ['A', 'B', 'tie']; const n = pairs.length;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = cats.reduce((s, c) => s + (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n), 0);
  return pe === 1 ? 1 : +((po - pe) / (1 - pe)).toFixed(3);
};
function judgeSummary(job) {
  const ok = job.items.filter((i) => !i.error); const n = ok.length;
  const wins = { A: 0, B: 0, tie: 0 }; ok.forEach((i) => wins[i.winner]++);
  const tot = { A: Object.fromEntries(KEYS.map((k) => [k, 0])), B: Object.fromEntries(KEYS.map((k) => [k, 0])) };
  ok.forEach((i) => KEYS.forEach((k) => { tot.A[k] += Number(i.A?.[k] || 0); tot.B[k] += Number(i.B?.[k] || 0); }));
  const avg = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, n ? +(v / n).toFixed(2) : 0]));
  const hum = ok.filter((i) => i.human).map((i) => [i.winner, i.human]);
  return { n, wins, A: avg(tot.A), B: avg(tot.B), swap_consistency: n ? +(ok.filter((i) => i.consistent).length / n).toFixed(3) : null,
    human: { labelled: hum.length, agreement: hum.length ? +(hum.filter(([a, b]) => a === b).length / hum.length).toFixed(3) : null, kappa: kappa(hum) } };
}
async function startJudge(aId, bId, limit = 30) {
  const A = loadRun(aId), B = loadRun(bId); if (!A || !B) throw new Error('run not found');
  const nA = readJson(notesFile(aId), {}), nB = readJson(notesFile(bId), {});
  const common = A.rows.filter((r) => !r.error && !r.gold_corrupt && nA[r.id] && nB[r.id] && B.rows.some((x) => x.id === r.id && !x.error)).map((r) => r.id).slice(0, limit);
  const job = { id: uid('judge'), a: aId, b: bId, model: JUDGE_MODEL, status: 'running', createdAt: new Date().toISOString(), progress: { done: 0, total: common.length }, items: [], summary: null };
  const save = () => writeJson(path.join(DATA, 'judges', job.id + '.json'), job);
  save();
  (async () => {
    const llm = await createGeminiService(null, { model: JUDGE_MODEL }); llm._agent = 'lab-judge'; let next = 0;
    const once = async (transcript, gold, x, y) => {
      const raw = await llm.generateContent(JUDGE_SYS, `=== TRANSCRIPT ===\n${transcript.slice(0, 60000)}\n\n=== GOLD NOTE ===\n${gold.slice(0, 8000)}\n\n=== NOTE A ===\n${x}\n\n=== NOTE B ===\n${y}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 700, temperature: 0, responseMimeType: 'application/json', thinkingBudget: 0, timeoutMs: 60000 });
      return JSON.parse(raw.replace(/^```json|```$/g, ''));
    };
    const worker = async () => { while (next < common.length) {
      const id = common[next++]; const { transcript, gold } = loadFixture(id);
      try {
        // order 1: A first. order 2: swapped. Map both verdicts back to the real runs.
        const [r1, r2] = await Promise.all([once(transcript, gold, nA[id], nB[id]), once(transcript, gold, nB[id], nA[id])]);
        const v1 = r1.winner === 'tie' ? 'tie' : r1.winner;                       // 'A' = run A, 'B' = run B
        const v2 = r2.winner === 'tie' ? 'tie' : (r2.winner === 'A' ? 'B' : 'A');  // swapped: judge's A is run B
        const consistent = v1 === v2; const winner = consistent ? v1 : 'tie';
        const mean = (p, q) => Object.fromEntries(KEYS.map((k) => [k, +(((Number(p?.[k]) || 0) + (Number(q?.[k]) || 0)) / 2).toFixed(2)]));
        job.items.push({ id, winner, consistent, orders: [v1, v2], A: mean(r1.A, r2.B), B: mean(r1.B, r2.A), note: r1.note || '' });
      } catch (e) { job.items.push({ id, error: String(e.message).slice(0, 120) }); }
      job.progress.done = job.items.length; save();
    } };
    await Promise.all(Array.from({ length: 3 }, worker));
    job.summary = judgeSummary(job); job.status = 'done'; save();
  })().catch((e) => { job.status = 'error'; job.error = String(e.message); save(); });
  return job.id;
}
function labelJudge(jobId, itemId, human) {
  const f = path.join(DATA, 'judges', jobId + '.json'); const job = readJson(f); if (!job) throw new Error('judge not found');
  const it = job.items.find((i) => i.id === itemId); if (!it || it.error) throw new Error('item not found');
  if (!['A', 'B', 'tie', null].includes(human)) throw new Error('human must be A, B, tie or null');
  if (human) it.human = human; else delete it.human;
  job.summary = judgeSummary(job); writeJson(f, job); return job.summary;
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

// ── comparison, trend, promotion gate, validation pipeline ───────────────────
const allRuns = () => fs.readdirSync(path.join(DATA, 'runs')).filter((f) => f.startsWith('run_') && !f.endsWith('.notes.json')).map((f) => loadRun(f.replace('.json', ''))).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
// two-sided sign test on paired improvements (exact binomial, p=0.5)
function signTest(better, worse) {
  const n = better + worse; if (!n) return 1; const k = Math.min(better, worse);
  let c = 1, cum = 0; for (let i = 0; i <= k; i++) { if (i > 0) c = (c * (n - i + 1)) / i; cum += c; }
  return Math.min(1, +(2 * cum / 2 ** n).toFixed(4));
}
// metric → [direction (+1 higher is better), label]
const METRICS = { similarity_to_gold: [1, 'Similarity to gold'], omission_rate: [-1, 'Omission rate'], story_flow: [1, 'Story / flow'], section_coverage: [1, 'Section coverage'], note_words: [0, 'Note length (words)'], ms: [-1, 'Latency (ms)'] };
function compareRuns(aId, bId) {
  const A = loadRun(aId), B = loadRun(bId); if (!A || !B) throw new Error('run not found');
  const bm = new Map(B.rows.map((r) => [r.id, r])); const pairs = A.rows.filter((r) => !r.error && bm.has(r.id) && !bm.get(r.id).error).map((r) => [r, bm.get(r.id)]);
  const metrics = Object.entries(METRICS).map(([key, [dir, label]]) => {
    const p = pairs.filter(([x, y]) => typeof x[key] === 'number' && typeof y[key] === 'number');
    const d = p.map(([x, y]) => y[key] - x[key]); const eps = key === 'ms' ? 500 : key === 'note_words' ? 8 : 0.005;
    const up = d.filter((v) => v > eps).length, down = d.filter((v) => v < -eps).length;
    const improved = dir === 0 ? up : dir > 0 ? up : down, regressed = dir === 0 ? down : dir > 0 ? down : up;
    const pv = signTest(improved, regressed); const md = mean(d);
    const verdict = p.length < 2 || md == null ? 'n/a' : dir === 0 ? 'info' : pv > 0.1 ? 'no clear change' : ((dir > 0 ? md > 0 : md < 0) ? 'better' : 'worse');
    return { key, label, direction: dir, n: p.length, a: mean(p.map(([x]) => x[key])), b: mean(p.map(([, y]) => y[key])), delta: md, improved, regressed, unchanged: p.length - improved - regressed, p: pv, verdict, underpowered: p.length < 20 };
  });
  const rows = pairs.map(([x, y]) => ({ id: x.id, sim_a: x.similarity_to_gold, sim_b: y.similarity_to_gold, om_a: x.omission_rate, om_b: y.omission_rate, d_sim: +(y.similarity_to_gold - x.similarity_to_gold).toFixed(3), d_om: +(y.omission_rate - x.omission_rate).toFixed(3) })).sort((a, b) => (a.d_sim - a.d_om) - (b.d_sim - b.d_om));
  return { a: { id: A.id, label: A.label, config: A.config }, b: { id: B.id, label: B.label, config: B.config }, paired: pairs.length, metrics, rows };
}
function trend() {
  return allRuns().filter((r) => r.status === 'done' && r.summary).map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, n: r.config.n, writerModel: r.config.writerModel, promptSource: r.config.promptSource, ...r.summary }));
}
const sameSet = (x, y) => x.ids && y.ids && x.ids.length === y.ids.length && [...x.ids].sort().join('|') === [...y.ids].sort().join('|');
const judgesFor = (a, b) => fs.readdirSync(path.join(DATA, 'judges')).map((f) => readJson(path.join(DATA, 'judges', f))).filter((j) => j && j.status === 'done' && j.a === a && j.b === b).sort((x, y) => y.createdAt.localeCompare(x.createdAt));

/** Promotion gate: server-side evidence that a candidate is safe to promote. Every check is computed from stored runs/judges. */
function gate(candId) {
  const cand = readJson(path.join(DATA, 'candidates', candId + '.json')); if (!cand) throw new Error('candidate not found');
  const src = 'candidate:' + candId; const runsAll = allRuns().filter((r) => r.status === 'done' && r.summary);
  const cRuns = runsAll.filter((r) => r.config.promptSource === src);
  const checks = []; const add = (id, label, pass, detail) => checks.push({ id, label, pass, detail });
  // pair each candidate run with a baseline run on the identical note set and the same writer model
  const pairsFound = cRuns.map((c) => ({ c, b: runsAll.filter((r) => r.config.promptSource !== src && sameSet(r, c) && (r.config.writerModel || '') === (c.config.writerModel || '')).pop() })).filter((p) => p.b);
  const fresh = pairsFound.filter((p) => !(cand.usedFixtures || []).some((id) => p.c.ids.includes(id)) && p.c.config.n >= 30);
  const same = pairsFound.filter((p) => !fresh.includes(p));
  const fp = fresh.pop() || null, sp = same.pop() || null;
  add('ab', 'Tested on the same notes it was tuned on (A/B)', !!sp, sp ? `${sp.c.config.n} notes` : 'not run yet');
  add('fresh', 'Tested on 30+ notes it has never seen', !!fp, fp ? `${fp.c.config.n} fresh notes` : 'not run yet');
  const target = fp || sp;
  if (target) {
    const cmp = compareRuns(target.b.id, target.c.id); const m = Object.fromEntries(cmp.metrics.map((x) => [x.key, x]));
    add('sim', 'Similarity to gold did not drop', (m.similarity_to_gold.delta ?? 0) >= -0.01, `Δ ${(m.similarity_to_gold.delta ?? 0).toFixed(3)} (${m.similarity_to_gold.verdict})`);
    add('omit', 'Omission rate did not rise', (m.omission_rate.delta ?? 0) <= 0.01, `Δ ${(m.omission_rate.delta ?? 0).toFixed(3)} (${m.omission_rate.verdict})`);
    add('fail', 'No new failed notes', (target.c.summary.failed || 0) <= (target.b.summary.failed || 0), `${target.c.summary.failed || 0} failed vs ${target.b.summary.failed || 0}`);
    add('lat', 'Latency p95 not >25% worse', !target.b.summary.p95_s || target.c.summary.p95_s <= target.b.summary.p95_s * 1.25, `${target.c.summary.p95_s}s vs ${target.b.summary.p95_s}s`);
    const j = judgesFor(target.b.id, target.c.id)[0];
    if (!j) add('judge', 'Blind judge prefers the candidate', false, 'not judged yet');
    else { const s = j.summary; add('judge', 'Blind judge prefers the candidate (order-swapped)', s.wins.B > s.wins.A && s.B.accuracy >= s.A.accuracy - 0.25 && s.B.completeness >= s.A.completeness - 0.1, `wins B ${s.wins.B} · A ${s.wins.A} · tie ${s.wins.tie}; accuracy ${s.A.accuracy}→${s.B.accuracy}`);
      add('halluc', 'No more hallucinated claims than the baseline', s.B.unsupported <= s.A.unsupported + 0.05, `unsupported/note ${s.A.unsupported}→${s.B.unsupported}`); }
  }
  return { candidate: candId, ready: checks.length >= 4 && checks.every((c) => c.pass), checks, runs: { fresh: fp && { base: fp.b.id, cand: fp.c.id }, same: sp && { base: sp.b.id, cand: sp.c.id } } };
}

// Validation job: run baseline + candidate on the same fresh notes, then judge them — one click, fully server-side.
const validations = new Map();
async function startValidation(candId, n = 40, writerModel) {
  const cand = readJson(path.join(DATA, 'candidates', candId + '.json')); if (!cand) throw new Error('candidate not found');
  const base = loadRun(cand.basedOnRun); const wm = writerModel || base?.config?.writerModel || undefined;
  const used = new Set([...(cand.usedFixtures || []), ...((base && base.ids) || [])]);
  const pool = goldIndex().filter((x) => x.ok && !used.has(x.id)).map((x) => x.id); const rnd = mulberry32(Date.now() % 100000);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const ids = pool.slice(0, Math.min(Math.max(10, Number(n) || 40), 100));
  const v = { id: uid('val'), candidate: candId, status: 'running', stage: 'baseline + candidate', createdAt: new Date().toISOString(), ids: ids.length, runs: {}, judge: null };
  validations.set(v.id, v);
  (async () => {
    v.runs.base = await startRun({ ids, writerModel: wm, label: `validate base ${candId.slice(-6)}`, prompt: 'active' });
    v.runs.cand = await startRun({ ids, writerModel: wm, candidateId: candId, label: `validate cand ${candId.slice(-6)}` });
    const waitDone = async (id) => { for (;;) { const r = loadRun(id); if (r && r.status !== 'running') return r; await sleep(3000); } };
    const [rb, rc] = await Promise.all([waitDone(v.runs.base), waitDone(v.runs.cand)]);
    if (rb.status !== 'done' || rc.status !== 'done') throw new Error(`a validation run ended as ${rb.status}/${rc.status}`);
    v.stage = 'blind judge'; v.judge = await startJudge(v.runs.base, v.runs.cand, Math.min(ids.length, 40));
    for (;;) { const j = readJson(path.join(DATA, 'judges', v.judge + '.json')); if (j && j.status !== 'running') { if (j.status === 'error') throw new Error(j.error); break; } await sleep(4000); }
    v.status = 'done'; v.stage = 'done';
  })().catch((e) => { v.status = 'error'; v.error = String(e.message); });
  return v.id;
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

app.get('/info', wrap(async (_req, res) => { const idx = goldIndex(); res.json({ fixtures: idx.length, usable: idx.filter((x) => x.ok).length, models: { judge: JUDGE_MODEL, improve: IMPROVE_MODEL }, writerModel: process.env.V2_WRITER_MODEL || 'gemini-2.5-flash', writerFallback: process.env.V2_WRITER_FALLBACK || 'gemini-3.5-flash-lite', concurrency: Number(process.env.LAB_CONCURRENCY) || 3 }); }));
app.get('/baseline', wrap(async (_req, res) => { const a = await getActivePrompt('v2-writer'); res.json({ source: a ? 'production-active' : 'default', chars: (a || defaultWriterPrompt()).length, text: a || defaultWriterPrompt() }); }));
app.get('/fixtures', wrap(async (_req, res) => { const f = goldIndex().filter((x) => x.ok).map((x) => [x.id, x.tChars, x.gChars]); res.json({ fixtures: f }); }));   // compact tuples: [id, transcriptChars, goldChars]
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
app.get('/compare', wrap(async (req, res) => res.json(compareRuns(String(req.query.a), String(req.query.b)))));
app.get('/trend', wrap(async (_req, res) => res.json({ runs: trend() })));
app.get('/baseline-run', wrap(async (_req, res) => { const b = readJson(path.join(DATA, 'baseline-run.json'), null); const r = b && loadRun(b.runId); res.json({ baseline: r ? { ...runView(r), pinnedAt: b.pinnedAt } : null }); }));
app.put('/baseline-run', wrap(async (req, res) => { const r = loadRun(String(req.body?.runId || '')); if (!r || r.status !== 'done') return res.status(400).json({ error: 'pick a finished run' }); writeJson(path.join(DATA, 'baseline-run.json'), { runId: r.id, pinnedAt: new Date().toISOString() }); res.json({ ok: true }); }));
app.post('/judge/:id/label', wrap(async (req, res) => res.json({ summary: labelJudge(req.params.id, String(req.body?.item || ''), req.body?.human ?? null) })));
app.get('/judges', wrap(async (_req, res) => res.json({ judges: fs.readdirSync(path.join(DATA, 'judges')).map((f) => readJson(path.join(DATA, 'judges', f))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40).map(({ items, ...j }) => j) })));
app.get('/candidates/:id/gate', wrap(async (req, res) => res.json(gate(req.params.id))));
app.post('/candidates/:id/validate', wrap(async (req, res) => res.json({ id: await startValidation(req.params.id, req.body?.n, req.body?.writerModel) })));
app.get('/validations/:id', wrap(async (req, res) => { const v = validations.get(req.params.id); v ? res.json(v) : res.status(404).json({ error: 'not found' }); }));
app.get('/validations', wrap(async (_req, res) => res.json({ validations: [...validations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20) })));
app.get('/runs/:id/export.csv', wrap(async (req, res) => {
  const r = loadRun(req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  const cols = ['id', 'similarity_to_gold', 'omission_rate', 'story_flow', 'section_coverage', 'note_words', 'ms', 'error'];
  const csv = [cols.join(','), ...r.rows.map((x) => cols.map((c) => JSON.stringify(x[c] ?? '')).join(','))].join(String.fromCharCode(10));
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="' + r.id + '.csv"'); res.send(csv);
}));
app.get('/candidates', wrap(async (_req, res) => res.json({ candidates: fs.readdirSync(path.join(DATA, 'candidates')).map((f) => readJson(path.join(DATA, 'candidates', f))).filter(Boolean).map(({ text, ...c }) => c).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40) })));
app.get('/candidates/:id', wrap(async (req, res) => { const c = readJson(path.join(DATA, 'candidates', req.params.id + '.json')); c ? res.json(c) : res.status(404).json({ error: 'not found' }); }));

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`[lab] notera-lab on :${port} · gold=${GOLD} · data=${DATA} · writer=${process.env.V2_WRITER_MODEL || 'gemini-2.5-flash'} · key=${KEY ? 'set' : 'MISSING'}`));
