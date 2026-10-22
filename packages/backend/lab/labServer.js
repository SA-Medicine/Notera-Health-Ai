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
import { effectiveConfig } from '../src/orchestrator/runtimeConfig.js';
import { createGeminiService, runWithModel } from '../src/services/LLMService.js';
import { formatReport, aggregate as aggregateFormat } from './formatMetrics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const GOLD = process.env.LAB_GOLD_DIR || path.join(ROOT, 'data', 'gold');
const DATA = process.env.LAB_DATA_DIR || path.join(ROOT, 'lab-data');
const KEY = process.env.LAB_KEY || '';
const JUDGE_MODEL = process.env.LAB_JUDGE_MODEL || 'gemini-2.5-pro';
const IMPROVE_MODEL = process.env.LAB_IMPROVE_MODEL || 'gemini-2.5-pro';
for (const d of ['runs', 'judges', 'candidates', 'analysis', 'reports', 'audio']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
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
// M.aggregate + the score of the note AS THE DOCTOR SEES IT (labels included) against the gold note
const aggregateRun = (rows) => { const a = M.aggregate(rows); const v = rows.map((r) => r.similarity_rendered).filter((x) => typeof x === 'number'); return { ...a, avg_similarity_rendered: v.length ? +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(3) : null }; };
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
    config: { n: ids.length, seed: cfg.seed || 1, exclude: cfg.exclude?.length || 0, promptSource: prompt.source, promptChars: prompt.text.length, mode: cfg.mode || 'v2', defaultModel: cfg.defaultModel || null, editor: cfg.editor ?? null, writerThinking: cfg.writerThinking ?? null, fewShot: cfg.fewShot ?? null, story: cfg.story ?? null, storyModel: cfg.storyModel ?? null, guardTemplate: cfg.guardTemplate ?? null, guardPlacement: cfg.guardPlacement ?? null, auxModel: cfg.auxModel ?? null, recall: cfg.recall ?? null, writerModel: cfg.writerModel || null, writerTemp: cfg.writerTemp ?? null, writerTopP: cfg.writerTopP ?? null },
    ids, prompt: prompt.text, progress: { done: 0, total: ids.length }, rows: [], summary: null };
  runs.set(run.id, run); persist(run);
  const notes = {}; const traces = {};
  (async () => {
    let next = 0;
    const worker = async () => {
      while (next < ids.length && run.status === 'running') {
        const id = ids[next++]; const t0 = Date.now();
        try {
          const { transcript, gold } = loadFixture(id);
          const lg = []; const trace = {};
          const r = await runWithModel(cfg.defaultModel, () => generateNote({ transcript, specialty: 'auto', noteType: 'consultation', clinicianId: 'lab' },
            { persist: false, mode: cfg.mode === 'v1' ? 'v1' : 'v2', writerPrompt: prompt.text, writerModel: cfg.writerModel || undefined, writerTemp: cfg.writerTemp, writerTopP: cfg.writerTopP, writerThinking: cfg.writerThinking, fewShot: cfg.fewShot, story: cfg.story, storyModel: cfg.storyModel, guardTemplate: cfg.guardTemplate, guardPlacement: cfg.guardPlacement, auxModel: cfg.auxModel, recall: cfg.recall, editor: cfg.editor, adviceLines: cfg.adviceLines, qualityGuards: cfg.qualityGuards, onLog: (l) => { if (lg.length < 300) lg.push(l); }, trace }));
          traces[id] = { log: lg, trace };
          const noteText = noteToText(r.note);
          const sc = M.scoreNote({ note: r.note, noteText, goldText: gold, entities: [] });
          run.rows.push({ id, ms: Date.now() - t0, note_words: noteText.split(/\s+/).filter(Boolean).length, schema_valid: sc.schema_valid, section_coverage: sc.section_coverage, similarity_to_gold: sc.similarity_to_gold, omission_rate: sc.omission_rate, story_flow: sc.story_flow, gold_corrupt: sc.gold_corrupt, meds_unsupported: sc.meds_unsupported, omission_missed: sc.omission_missed });
          notes[id] = r.renderedNote || ''; run.rows[run.rows.length - 1].similarity_rendered = gold ? +M.similarityToGold(r.renderedNote || '', gold).toFixed(3) : null;
        } catch (e) { run.rows.push({ id, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200), schema_valid: false, section_coverage: 0, similarity_to_gold: 0, meds_unsupported: [] }); }
        run.progress.done = run.rows.length; run.summary = aggregateRun(run.rows);
        if (run.rows.length % 3 === 0) { persist(run); writeJson(notesFile(run.id), notes); writeJson(traceFile(run.id), traces); }
      }
    };
    await Promise.all(Array.from({ length: Number(process.env.LAB_CONCURRENCY) || 3 }, worker));
    run.status = run.status === 'cancelled' ? 'cancelled' : 'done'; run.finishedAt = new Date().toISOString(); run.summary = aggregateRun(run.rows);
    persist(run); writeJson(notesFile(run.id), notes); writeJson(traceFile(run.id), traces);
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
- readability 1-10: reads as a coherent clinical story in proper grammar (complete sentences, logical order from onset to now, natural flow) rather than a list of clipped fragments — judge the Subjective above all
- unsupported: integer count of statements in the note that the TRANSCRIPT does not support (invented or distorted facts: a wrong drug, dose, number, side, finding, plan). Count only real fabrications, not reasonable summaries.
- missed: integer count of CLINICALLY IMPORTANT facts in the transcript that the note omits (diagnosis, medication change, abnormal result, plan item, follow-up, referral).
Return JSON {"A":{"completeness":n,"accuracy":n,"concision":n,"unsupported":n,"missed":n},"B":{...} (each with the same keys incl. readability),"winner":"A"|"B"|"tie","note":"one short sentence"}.`;
const KEYS = ['completeness', 'accuracy', 'concision', 'readability', 'unsupported', 'missed'];
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
      const raw = await llm.generateContent(JUDGE_SYS, `=== TRANSCRIPT ===\n${transcript.slice(0, 60000)}\n\n=== GOLD NOTE ===\n${gold.slice(0, 8000)}\n\n=== NOTE A ===\n${x}\n\n=== NOTE B ===\n${y}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 3000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 1024, hedgeMs: 0 });
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
    await Promise.all(Array.from({ length: Number(process.env.LAB_AUDIT_CONCURRENCY) || 2 }, worker));   // 2, not 3: the lab shares the Gemini quota with production
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
const allRuns = () => fs.readdirSync(path.join(DATA, 'runs')).filter((f) => f.startsWith('run_') && !/.(notes|trace).json$/.test(f)).map((f) => loadRun(f.replace('.json', ''))).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  return allRuns().filter((r) => r.status === 'done' && r.summary).map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, n: r.config.n, writerModel: r.config.writerModel, promptSource: r.config.promptSource, quality: r.quality || null, ...r.summary }));
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

