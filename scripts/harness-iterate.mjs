#!/usr/bin/env node
// One iteration of the improvement loop, measured like-for-like:
//   same note set → generate with the DEPLOYED pipeline → audit every note against the transcript ONLY (no gold reference,
//   so it is directly comparable to the clinicians' own gold notes audited the same way) → mean score, verdicts, deltas.
//   node scripts/harness-iterate.mjs --name iter1 [--from run_xxx] [--n 50] [--model gemini-2.5-flash] [--gold]
//   --from  reuse the note IDS of an earlier run (default: the baseline 50-note run)    --gold  also audit the gold notes (ceiling)   --editor  turn the editor pass on for this run
// Results: docs/reports/iterations/<name>.json (+ prints the comparison with the previous iteration file, if any).
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i === -1 ? d : process.argv[i + 1]; };
const has = (k) => process.argv.includes('--' + k);
const BASE = process.env.LAB_URL || 'https://api.aitoolsfordoctor.com/lab';
const KEY = fs.readFileSync(path.resolve('secrets/lab-key.txt'), 'utf8').trim();
const NAME = arg('name', 'iter'); const FROM = arg('from', 'run_mvcfz4wofd64c5'); const MODEL = arg('model', 'gemini-2.5-flash');
const DIR = path.resolve('docs/reports/iterations'); fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lab = async (p, json) => {
  for (let a = 0; a < 3; a++) {
    try { const res = await fetch(BASE + p, { method: json ? 'POST' : 'GET', headers: { 'X-Lab-Key': KEY, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
      const d = await res.json(); if (!res.ok) throw new Error(d.error || res.status); return d; } catch (e) { if (a === 2) throw e; await sleep(2000); }
  }
};
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } })); };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const src = await lab('/runs/' + FROM); const ids = (src.ids || src.rows.map((r) => r.id)).slice(0, Number(arg('n', 50)));
const { id: runId } = await lab('/runs', { ids, writerModel: MODEL, label: NAME, ...(has('editor') ? { editor: true } : {}) });
console.log(`${NAME}: run ${runId} (${ids.length} notes, ${MODEL})`);
let run; for (;;) { run = await lab('/runs/' + runId); process.stdout.write(`\r  generating ${run.progress.done}/${run.progress.total}  `); if (run.status !== 'running') break; await sleep(6000); }
console.log(`\n  similarity ${run.summary.avg_similarity_to_gold} omission ${run.summary.avg_omission_rate} flow ${run.summary.avg_story_flow} p50 ${run.summary.p50_s}s p95 ${run.summary.p95_s}s failed ${run.summary.failed}`);

const scores = {}; const details = {};
const goldFile = path.join(DIR, 'gold_ceiling.json'); let gold = fs.existsSync(goldFile) ? JSON.parse(fs.readFileSync(goldFile, 'utf8')) : null;
const rowsOk = run.rows.filter((r) => !r.error).map((r) => r.id);
let done = 0;
await pool(rowsOk, 4, async (id) => {
  try {
    const fx = await lab(`/runs/${runId}/rows/${encodeURIComponent(id)}`);
    const a = await lab('/audit-adhoc', { transcript: fx.transcript, note: fx.note });
    scores[id] = a.score; details[id] = { verdict: a.verdict, score: a.score, wrong: (a.wrong || []).map((w) => ({ s: w.severity, c: w.claim, p: w.problem })), missing: (a.missing || []).map((m) => ({ i: m.importance, f: m.fact })), extra: (a.extra || []).length, structure: a.structure || [], cause: a.root_cause?.stage };
    if (has('gold') && !gold?.scores?.[id]) { gold = gold || { scores: {} }; const g = await lab('/audit-adhoc', { transcript: fx.transcript, note: fx.gold }); gold.scores[id] = g.score; }
  } catch (e) { console.log('  audit failed', id, e.message); }
  process.stdout.write(`\r  auditing ${++done}/${rowsOk.length}  `);
});
if (gold) fs.writeFileSync(goldFile, JSON.stringify(gold));
const vals = Object.values(scores); const verdicts = {}; Object.values(details).forEach((d) => { verdicts[d.verdict] = (verdicts[d.verdict] || 0) + 1; });
const crit = Object.values(details).reduce((s, d) => s + d.wrong.filter((w) => w.s === 'critical').length, 0);
const out = { name: NAME, runId, model: MODEL, notes: vals.length, mean_audit: +mean(vals).toFixed(2), verdicts, critical_wrong: crit, unsafe: verdicts.unsafe || 0, summary: run.summary, details, scores, at: new Date().toISOString() };
fs.writeFileSync(path.join(DIR, NAME + '.json'), JSON.stringify(out));
const goldMean = gold ? mean(ids.map((i) => gold.scores[i]).filter((x) => x != null)) : null;
console.log(`\n${NAME}: mean audit ${out.mean_audit} · verdicts ${JSON.stringify(verdicts)} · critical wrong claims ${crit}${goldMean != null ? ` · gold notes ${goldMean.toFixed(1)}` : ''}`);
const prevName = arg('vs', ''); if (prevName && fs.existsSync(path.join(DIR, prevName + '.json'))) {
  const p = JSON.parse(fs.readFileSync(path.join(DIR, prevName + '.json'), 'utf8')); const common = Object.keys(scores).filter((i) => p.scores[i] != null);
  const d = common.map((i) => scores[i] - p.scores[i]); const up = d.filter((x) => x > 5).length, down = d.filter((x) => x < -5).length;
  console.log(`vs ${prevName}: mean ${p.mean_audit} → ${out.mean_audit} (Δ ${(out.mean_audit - p.mean_audit).toFixed(1)}), ${up} notes better / ${down} worse by >5 points; unsafe ${p.unsafe} → ${out.unsafe}; critical wrong ${p.critical_wrong} → ${crit}; p50 ${p.summary.p50_s}s → ${run.summary.p50_s}s`);
}
