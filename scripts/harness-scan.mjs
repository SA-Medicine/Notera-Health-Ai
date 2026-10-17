#!/usr/bin/env node
// End-to-end harness scan against the deployed lab (Google VM): N random gold notes → generate → AUDIT EVERY NOTE →
// overall diagnosis → markdown report with the details of each note.
//   node scripts/harness-scan.mjs --n 50 --label "scan50 baseline" [--model gemini-2.5-flash] [--ids a,b,c] [--out docs/reports/SCAN.md]
//   LAB_URL (default https://api.aitoolsfordoctor.com/lab) · key read from secrets/lab-key.txt (never printed)
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i === -1 ? d : process.argv[i + 1]; };
const BASE = process.env.LAB_URL || 'https://api.aitoolsfordoctor.com/lab';
const KEY = fs.readFileSync(path.resolve('secrets/lab-key.txt'), 'utf8').trim();
const N = Number(arg('n', 50)); const LABEL = arg('label', `scan${N}`); const MODEL = arg('model', 'gemini-2.5-flash');
const OUT = arg('out', `docs/reports/SCAN_${new Date().toISOString().slice(0, 10)}_${LABEL.replace(/\W+/g, '-')}.md`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lab = async (p, opts = {}) => {
  const res = await fetch(BASE + p, { method: opts.method, headers: { 'X-Lab-Key': KEY, ...(opts.json ? { 'Content-Type': 'application/json' } : {}) }, body: opts.json ? JSON.stringify(opts.json) : undefined });
  const t = await res.text(); let d; try { d = JSON.parse(t); } catch { d = { error: t.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${p}: ${d.error || res.status}`); return d;
};
const f3 = (x) => (x == null ? '—' : Number(x).toFixed(3));

let ids = arg('ids', '') ? arg('ids').split(',') : null;
if (!ids) { const fx = (await lab('/fixtures')).fixtures.map((f) => f[0]); for (let i = fx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fx[i], fx[j]] = [fx[j], fx[i]]; } ids = fx.slice(0, N); }
const { id: runId } = await lab('/runs', { method: 'POST', json: { ids, writerModel: MODEL, label: LABEL } });
console.log(`run ${runId}: ${ids.length} notes with ${MODEL}`);
let run;
for (;;) { run = await lab('/runs/' + runId); process.stdout.write(`\r  generating ${run.progress.done}/${run.progress.total}   `); if (run.status !== 'running') break; await sleep(6000); }
console.log(`\nrun ${run.status}: similarity ${f3(run.summary?.avg_similarity_to_gold)} omission ${f3(run.summary?.avg_omission_rate)} flow ${f3(run.summary?.avg_story_flow)} p50 ${run.summary?.p50_s}s failed ${run.summary?.failed}`);

const rows = run.rows.filter((r) => !r.error);
const audits = {}; let next = 0, done = 0;
const worker = async () => { while (next < rows.length) { const r = rows[next++]; try { const a = await lab(`/runs/${runId}/rows/${encodeURIComponent(r.id)}/audit`, { method: 'POST', json: {} }); audits[r.id] = a;
  console.log(`[${++done}/${rows.length}] ${r.id}: ${a.verdict} ${a.score}/100 · sim ${f3(r.similarity_to_gold)} omit ${f3(r.omission_rate)} · missing ${(a.missing || []).length} wrong ${(a.wrong || []).length} extra ${(a.extra || []).length} · cause ${a.root_cause?.stage}`); } catch (e) { console.log(`[${++done}/${rows.length}] ${r.id}: audit failed — ${e.message}`); } } };
await Promise.all(Array.from({ length: 3 }, worker));

console.log('diagnosing the whole run…');
const { id: repId } = await lab(`/runs/${runId}/report`, { method: 'POST', json: { limit: 40 } });
let rep; for (;;) { rep = await lab('/reports/' + repId); if (rep.status !== 'running') break; await sleep(8000); }
if (rep.status !== 'done') console.log('diagnosis failed:', rep.error);

const vc = {}; Object.values(audits).forEach((a) => { vc[a.verdict] = (vc[a.verdict] || 0) + 1; });
const avgScore = Object.values(audits).reduce((s, a) => s + (a.score || 0), 0) / Math.max(1, Object.keys(audits).length);
const md = [`# Harness scan — ${LABEL}`, '', `Run \`${runId}\` · writer \`${MODEL}\` · ${ids.length} gold notes · ${new Date().toISOString()}`, '',
  `**Metrics** similarity ${f3(run.summary?.avg_similarity_to_gold)} · omission ${f3(run.summary?.avg_omission_rate)} · flow ${f3(run.summary?.avg_story_flow)} · coverage ${f3(run.summary?.avg_section_coverage)} · p50 ${run.summary?.p50_s}s · p95 ${run.summary?.p95_s}s · failed ${run.summary?.failed}`,
  `**Audit** mean score ${avgScore.toFixed(1)}/100 · verdicts ${JSON.stringify(vc)}`, '',
  ...(rep.status === 'done' ? ['## Overall diagnosis', '', `**${rep.headline}**`, '', rep.assessment, '', '### Patterns', ...(rep.patterns || []).map((p) => `- **${p.title}** (${p.stage}, ${p.severity}, ${p.count}/${p.of}) — ${p.evidence}`), '', '### Recommendations', ...(rep.recommendations || []).map((x, i) => `${i + 1}. **${x.title}** [${x.category}/${x.stage}, impact ${x.impact}, effort ${x.effort}] — ${x.detail}`), '', `Log stats: ${JSON.stringify(rep.logStats)}`, ''] : []),
  '## Notes', '', '| # | Note | Verdict | Score | Similarity | Omission | Missing | Wrong | Cause |', '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r, i) => { const a = audits[r.id] || {}; return `| ${i + 1} | ${r.id} | ${a.verdict || '—'} | ${a.score ?? '—'} | ${f3(r.similarity_to_gold)} | ${f3(r.omission_rate)} | ${(a.missing || []).length} | ${(a.wrong || []).length} | ${a.root_cause?.stage || '—'} |`; }), '',
  '## Per-note detail', '',
  ...rows.flatMap((r, i) => { const a = audits[r.id]; if (!a) return [`### ${i + 1}. ${r.id}`, 'audit unavailable', '']; return [`### ${i + 1}. ${r.id} — ${a.verdict} ${a.score}/100`, '', a.summary, '',
    `- similarity ${f3(r.similarity_to_gold)}, omission ${f3(r.omission_rate)}, ${r.note_words} words, ${(r.ms / 1000).toFixed(1)}s`,
    ...(a.missing || []).map((x) => `- MISSING (${x.importance}): ${x.fact}`), ...(a.wrong || []).map((x) => `- WRONG (${x.severity}): “${x.claim}” — ${x.problem}`),
    ...(a.extra || []).map((x) => `- EXTRA: “${x.text}” — ${x.why}`), ...(a.structure || []).map((x) => `- STRUCTURE: ${x}`), `- likely cause: ${a.root_cause?.stage} — ${a.root_cause?.why}`, ''].filter((l) => l !== undefined); }),
].join('\n');
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, md);
console.log(`\nreport written: ${OUT}\nverdicts ${JSON.stringify(vc)} · mean audit score ${avgScore.toFixed(1)}`);
console.log(JSON.stringify({ runId, reportId: repId, out: OUT }));