// ── per-note audit, overall diagnosis, custom-input try-out ──────────────────
// (1) NOTE AUDIT: one note vs the transcript and the clinician's gold note → what it lacks, what is wrong, what is padding.
// (2) OVERALL DIAGNOSIS: aggregates every audit in a run + metrics + pipeline logs → recurring patterns, which stage to blame,
//     prioritised recommendations (prompt / setting / pipeline / guardrail / data) with a status you can track.
const analysisFile = (runId) => path.join(DATA, 'analysis', runId + '.json');
const traceFile = (runId) => path.join(DATA, 'runs', runId + '.trace.json');
const parseJ = (raw) => JSON.parse(String(raw).replace(/^```json|```$/g, '').trim());
async function auditNote(runId, fid, { force = false } = {}) {
  const cache = readJson(analysisFile(runId), {}); if (cache[fid] && !force) return cache[fid];
  const notes = readJson(notesFile(runId), {}); if (!notes[fid]) throw new Error('no generated note for this fixture');
  const { transcript, gold } = loadFixture(fid);
  const llm = await createGeminiService(null, { model: JUDGE_MODEL }); llm._agent = 'lab-audit';
  const fm = formatReport(notes[fid], gold);
  const raw = await llm.generateContent(auditSys(), `=== TRANSCRIPT ===\n${transcript.slice(0, 60000)}\n\n=== GOLD NOTE ===\n${gold.slice(0, 8000)}\n\n=== AI NOTE ===\n${notes[fid]}\n\n=== FORMAT METRICS (computed by code) ===\n${JSON.stringify(fm)}\n\nReturn ONLY the JSON.`, null,
    { maxOutputTokens: 6000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 1024, hedgeMs: 0 });
  const a = parseJ(raw); a.at = new Date().toISOString(); a.model = JUDGE_MODEL; a.format_metrics = fm;
  const fresh = readJson(analysisFile(runId), {}); fresh[fid] = a; writeJson(analysisFile(runId), fresh);
  return a;
}
// PARITY SCORE — the comparator the original Testing Lab used (admin/handler.js COMPARATOR_SYS, byte-for-byte, same date caveat,
// same default model): "NOTERA note vs GOLD note", overall_score 0-100 = how close the note is to the clinician's, with a verdict
// notera_better | gold_better | equivalent. This is the "90+" score from the earlier pipeline; it is NOT the absolute audit.
const PARITY_SYS = `You are a clinical documentation comparator scoring two SOAP notes. Compare the NOTERA note (system under test) against the GOLD reference note.
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
async function parityScore(note, gold) {
  const llm = await createGeminiService(); llm._agent = 'lab-parity';   // default model, as the original comparator
  const out = await llm.generateContent(PARITY_SYS, `=== NOTERA NOTE (system under test) ===\n\n${note}\n\n=== GOLD NOTE (reference) ===\n\n${gold || '(no gold reference available)'}\n\nCompare and return ONLY the JSON.`);
  const parsed = JSON.parse(String(out).replace(/```json/g, '').replace(/```/g, '').trim());
  return { ...parsed, model: process.env.GEMINI_MODEL || 'default' };
}
// audit a note that is not part of a stored run (e.g. produced from audio): transcript is the truth, gold is optional
async function auditAdhoc({ transcript, note, gold = '' }) {
  const llm = await createGeminiService(null, { model: JUDGE_MODEL }); llm._agent = 'lab-audit';
  const goldBlock = String(gold).trim() ? String(gold).slice(0, 8000) : '(none provided — judge only against the transcript)';
  const fm = String(gold).trim() ? formatReport(String(note), String(gold)) : null;
  const raw = await llm.generateContent(auditSys(), `=== TRANSCRIPT ===\n${String(transcript).slice(0, 60000)}\n\n=== GOLD NOTE ===\n${goldBlock}\n\n=== AI NOTE ===\n${String(note)}\n\n=== FORMAT METRICS (computed by code) ===\n${fm ? JSON.stringify(fm) : '(no gold note: judge layout against the format principles only)'}\n\nReturn ONLY the JSON.`, null,
    { maxOutputTokens: 6000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 1024, hedgeMs: 0 });
  const a = parseJ(raw); if (fm) a.format_metrics = fm; return a;
}
// run an audit over many notes with limited concurrency (worst first)
async function auditMany(runId, ids, onProgress) {
  let next = 0, done = 0;
  const worker = async () => { while (next < ids.length) { const id = ids[next++]; try { await auditNote(runId, id); } catch { /* skip this one */ } onProgress?.(++done, ids.length); } };
  await Promise.all(Array.from({ length: Number(process.env.LAB_AUDIT_CONCURRENCY) || 2 }, worker));   // 2, not 3: the lab shares the Gemini quota with production
}

// ── the clinic's gold-note template (from the software that writes the gold notes) ─────────────────────────────────────────
// Used to brief the auditor (do not penalise a note for following it) and the prompt-upgrade agent (make the writer follow it).
const GOLD_TEMPLATE_SPEC = `THE CLINIC'S NOTE TEMPLATE (the gold notes follow it; a note that follows it is correct):
Subjective: reasons for visit incl. chief complaints/requests/symptoms; duration, timing, location, quality, severity, context; worsening/relieving factors incl. self-treatment; progression over time; previous episodes and outcomes; impact on daily activities/work/social functioning; associated symptoms (focal and systemic).
Past Medical History: relevant past medical/surgical history; relevant social history; relevant family history; exposure history; immunisation history; any other relevant subjective information.
Objective: vital signs; physical or mental-state examination findings by system; COMPLETED investigations with results (never planned ones).
Assessment & Plan: numbered, one block per issue/problem explicitly identified: issue name; diagnosis ONLY if explicitly stated; differential diagnoses ONLY if explicitly listed; investigations planned; treatment planned; referrals made or recommended.
RULES: every field is optional and included ONLY if explicitly in the transcript; otherwise left blank. Never infer, summarise into or invent a diagnosis. Never invent patient details, assessments or plans. Never state that something was not mentioned. There is no separate "current medications" list and no separate "follow-up" problem: drugs and follow-up timing appear inside the relevant issue's treatment planned. Use as many lines as needed to capture all relevant information.`;
// ── FORMAT PRINCIPLES learned from the gold notes (format only) ───────────────────────────────────────────────────────────────
// Induced from 410 topic-headed gold notes (the newest style) and validated on 30 held-out transcripts; see docs/reports/FORMAT_ANALYSIS_2026-10-22.md.
// They tell the auditor and the report HOW the best notes lay facts out. They describe layout, never clinical content, and they never change the
// production writer: Style Spec v1 stays locked, and anything that would go beyond it is reported as a proposal.
const GOLD_FORMAT_PRINCIPLES = `HOW THE BEST (GOLD) NOTES LAY FACTS OUT — layout only, content always comes from the transcript:
F1 ONE PROBLEM PER ISSUE. The gold A&P has about 3.9 numbered problems per note. Every distinct issue the clinician spoke about or acted on gets its own numbered problem, even when it is small: an abnormal or borderline result the doctor commented on, a chronic condition reviewed or refilled, a screening or vaccine discussed or given, a form or prescription requested. Two issues are never merged under one title and never hidden inside another problem's lines.
F2 EACH LABEL ONCE PER PROBLEM. Under a problem, "Diagnosis:", "Investigations planned:", "Treatment planned:", "Referrals:" appear at most once each; several items are joined with commas or semicolons on that one line. The same label repeated on several lines is a readability defect.
F3 EVERY FACT UNDER ITS RIGHT LABEL. A result or finding is not a treatment; history is not a plan; an investigation is not a treatment. Lines are short (one clinical clause, under about 170 characters). A first line may state the clinician's conclusion in plain words.
F4 ADVICE AND FOLLOW-UP ARE VISIBLE. When the clinician counselled or advised (what to avoid, what to monitor, red flags, lifestyle) the gold note shows it as its own line ("Advised …", "Counselled on …"); when a return date or review interval was given it is its own line ("Follow-up: …" / "RTC …"). Over half of the gold notes have at least one such line. Aggravating and relieving factors the doctor addressed belong with the symptom in Subjective and, when the doctor advised avoiding or using them, again as an advice line in the plan.
F5 TITLES NAME THE ISSUE. A problem title is the plain name of the issue (a condition, a result, a screening, a request). Generic buckets ("Lab abnormalities", "Lab review", "Other", "Medications") are not issue names. "Administrative" is the one allowed bucket, for forms and permits.
F6 READS TOP TO BOTTOM. Subjective: Presenting Complaint first, then about 3-4 topic headings with about 4 short bullets each, each bullet following from the one before. Objective: measurements first, then exam findings, then completed results, grouped by panel. Past Medical History: short list, status beside each condition. The same fact appears once in the whole note.
F7 NOTHING EMPTY, NOTHING INVENTED. No label with nothing after the colon; no "not mentioned" line; no content that is not in the transcript.`;
// short copy of the doctor-approved Style Spec v1 (docs/STYLE_SPEC_V1_LOCKED.md) so the auditor can tell "gap inside the spec" from "gap that would need the spec to change"
const STYLE_SPEC_V1_SHORT = `STYLE SPEC v2 (= v1 below + the v2 additions at the end; doctor-approved, locked; the production note must follow it):
Subjective = Presenting Complaint, then one topic per symptom, short bullets (4-14 words), each fact once, symptoms only (no lifestyle/social/family). Past Medical History = about six bullets incl. one Medications line. Objective = measured/examined/completed results only, one panel per line, no repeats.
Assessment & Plan = one numbered problem per distinct issue, plain title (never "rule out/suspected/vs"); "Diagnosis:" only if the clinician named one; assessment line = only what the clinician concluded; each investigation/treatment/referral/follow-up once, under its problem; refills under the condition they treat; forms/permits in one "Administrative" problem; no separate "Follow-up" problem.
V2 ADDITIONS: under a problem the lines are Diagnosis, assessment, Differential, Investigations planned, Treatment planned, Referrals, Advice, Follow-up; each label once per problem (items joined with semicolons); advice, safety-netting, return precautions and refusals are on an "Advice:" line and the return timeframe on a "Follow-up:" line (do NOT mark these as wrong or extra); every issue the clinician addressed has its own problem, in the order discussed; a "Diagnosis:" only if the clinician said it; PMH has an "Allergies:" line when stated; a side the recording does not name is flagged, not changed.`;
const AUDIT_DEFAULT = (spec) => `You are a senior physician auditing an AI-written SOAP note for one consultation. You judge TWO things: (A) is the content true and complete, (B) is it laid out so a busy doctor reads it quickly and finds every fact where they expect it.
TRANSCRIPT = the only ground truth of what was said. GOLD NOTE = a clinician-written note showing what a good note keeps and how it lays facts out (it may be missing from this check).
${spec}
${STYLE_SPEC_V1_SHORT}
${GOLD_FORMAT_PRINCIPLES}
Do NOT mark something wrong or extra merely because it follows the template above (e.g. social history under Past Medical History, a home blood pressure under vital signs, follow-up timing inside the treatment plan, an empty diagnosis, an Administrative problem).
FORMAT METRICS: the user message contains numbers computed by code (problems, repeated labels, run-on lines, advice lines, gold problems with no match). Treat them as facts and use them; do not contradict them.
PRESENTATION SCORES (0-100 each, judged against the gold layout and F1-F7, independent of the content score): "flow" = the note reads top to bottom as one story, each line following from the one before; "readability" = short plain lines, labels once, nothing repeated, nothing a doctor must re-read; "organization" = every fact sits in the right section, topic and label, and every issue the doctor addressed has its own place in the plan.
For every A&P gap use one kind: missing_problem (an issue the doctor addressed has no problem), merged_problems (two issues under one title), missing_line (advice, follow-up or another stated plan item has no line), misplaced_fact (a fact under the wrong label/section), repeated_label (a label repeated under one problem), generic_title (bucket instead of issue name), run_on (a line too long), echo (a line repeats the title). Set "spec" to "inside_spec" when fixing it is allowed by Style Spec v1, or "beyond_spec" when fixing it would change what Style Spec v1 says (such a gap is only ever a proposal).
Return JSON:
{"verdict":"excellent|good|needs_work|unsafe","score":0-100,"summary":"one sentence",
 "presentation":{"flow":0-100,"readability":0-100,"organization":0-100,"summary":"one sentence on how the note reads"},
 "missing":[{"fact":"...","importance":"critical|important|minor"}],
 "wrong":[{"claim":"quote from the AI note","problem":"why it is wrong, unsupported or in the wrong place","severity":"critical|major|minor"}],
 "extra":[{"text":"quote","why":"padding, duplicate, commentary or filler"}],
 "ap_gaps":[{"kind":"missing_problem|merged_problems|missing_line|misplaced_fact|repeated_label|generic_title|run_on|echo","where":"problem title or section","gap":"what the gold or the transcript shows that the note lacks, in generic terms","spec":"inside_spec|beyond_spec"}],
 "structure":["other deviations from the template: wrong section, invented diagnosis, a field filled without support, a 'not mentioned' statement, wrong labels"],
 "strengths":["what it did well"],
 "root_cause":{"stage":"writer|checklist|verifier|cleanup|rules|data","why":"short reason"},
 "suggestions":["generic, reusable prompt-level fixes — nothing specific to this patient"]}
At most 8 items per list. Be specific and terse. "unsafe" = a wrong drug/dose/side/diagnosis or an invented finding. "score" is the content score (A); the presentation scores (B) are separate.`;
const auditPromptFile = path.join(DATA, 'audit-prompt.txt');
const auditSys = () => { try { const t = fs.readFileSync(auditPromptFile, 'utf8').trim(); if (t.length > 300) return t; } catch { /* default */ } return AUDIT_DEFAULT(GOLD_TEMPLATE_SPEC); };

// ── PROMPT UPGRADE FROM A WHOLE REPORT ───────────────────────────────────────────────────────────────────────────────────────
// Input: the overall diagnosis (patterns, stage blame, recommendations), the individual audits behind it, the pipeline logs of the
// weakest notes, the similarity/omission numbers, the clinic template and the CURRENT prompt. Output: a candidate prompt plus
// concrete suggestions (prompt / setting / pipeline / data) — saved as a candidate so it goes through validation and the gate.
const UPGRADE_SYS = `You are a prompt engineer upgrading the system prompt of a clinical scribe that writes SOAP notes as strict JSON from a consultation transcript.
You receive: the CURRENT PROMPT; the clinic's NOTE TEMPLATE; an OVERALL DIAGNOSIS of a test run (recurring patterns, which pipeline stage is to blame, recommendations); the individual AUDITS behind it (what each note lacked / got wrong / padded); PIPELINE LOGS of the weakest notes (what the checklist, verifier and cleanup stages added or removed); and word-overlap metrics versus the gold notes.
Goals, in order: (1) no wrong or invented content; (2) follow the clinic template and the doctor's Style Spec v1 exactly; (3) FLOW, EASY READING and well-organised facts — apply the FORMAT PRINCIPLES (F1-F7) you are given, but only where they fit inside Style Spec v1; (4) include every clinically relevant fact the gold notes include; (5) match the gold notes' wording and level of detail so similarity to gold rises.
Anything that would go beyond Style Spec v1 goes into "suggestions" only (area "prompt", title starting "BEYOND SPEC:"), never into the upgraded prompt.
Rules: make TARGETED rewordings or additions that address the recurring patterns; keep every hard rule, the field-placement rules and the strict-JSON/schema instruction; add NOTHING specific to the examples (no names, drugs, dates or numbers from them); do not lengthen the prompt by more than 15%; prefer replacing a weak rule with a sharper one over adding another.
Return JSON: {"summary":"2-3 sentences on what you changed and why","changes":["each change and the pattern it fixes"],"suggestions":[{"title":"...","detail":"...","area":"prompt|setting|pipeline|guardrail|data|metric","impact":"high|medium|low"}],"prompt":"<the full upgraded prompt text>"}.
"suggestions" are things a prompt cannot fix (code, settings, data) — be concrete.`;
async function upgradeFromReport(reportId) {
  const rep = readJson(path.join(DATA, 'reports', reportId + '.json')); if (!rep || rep.status !== 'done') throw new Error('report not finished');
  const run = loadRun(rep.runId); if (!run) throw new Error('run not found');
  const audits = readJson(analysisFile(rep.runId), {}); const notes = readJson(notesFile(rep.runId), {}); const traces = readJson(traceFile(rep.runId), {});
  const ranked = run.rows.filter((r) => !r.error && audits[r.id]).map((r) => ({ id: r.id, sim: r.similarity_to_gold, om: r.omission_rate, a: audits[r.id] })).sort((x, y) => (x.a.score ?? 100) - (y.a.score ?? 100));
  const compact = ranked.slice(0, 24).map((x) => ({ note: x.id, score: x.a.score, verdict: x.a.verdict, similarity: x.sim, omission: x.om, presentation: x.a.presentation, missing: (x.a.missing || []).slice(0, 5), wrong: (x.a.wrong || []).slice(0, 5), extra: (x.a.extra || []).slice(0, 3), ap_gaps: (x.a.ap_gaps || []).slice(0, 6), structure: x.a.structure, cause: x.a.root_cause, fixes: x.a.suggestions }));
  const logs = ranked.slice(0, 8).map((x) => `--- ${x.id} (audit ${x.a.score}) ---\n${((traces[x.id]?.log) || []).filter((l) => /merge\]|verify\]|clean\]|drugs\]|fewshot\]|condense|dedupe|editor\]/.test(l)).slice(0, 14).join('\n')}`).join('\n\n');
  const p = await resolvePrompt({ prompt: 'active' }); const current = run.prompt || p.text;
  const llm = await createGeminiService(null, { model: IMPROVE_MODEL }); llm._agent = 'lab-upgrade';
  const raw = await llm.generateContent(UPGRADE_SYS, `=== NOTE TEMPLATE ===\n${GOLD_TEMPLATE_SPEC}\n\n=== STYLE SPEC v1 (locked) ===\n${STYLE_SPEC_V1_SHORT}\n\n=== FORMAT PRINCIPLES (F1-F7) ===\n${GOLD_FORMAT_PRINCIPLES}\n\n=== CURRENT PROMPT ===\n${current}\n\n=== OVERALL DIAGNOSIS ===\n${JSON.stringify({ headline: rep.headline, assessment: rep.assessment, presentation: rep.presentation, format_findings: rep.format_findings, format_statistics: rep.formatSummary, patterns: rep.patterns, stage_blame: rep.stage_blame, recommendations: rep.recommendations, metrics: rep.metrics, log_stats: rep.logStats })}\n\n=== INDIVIDUAL AUDITS (weakest first) ===\n${JSON.stringify(compact)}\n\n=== PIPELINE LOGS OF THE WEAKEST NOTES ===\n${logs}\n\nReturn ONLY the JSON.`, null,
    { maxOutputTokens: 28000, temperature: 0.3, responseMimeType: 'application/json', timeoutMs: 280000, retries: 1, thinkingBudget: 4096, hedgeMs: 0 });
  const out = parseJ(raw); const text = String(out.prompt || '');
  if (text.length < current.length * 0.75 || text.length > current.length * 1.25) throw new Error(`upgraded prompt length ${text.length} is outside the allowed range of the current ${current.length}`);
  if (!/STRICT JSON|schema/i.test(text)) throw new Error('upgraded prompt dropped the strict-JSON instruction');
  const cand = { id: uid('cand'), createdAt: new Date().toISOString(), basedOnRun: rep.runId, basedOnReport: reportId, basePromptChars: current.length, chars: text.length, patterns: (rep.patterns || []).map((x) => `${x.title} (${x.count}/${x.of}, ${x.stage})`), changes: out.changes || [], suggestions: out.suggestions || [], summary: out.summary || '', usedFixtures: ranked.slice(0, 24).map((x) => x.id), text };
  writeJson(path.join(DATA, 'candidates', cand.id + '.json'), cand); return cand;
}

const OVERALL_SYS = `You are a clinical-AI quality lead. You receive the audit of many SOAP notes written by an AI scribe pipeline (each audit compares the AI note with the transcript and a clinician's gold note), the run's metrics, and statistics from the pipeline logs.
The pipeline stages are: writer (one LLM call drafting the note, driven by a long prompt of rules), checklist (parallel LLM call extracting meds/results/orders/referrals which is merged back), cleanup (deterministic removal of commentary/duplicates/misplaced facts), verifier (LLM flags unsupported/duplicate lines, code confirms before removing), guardrails/condense (deterministic).
Also judge conformance to the clinic's note template (empty fields when unsupported, no invented diagnosis, no separate medication or follow-up lists, completed vs planned investigations).
The doctor's priorities, in order: (1) nothing wrong or invented; (2) FLOW — the note reads top to bottom as one story; (3) HUMAN EASY READING — short plain lines, each label once, nothing repeated; (4) FACTS DISPLAYED AND ORGANISED PROPERLY — every fact in the right section, topic and label, and every issue the doctor addressed with its own problem in the plan, including advice and follow-up lines; (5) completeness. Content always comes from the transcript and the doctor's Style Spec v1; the gold notes are the model for LAYOUT only.
${STYLE_SPEC_V1_SHORT}
${GOLD_FORMAT_PRINCIPLES}
You also receive FORMAT STATISTICS computed by code over EVERY note of the run (ours versus gold): problems per note, repeated label lines, run-on lines, advice and follow-up lines, share of gold problems that have a match. Use them as hard numbers, and use each audit's "presentation" scores and "ap_gaps" to find recurring layout and A&P-completeness patterns. Mark every pattern and recommendation "spec":"inside_spec" when it can be done within Style Spec v1, or "beyond_spec" when it would change the locked spec (those are proposals for the owner only and must say so).
Diagnose the SYSTEM, not single notes. Return JSON:
{"headline":"one sentence verdict","assessment":"3-5 sentences that cover both content and how the notes read","what_works":["..."],
 "presentation":{"flow":N,"readability":N,"organization":N,"verdict":"2 sentences on how the notes read compared with the gold layout"},
 "format_findings":[{"title":"...","count":N,"of":N,"principle":"F1-F7","spec":"inside_spec|beyond_spec","evidence":"numbers from the statistics or audits","fix":"generic change to the pipeline or writer instructions that would close the gap"}],
 "patterns":[{"title":"...","count":N,"of":N,"severity":"critical|major|minor","stage":"writer|checklist|verifier|cleanup|rules|data","evidence":"what recurs","example":"short generic example"}],
 "stage_blame":{"writer":N,"checklist":N,"verifier":N,"cleanup":N,"rules":N,"data":N},
 "recommendations":[{"title":"...","detail":"exactly what to change","category":"prompt|setting|pipeline|guardrail|data|metric","stage":"writer|checklist|verifier|cleanup|rules|data","impact":"high|medium|low","effort":"low|medium|high","spec":"inside_spec|beyond_spec"}]}
"presentation" values are the mean of the audited notes' scores. Order recommendations by impact. Only claim what the audits and statistics support; give counts. At most 8 patterns, 8 format_findings and 10 recommendations.`;
function logStats(runId) {
  const tr = readJson(traceFile(runId), {}); const ids = Object.keys(tr); const s = { notes_with_logs: ids.length, verifier_removed: 0, verifier_refused: 0, verifier_skipped: 0, cleanup_removed: 0, checklist_skipped: 0, checklist_merged: 0, dedupe_removed: 0, stage_ms: {} };
  for (const id of ids) {
    for (const l of tr[id].log || []) {
      if (/\[v2:verify\] ✂/.test(l)) s.verifier_removed++; if (/\[v2:verify\] refused/.test(l)) s.verifier_refused++; if (/\[v2:verify\] skipped/.test(l)) s.verifier_skipped++;
      const c = l.match(/\[v2:clean\] removed (\d+)/); if (c) s.cleanup_removed += Number(c[1]); if (/\[v2:checklist\] skipped/.test(l)) s.checklist_skipped++;
      if (/\[v2:merge\]|merged from checklist|checklist merge/i.test(l)) s.checklist_merged++; const d = l.match(/\[dedupe\] 0 duplicate problem\(s\) merged, (\d+) duplicate/); if (d) s.dedupe_removed += Number(d[1]);
    }
    for (const [k, v] of Object.entries(tr[id].trace?.timings || {})) { (s.stage_ms[k] ||= []).push(v); }
  }
  s.stage_ms = Object.fromEntries(Object.entries(s.stage_ms).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]));
  return s;
}
// format statistics over EVERY note of a run (code only, no LLM): layout of ours vs gold, gold problems with no match, repeated labels, run-on lines, advice and follow-up lines
function formatSummary(runId) {
  const run = loadRun(runId); if (!run) return null; const notes = readJson(notesFile(runId), {}); const reps = [];
  for (const r of run.rows) { if (r.error || r.gold_corrupt || !notes[r.id]) continue; try { const { gold } = loadFixture(r.id); if (gold) reps.push(formatReport(notes[r.id], gold)); } catch { /* fixture missing */ } }
  return reps.length ? aggregateFormat(reps) : null;
}
const reports = new Map();
async function startReport(runId, limit = 15) {
  const run = loadRun(runId); if (!run || run.status === 'running') throw new Error('pick a finished run');
  const notes = readJson(notesFile(runId), {});
  const fmtBad = (id) => { try { const f = formatReport(notes[id], loadFixture(id).gold); return Math.min(1, (f.flags.length + f.missing_gold_problems.length * 0.5) / 6); } catch { return 0; } };   // notes that read badly rank next to notes that omit facts
  const ranked = run.rows.filter((r) => !r.error && !r.gold_corrupt && notes[r.id]).map((r) => ({ id: r.id, bad: (r.omission_rate || 0) * 0.45 + (1 - (r.similarity_to_gold || 0)) * 0.3 + fmtBad(r.id) * 0.25 })).sort((a, b) => b.bad - a.bad);
  const pick = ranked.slice(0, Math.min(Math.max(5, Number(limit) || 15), 40)).map((r) => r.id);
  const rep = { id: uid('rep'), runId, status: 'running', stage: 'auditing notes', createdAt: new Date().toISOString(), progress: { done: 0, total: pick.length }, notes: pick.length, recommendations: [], patterns: [] };
  reports.set(rep.id, rep); const save = () => writeJson(path.join(DATA, 'reports', rep.id + '.json'), rep); save();
  (async () => {
    await auditMany(runId, pick, (d) => { rep.progress.done = d; });
    rep.stage = 'diagnosing the system'; save();
    const audits = readJson(analysisFile(runId), {}); const used = pick.filter((id) => audits[id]);
    if (used.length < 3) throw new Error('fewer than 3 notes could be audited');
    const compact = used.map((id) => { const a = audits[id]; return { note: id, verdict: a.verdict, score: a.score, summary: a.summary, presentation: a.presentation, missing: (a.missing || []).slice(0, 6), wrong: (a.wrong || []).slice(0, 6), extra: (a.extra || []).slice(0, 4), ap_gaps: (a.ap_gaps || []).slice(0, 8), structure: a.structure, root_cause: a.root_cause, suggestions: a.suggestions }; });
    const stats = logStats(runId); rep.logStats = stats; rep.metrics = run.summary; rep.config = run.config;
    const fmt = formatSummary(runId); rep.formatSummary = fmt;
    const llm = await createGeminiService(null, { model: IMPROVE_MODEL }); llm._agent = 'lab-overall';
    const raw = await llm.generateContent(OVERALL_SYS, `=== RUN ===\nwriter: ${run.config.writerModel || 'default'} · prompt: ${run.config.promptSource} · ${run.config.n} notes (the ${used.length} worst-scoring were audited)\nmetrics: ${JSON.stringify(run.summary)}\n\n=== PIPELINE LOG STATS (all notes) ===\n${JSON.stringify(stats)}\n\n=== FORMAT STATISTICS, ours vs gold, over ${fmt?.notes ?? 0} notes ===\n${JSON.stringify(fmt)}\n\n=== AUDITS ===\n${JSON.stringify(compact)}\n\nReturn ONLY the JSON.`, null,
      { maxOutputTokens: 11000, temperature: 0.2, responseMimeType: 'application/json', timeoutMs: 240000, retries: 1, thinkingBudget: 2048, hedgeMs: 0 });
    const out = parseJ(raw);
    Object.assign(rep, { headline: out.headline, assessment: out.assessment, what_works: out.what_works || [], presentation: out.presentation || null, format_findings: out.format_findings || [], patterns: out.patterns || [], stage_blame: out.stage_blame || {},
      recommendations: (out.recommendations || []).map((r, i) => ({ ...r, id: 'r' + (i + 1), status: 'open' })), audited: used.length, status: 'done', stage: 'done', finishedAt: new Date().toISOString() });
    save();
  })().catch((e) => { rep.status = 'error'; rep.error = String(e.message || e); save(); });
  return rep.id;
}

