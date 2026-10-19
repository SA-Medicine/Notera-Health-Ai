#!/usr/bin/env node
// One iteration of the improvement loop, measured like-for-like:
//   same note set → generate with the DEPLOYED pipeline → audit every note against the transcript ONLY (no gold reference,
//   so it is directly comparable to the clinicians' own gold notes audited the same way) → mean score, verdicts, deltas.
//   node scripts/harness-iterate.mjs --name iter1 [--from run_xxx] [--n 50] [--model gemini-2.5-flash] [--gold]
//   --from  reuse the note IDS of an earlier run (default: the baseline 50-note run)    --gold  also audit the gold notes (ceiling)   --old-run run_2026-09-01_07-16-58  use that old run's fixtures   --story  story agent on   --story-model gemini-2.5-flash   --recall  extended recall on   --default-model gemini-3.7-flash  model for every agent that has no explicit one (the v1 agents)   --model default  = use the production defaults as deployed   --prompt-file f.txt  use exactly that writer prompt   --prompt-extra-file f.txt  append that text to the default writer prompt   --ids-file ids.json   --aux-model gemini-3.7-flash  checklist+verifier model   --mode v1  run the OLD multi-agent pipeline   --ids-from <iteration name>  reuse that iteration's notes   --editor  editor pass on   --temp 0.1  --topp 0.9  --think 1024  --prompt cand_xxx
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

const used = new Set(); for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && x !== 'gold_ceiling.json')) Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).scores || {}).forEach((i) => used.add(i));
try { JSON.parse(fs.readFileSync(path.resolve('packages/backend/exemplars/bank.json'), 'utf8')).forEach((b) => used.add(b.id)); } catch { /* no bank */ }
let ids; const AUDIT_RUN = arg('audit-run', '');
if (AUDIT_RUN) { const r0 = await lab('/runs/' + AUDIT_RUN); ids = r0.ids || r0.rows.map((r) => r.id); }
else if (arg('ids', '')) { ids = arg('ids').split(','); }
else if (arg('old-run', '')) { ids = fs.readdirSync(path.resolve('eval/results', arg('old-run'))).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.replace(/.md$/, '')); }
else if (arg('ids-file', '')) { ids = JSON.parse(fs.readFileSync(arg('ids-file'), 'utf8')); }
else if (arg('ids-from', '')) { ids = Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, arg('ids-from') + '.json'), 'utf8')).scores); }
else if (arg('fresh', '')) { const all = (await lab('/fixtures')).fixtures.map((f) => f[0]).filter((i) => !used.has(i)); for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; } ids = all.slice(0, Number(arg('fresh'))); }
else { const src = await lab('/runs/' + FROM); ids = (src.ids || src.rows.map((r) => r.id)).slice(0, Number(arg('n', 50))); }
const baseText = arg('prompt-extra-file', '') ? (await lab('/baseline')).text : '';
const runId = AUDIT_RUN || (await lab('/runs', { ids, ...(MODEL === 'default' ? {} : { writerModel: MODEL }), label: NAME, ...(has('editor') ? { editor: true } : {}), ...(has('recall') ? { recall: true } : {}), ...(has('story') ? { story: true } : {}), ...(has('guard-template') ? { guardTemplate: true } : {}), ...(has('guard-placement') ? { guardPlacement: true } : {}), ...(arg('story-model', '') ? { storyModel: arg('story-model') } : {}), ...(arg('mode', '') ? { mode: arg('mode') } : {}), ...(arg('default-model', '') ? { defaultModel: arg('default-model') } : {}), ...(arg('aux-model', '') ? { auxModel: arg('aux-model') } : {}), ...(arg('prompt-file', '') ? { promptText: fs.readFileSync(arg('prompt-file'), 'utf8'), promptSource: 'file:' + path.basename(arg('prompt-file')) } : {}), ...(arg('prompt-extra-file', '') ? { promptText: baseText + '\n\n' + fs.readFileSync(arg('prompt-extra-file'), 'utf8').trim(), promptSource: 'default+' + path.basename(arg('prompt-extra-file')) } : {}), ...(arg('temp', '') !== '' ? { writerTemp: Number(arg('temp')) } : {}), ...(arg('think', '') !== '' ? { writerThinking: Number(arg('think')) } : {}), ...(arg('topp', '') !== '' ? { writerTopP: Number(arg('topp')) } : {}), ...(arg('prompt', '') ? { candidateId: arg('prompt') } : {}), ...(arg('fewshot', '') !== '' ? { fewShot: Number(arg('fewshot')) } : {}) })).id;
console.log(`${NAME}: run ${runId} (${ids.length} notes, ${MODEL})`);
let run; for (;;) { run = await lab('/runs/' + runId); process.stdout.write(`\r  generating ${run.progress.done}/${run.progress.total}  `); if (run.status !== 'running') break; await sleep(6000); }
console.log(`\n  similarity(shown) ${run.summary.avg_similarity_rendered ?? '-'} · similarity ${run.summary.avg_similarity_to_gold} omission ${run.summary.avg_omission_rate} flow ${run.summary.avg_story_flow} p50 ${run.summary.p50_s}s p95 ${run.summary.p95_s}s failed ${run.summary.failed}`);

