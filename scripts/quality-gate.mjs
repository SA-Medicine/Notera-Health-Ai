#!/usr/bin/env node
// Quality gate: "a change may only keep the notes the same or make them better".
//   node scripts/quality-gate.mjs <baseline-run-id> <new-run-id>        (lab key from secrets/lab-key.txt or LAB_KEY; API from LAB_API or the production host)
// Compares two lab runs of the SAME transcripts and exits 1 if the new run is worse on any hard check. Run it before every deploy of a pipeline change.
//   hard checks: no failed note · no more notes without a plan · topic headings not fewer · no repeated plan label · problems per note and gold-issue
//   coverage not lower than the baseline (small tolerance) · audit mean not lower (when both runs were audited) · median time not more than 15 % slower.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { formatReport, aggregate } = await import(pathToFileURL(path.resolve(HERE, '..', 'packages', 'backend', 'lab', 'formatMetrics.js')).href);
const [base, next] = process.argv.slice(2);
if (!base || !next) { console.error('usage: node scripts/quality-gate.mjs <baseline-run-id> <new-run-id>'); process.exit(2); }
const KEY = process.env.LAB_KEY || fs.readFileSync(path.resolve(HERE, '..', 'secrets', 'lab-key.txt'), 'utf8').trim();
const API = (process.env.LAB_API || 'https://api.aitoolsfordoctor.com') + '/lab';
const get = async (u) => (await fetch(API + u, { headers: { 'X-Lab-Key': KEY } })).json();

async function load(id) {
  const run = await get(`/runs/${id}`); const rows = [];
  for (const r of run.rows) { const d = await get(`/runs/${id}/rows/${encodeURIComponent(r.id)}`); rows.push({ id: r.id, error: r.error || null, note: d.note || '', gold: d.gold || '' }); }
  let audits = {}; try { audits = (await get(`/runs/${id}/audits`)).audits || {}; } catch { /* not audited */ }
  return { run, rows, audits };
}
const [A, B] = [await load(base), await load(next)];
const ok = (r) => r.note && !r.error;
const stat = (X) => {
  const good = X.rows.filter(ok); const agg = aggregate(good.map((r) => formatReport(r.note, r.gold)));
  const scores = Object.values(X.audits).map((a) => a.score).filter((n) => typeof n === 'number');
  return { notes: X.rows.length, failed: X.rows.length - good.length, noPlan: good.filter((r) => !/Assessment/.test(r.note)).length, headings: good.filter((r) => (r.note.match(/^\*\*[^*]+:?\*\*\s*$/gm) || []).length >= 2).length,
    problems: agg.ours.problems, repeated: agg.notes_with_repeated_labels, coverage: agg.gold_problem_coverage, audit: scores.length >= 10 ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null, p50: X.run.summary?.p50_s, p95: X.run.summary?.p95_s };
};
const a = stat(A), b = stat(B);
const checks = [
  ['failed notes', b.failed <= a.failed && b.failed === 0, `${a.failed} -> ${b.failed}`],
  ['notes without a plan', b.noPlan <= a.noPlan, `${a.noPlan} -> ${b.noPlan}`],
  ['notes with topic headings', b.headings >= a.headings - 1, `${a.headings} -> ${b.headings} (of ${b.notes - b.failed})`],
  ['notes with a repeated plan label', b.repeated === 0, `${a.repeated} -> ${b.repeated}`],
  ['A&P problems per note', b.problems >= a.problems - 0.15, `${a.problems} -> ${b.problems}`],
  ['gold issue coverage', (b.coverage ?? 0) >= (a.coverage ?? 0) - 0.03, `${a.coverage} -> ${b.coverage}`],
  ['audit content mean', a.audit == null || b.audit == null || b.audit >= a.audit - 1.5, `${a.audit ?? 'n/a'} -> ${b.audit ?? 'n/a'}`],
  ['median seconds per note', !a.p50 || !b.p50 || b.p50 <= a.p50 * 1.15, `${a.p50} -> ${b.p50}`],
];
console.log(`Quality gate: ${base}  ->  ${next}`);
for (const [name, pass, detail] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
// per-note regressions: a plan that vanished, or two or more problems lost
const regress = [];
for (const r of B.rows) { const o = A.rows.find((x) => x.id === r.id); if (!o || !ok(o)) continue; if (!ok(r)) { regress.push(`${r.id}: note failed (${String(r.error).slice(0, 60)})`); continue; }
  const po = formatReport(o.note, o.gold).ours.problems, pn = formatReport(r.note, r.gold).ours.problems;
  if (/Assessment/.test(o.note) && !/Assessment/.test(r.note)) regress.push(`${r.id}: lost its plan`); else if (po - pn >= 2) regress.push(`${r.id}: ${po} -> ${pn} problems`); }
console.log(regress.length ? 'Per-note regressions:\n  ' + regress.join('\n  ') : 'Per-note regressions: none');
const failed = checks.filter((c) => !c[1]);
console.log(failed.length ? `\nGATE FAILED (${failed.length} check${failed.length > 1 ? 's' : ''}). Do not deploy.` : '\nGATE PASSED: the new run is not worse than the baseline.');
process.exit(failed.length ? 1 : 0);