// custom input: paste a transcript (optionally with a gold note) → note, pipeline log, metrics
async function tryTranscript({ transcript, gold = '', writerModel, prompt, candidateId, promptText, editor, story }) {
  const t = String(transcript || '').trim(); if (t.length < 80) throw new Error('transcript is too short');
  const p = await resolvePrompt({ prompt, candidateId, promptText }); const log = []; const trace = {}; const t0 = Date.now();
  const r = await generateNote({ transcript: t.slice(0, 120000), specialty: 'auto', noteType: 'consultation', clinicianId: 'lab' },
    { persist: false, mode: 'v2', writerPrompt: p.text, writerModel: writerModel || undefined, ...(editor !== undefined ? { editor: !!editor } : {}), ...(story !== undefined ? { story: !!story } : {}), onLog: (l) => { if (log.length < 400) log.push(l); }, trace });
  let metrics = null;
  if (String(gold).trim().length > 100) { const noteText = noteToText(r.note); const sc = M.scoreNote({ note: r.note, noteText, goldText: String(gold), entities: [] }); metrics = { similarity_to_gold: sc.similarity_to_gold, omission_rate: sc.omission_rate, omission_missed: sc.omission_missed, story_flow: sc.story_flow, section_coverage: sc.section_coverage }; }
  return { note: r.renderedNote || '', json: r.note, ms: Date.now() - t0, promptSource: p.source, log, trace, metrics };
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

app.get('/info', wrap(async (_req, res) => { const idx = goldIndex(); res.json({ fixtures: idx.length, usable: idx.filter((x) => x.ok).length, models: { judge: JUDGE_MODEL, improve: IMPROVE_MODEL }, writerModel: (await effectiveConfig())['writer.model'], writerFallback: (await effectiveConfig())['writer.fallbackModel'], concurrency: Number(process.env.LAB_CONCURRENCY) || 3 }); }));
app.get('/baseline', wrap(async (_req, res) => { const a = await getActivePrompt('v2-writer'); res.json({ source: a ? 'production-active' : 'default', chars: (a || defaultWriterPrompt()).length, text: a || defaultWriterPrompt() }); }));
app.get('/fixtures', wrap(async (_req, res) => { const f = goldIndex().filter((x) => x.ok).map((x) => [x.id, x.tChars, x.gChars]); res.json({ fixtures: f }); }));   // compact tuples: [id, transcriptChars, goldChars]
app.get('/fixtures/:id', wrap(async (req, res) => res.json(loadFixture(req.params.id))));
app.post('/runs', wrap(async (req, res) => res.json({ id: await startRun(req.body || {}) })));
app.get('/runs', wrap(async (_req, res) => {
  const ids = fs.readdirSync(path.join(DATA, 'runs')).filter((f) => f.startsWith('run_') && !/.(notes|trace).json$/.test(f)).map((f) => f.replace('.json', ''));
  const list = ids.map((id) => loadRun(id)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60).map((r) => runView(r));
  res.json({ runs: list });
}));
app.get('/runs/:id', wrap(async (req, res) => { const r = loadRun(req.params.id); r ? res.json(runView(r, true)) : res.status(404).json({ error: 'not found' }); }));
app.get('/runs/:id/prompt', wrap(async (req, res) => { const r = loadRun(req.params.id); r ? res.json({ text: r.prompt, source: r.config.promptSource }) : res.status(404).json({ error: 'not found' }); }));
app.get('/runs/:id/rows/:fid', wrap(async (req, res) => { const notes = readJson(notesFile(req.params.id), {}); const { transcript, gold } = loadFixture(req.params.fid); const tr = readJson(traceFile(req.params.id), {})[req.params.fid] || null; const row = (loadRun(req.params.id)?.rows || []).find((x) => x.id === req.params.fid) || null; res.json({ note: notes[req.params.fid] || '', transcript, gold, log: tr?.log || [], trace: tr?.trace || null, row, audit: readJson(analysisFile(req.params.id), {})[req.params.fid] || null }); }));
app.post('/runs/:id/cancel', wrap(async (req, res) => { const r = runs.get(req.params.id); if (r && r.status === 'running') { r.status = 'cancelled'; } res.json({ ok: true }); }));
app.post('/judge', wrap(async (req, res) => res.json({ id: await startJudge(req.body?.a, req.body?.b, Math.min(Number(req.body?.limit) || 30, 60)) })));
app.get('/judge/:id', wrap(async (req, res) => { const j = readJson(path.join(DATA, 'judges', req.params.id + '.json')); j ? res.json(j) : res.status(404).json({ error: 'not found' }); }));
app.post('/improve', wrap(async (req, res) => res.json(await improve(req.body?.runId, Number(req.body?.k) || 6))));
app.post('/runs/:id/rows/:fid/audit', wrap(async (req, res) => res.json(await auditNote(req.params.id, req.params.fid, { force: !!req.body?.force }))));
app.get('/runs/:id/audits', wrap(async (req, res) => { const a = readJson(analysisFile(req.params.id), {}); res.json({ audits: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { verdict: v.verdict, score: v.score, summary: v.summary }])) }); }));
app.get('/runs/:id/format', wrap(async (req, res) => { const f = formatSummary(req.params.id); f ? res.json(f) : res.status(404).json({ error: 'not found' }); }));
app.get('/format-principles', wrap(async (_req, res) => res.json({ principles: GOLD_FORMAT_PRINCIPLES, specShort: STYLE_SPEC_V1_SHORT })));
app.post('/runs/:id/report', wrap(async (req, res) => res.json({ id: await startReport(req.params.id, req.body?.limit) })));
app.get('/reports', wrap(async (_req, res) => res.json({ reports: fs.readdirSync(path.join(DATA, 'reports')).map((f) => readJson(path.join(DATA, 'reports', f))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(({ patterns, recommendations, what_works, ...r }) => ({ ...r, recs: recommendations?.length || 0, open: recommendations?.filter((x) => x.status === 'open').length || 0 })) })));
app.get('/reports/:id', wrap(async (req, res) => { const r = reports.get(req.params.id) || readJson(path.join(DATA, 'reports', req.params.id + '.json')); r ? res.json(r) : res.status(404).json({ error: 'not found' }); }));
app.patch('/reports/:id/recs/:rid', wrap(async (req, res) => { const f = path.join(DATA, 'reports', req.params.id + '.json'); const r = readJson(f); if (!r) return res.status(404).json({ error: 'not found' }); const rec = r.recommendations.find((x) => x.id === req.params.rid); if (!rec) return res.status(404).json({ error: 'not found' }); if (!['open', 'accepted', 'dismissed', 'done'].includes(req.body?.status)) return res.status(400).json({ error: 'bad status' }); rec.status = req.body.status; writeJson(f, r); reports.delete(r.id); res.json({ ok: true }); }));
// run-level quality scores (parity / audits) stored on the run so Trends can chart them
app.put('/runs/:id/quality', wrap(async (req, res) => { const r = loadRun(req.params.id); if (!r) return res.status(404).json({ error: 'not found' }); const q = {}; for (const k of ['parity_mean', 'parity_at90', 'parity_n', 'audit_mean', 'goldref_mean', 'critical_per_note', 'unsafe']) if (typeof req.body?.[k] === 'number') q[k] = req.body[k]; r.quality = { ...(r.quality || {}), ...q, at: new Date().toISOString() }; writeJson(runFile(r.id), r); runs.delete(r.id); res.json({ ok: true, quality: r.quality }); }));
app.post('/runs/:id/parity', wrap(async (req, res) => {
  const r = loadRun(req.params.id); if (!r || r.status === 'running') return res.status(400).json({ error: 'pick a finished run' });
  const notes = readJson(notesFile(r.id), {}); const ids = r.rows.filter((x) => !x.error && notes[x.id]).map((x) => x.id); res.json({ started: ids.length });
  (async () => { const sc = []; let i = 0; await Promise.all(Array.from({ length: 5 }, async () => { while (i < ids.length) { const id = ids[i++]; try { const p = await parityScore(notes[id], loadFixture(id).gold); if (typeof p.overall_score === 'number') sc.push(p.overall_score); } catch { /* skip */ } } }));
    if (sc.length) { const f = loadRun(r.id); f.quality = { ...(f.quality || {}), parity_mean: +(sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(2), parity_at90: sc.filter((x) => x >= 90).length, parity_n: sc.length, at: new Date().toISOString() }; writeJson(runFile(f.id), f); runs.delete(f.id); } })().catch(() => {});
}));
app.post('/parity', wrap(async (req, res) => { if (!req.body?.note || !req.body?.gold) return res.status(400).json({ error: 'note and gold are required' }); res.json(await parityScore(req.body.note, req.body.gold)); }));
app.post('/audit-adhoc', wrap(async (req, res) => { if (!req.body?.transcript || !req.body?.note) return res.status(400).json({ error: 'transcript and note are required' }); res.json(await auditAdhoc(req.body)); }));
app.post('/try', wrap(async (req, res) => res.json(await tryTranscript(req.body || {}))));
// predefined audio library: real simulated consultations (mp3) with their human transcripts — play, download, reuse the transcript
const AUDIO = path.join(DATA, 'audio'); const CAT = { CAR: 'Cardiovascular', DER: 'Dermatology', GAS: 'Gastrointestinal', MSK: 'Musculoskeletal', RES: 'Respiratory' };
app.get('/audio', wrap(async (_req, res) => res.json({ audio: fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3')).sort().map((f) => { const id = f.replace(/\.mp3$/, ''); const st = fs.statSync(path.join(AUDIO, f)); return { id, category: CAT[id.slice(0, 3)] || 'Other', bytes: st.size, minutes: Math.max(1, Math.round(st.size / 330000)), hasTranscript: fs.existsSync(path.join(AUDIO, id + '.txt')) }; }) })));
app.get('/audio/:id/file', wrap(async (req, res) => { if (!/^[A-Za-z0-9_-]+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' }); const f = path.join(AUDIO, req.params.id + '.mp3'); if (!fs.existsSync(f)) return res.status(404).json({ error: 'not found' }); if (req.query.download) res.attachment(req.params.id + '.mp3'); res.sendFile(f, { acceptRanges: true }); }));
app.get('/audio/:id/transcript', wrap(async (req, res) => { if (!/^[A-Za-z0-9_-]+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' }); const f = path.join(AUDIO, req.params.id + '.txt'); if (!fs.existsSync(f)) return res.status(404).json({ error: 'no transcript' }); res.json({ id: req.params.id, text: fs.readFileSync(f, 'utf8') }); }));
app.get('/audit-prompt', wrap(async (_req, res) => res.json({ text: auditSys(), custom: fs.existsSync(auditPromptFile), template: GOLD_TEMPLATE_SPEC })));
app.put('/audit-prompt', wrap(async (req, res) => { const t = String(req.body?.text || '').trim(); if (t.length < 300 || t.length > 20000 || !/JSON/.test(t) || !/verdict/.test(t) || !/missing/.test(t)) return res.status(400).json({ error: 'the audit prompt must be 300–20,000 characters and keep the JSON fields (verdict, score, missing, wrong, extra, structure, root_cause, suggestions)' }); fs.writeFileSync(auditPromptFile, t); res.json({ ok: true }); }));
app.delete('/audit-prompt', wrap(async (_req, res) => { try { fs.unlinkSync(auditPromptFile); } catch { /* already default */ } res.json({ ok: true }); }));
app.post('/reports/:id/upgrade', wrap(async (req, res) => res.json(await upgradeFromReport(req.params.id))));
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