const parity = {}; const parDetails = {}; const scores = {}; const details = {}; const goldref = {}; const refDetails = {}; const reviews = {};
const goldFile = path.join(DIR, 'gold_ceiling.json'); let gold = fs.existsSync(goldFile) ? JSON.parse(fs.readFileSync(goldFile, 'utf8')) : null;
const rowsOk = run.rows.filter((r) => !r.error).map((r) => r.id);
let done = 0;
await pool(rowsOk, 4, async (id) => {
  try {
    const fx = await lab(`/runs/${runId}/rows/${encodeURIComponent(id)}`);
    if (has('parity')) { const pr = await lab('/parity', { note: fx.note, gold: fx.gold }); parity[id] = pr.overall_score; parDetails[id] = pr; }
    if (has('only-parity')) { process.stdout.write('\r  parity ' + Object.keys(parity).length + '/' + rowsOk.length + '  '); return; }
    const a = await lab('/audit-adhoc', { transcript: fx.transcript, note: fx.note });
    if (has('goldref')) { const gr = await lab('/runs/' + runId + '/rows/' + encodeURIComponent(id) + '/audit', {}); goldref[id] = gr.score; refDetails[id] = gr; }
    reviews[id] = { note: fx.note, log: (fx.log || []).filter((l) => !/Timing]|tokens]/.test(l)), exemplars: fx.trace?.exemplars, editor: fx.trace?.editor?.why };
    scores[id] = a.score; details[id] = { verdict: a.verdict, score: a.score, wrong: (a.wrong || []).map((w) => ({ s: w.severity, c: w.claim, p: w.problem })), missing: (a.missing || []).map((m) => ({ i: m.importance, f: m.fact })), extra: (a.extra || []).length, structure: a.structure || [], cause: a.root_cause?.stage };
    if (has('gold') && !gold?.scores?.[id]) { gold = gold || { scores: {} }; const g = await lab('/audit-adhoc', { transcript: fx.transcript, note: fx.gold }); gold.scores[id] = g.score; }
  } catch (e) { console.log('  audit failed', id, e.message); }
  process.stdout.write(`\r  auditing ${++done}/${rowsOk.length}  `);
});
if (Object.keys(parity).length) {
  const pv = Object.values(parity).filter((x) => typeof x === 'number'); const verd = {}; Object.values(parDetails).forEach((d) => { verd[d.verdict] = (verd[d.verdict] || 0) + 1; });
  const dim = (name, who) => mean(Object.values(parDetails).map((d) => (d.dimensions || []).find((x) => x.name === name)?.[who]).filter((x) => typeof x === 'number'));
  console.log(`\n${NAME}: PARITY score (the original comparator, Notera vs gold) mean ${mean(pv).toFixed(1)} · ${pv.filter((x) => x >= 90).length}/${pv.length} notes at 90+ · verdicts ${JSON.stringify(verd)}`);
  console.log('  dimensions (notera vs gold, 0-5): ' + ['Faithfulness', 'Completeness', 'Structure', 'Clarity'].map((n) => n + ' ' + dim(n, 'notera')?.toFixed(2) + ' vs ' + dim(n, 'gold')?.toFixed(2)).join(' · '));
  fs.writeFileSync(path.join(DIR, NAME + '.parity.json'), JSON.stringify({ name: NAME, runId, mean: +mean(pv).toFixed(2), n: pv.length, at90: pv.filter((x) => x >= 90).length, verdicts: verd, parity, details: parDetails }));
}
if (has('only-parity')) process.exit(0);
if (gold) fs.writeFileSync(goldFile, JSON.stringify(gold));
const vals = Object.values(scores); const verdicts = {}; Object.values(details).forEach((d) => { verdicts[d.verdict] = (verdicts[d.verdict] || 0) + 1; });
const crit = Object.values(details).reduce((s, d) => s + d.wrong.filter((w) => w.s === 'critical').length, 0);
const meanRef = Object.keys(goldref).length ? mean(Object.values(goldref)) : null;
const out = { goldref_mean: meanRef != null ? +meanRef.toFixed(2) : null, goldref, critical_per_note: +(crit / Math.max(1, vals.length)).toFixed(3), name: NAME, runId, model: MODEL, notes: vals.length, mean_audit: +mean(vals).toFixed(2), verdicts, critical_wrong: crit, unsafe: verdicts.unsafe || 0, summary: run.summary, details, scores, at: new Date().toISOString() };
fs.writeFileSync(path.join(DIR, NAME + '.json'), JSON.stringify(out));
const goldMean = gold ? mean(ids.map((i) => gold.scores[i]).filter((x) => x != null)) : null;
if (meanRef != null) console.log(`\n${NAME}: GOLD-REFERENCED audit mean ${meanRef.toFixed(1)} (target 90) · verdicts ${JSON.stringify(Object.values(refDetails).reduce((o, a) => ((o[a.verdict] = (o[a.verdict] || 0) + 1), o), {}))}`);
if (has('review')) { const md = ['# Manual log review — ' + NAME, '', ...Object.keys(reviews).flatMap((id) => { const r = reviews[id], d = details[id], g = refDetails[id]; return ['## ' + id + ' — transcript-only ' + d.score + (g ? ', gold-referenced ' + g.score + ' (' + g.verdict + ')' : ''), '', '```', ...(r.log || []).slice(0, 40), '```', 'exemplars: ' + JSON.stringify(r.exemplars || []) + ' · editor: ' + (r.editor || '-'), '', '**Note**', '', r.note, '', '**Audit findings**', ...((g || d).wrong || []).slice(0, 6).map((w) => '- WRONG ' + (w.severity || w.s) + ': ' + (w.claim || w.c) + ' — ' + (w.problem || w.p)), ...((g || d).missing || []).slice(0, 6).map((m) => '- MISSING ' + (m.importance || m.i) + ': ' + (m.fact || m.f)), ''] })].join('\n'); fs.writeFileSync(path.join(DIR, NAME + '.review.md'), md); console.log('review dump: docs/reports/iterations/' + NAME + '.review.md'); }
console.log(`\n${NAME}: mean audit ${out.mean_audit} · verdicts ${JSON.stringify(verdicts)} · critical wrong claims ${crit} (${(crit / Math.max(1, vals.length)).toFixed(2)} per note; TARGET < 0.10)${goldMean != null ? ` · gold notes ${goldMean.toFixed(1)}` : ''}`);
const prevName = arg('vs', ''); if (prevName && fs.existsSync(path.join(DIR, prevName + '.json'))) {
  const p = JSON.parse(fs.readFileSync(path.join(DIR, prevName + '.json'), 'utf8')); const common = Object.keys(scores).filter((i) => p.scores[i] != null);
  const d = common.map((i) => scores[i] - p.scores[i]); const up = d.filter((x) => x > 5).length, down = d.filter((x) => x < -5).length;
  console.log(`vs ${prevName}: mean ${p.mean_audit} → ${out.mean_audit} (Δ ${(out.mean_audit - p.mean_audit).toFixed(1)}), ${up} notes better / ${down} worse by >5 points; unsafe ${p.unsafe} → ${out.unsafe}; critical wrong ${p.critical_wrong} → ${crit}; p50 ${p.summary.p50_s}s → ${run.summary.p50_s}s`);
}
// store the scores on the run so Trends can chart them
try { const q = {}; if (Object.keys(parity).length) { const pv = Object.values(parity).filter((x) => typeof x === 'number'); q.parity_mean = +mean(pv).toFixed(2); q.parity_at90 = pv.filter((x) => x >= 90).length; q.parity_n = pv.length; } if (vals.length) { q.audit_mean = out.mean_audit; q.critical_per_note = out.critical_per_note; q.unsafe = out.unsafe; } if (meanRef != null) q.goldref_mean = out.goldref_mean;
  if (Object.keys(q).length) await fetch(BASE + '/runs/' + runId + '/quality', { method: 'PUT', headers: { 'X-Lab-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(q) }); } catch { /* optional */ }
