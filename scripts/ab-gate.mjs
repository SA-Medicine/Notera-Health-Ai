#!/usr/bin/env node
// Paired A/B quality gate: is change B really worse than A, or is the difference just noise?
//   node scripts/ab-gate.mjs --ids-file ids.json --pairs 3 --a '{"conditionGuard":false}' --b '{}' [--name label] [--out result.json]
// The lab is run PAIR BY PAIR: in each pair side A and side B run at the same moment on the same transcripts (so API slowness hits both equally),
// then both runs are audited. Audit score and median time are compared per pair and averaged over the pairs.
//   worse  = mean audit difference (B - A) <= -1.5 and at least 2 of 3 pairs negative   (or B slower than A by > 15 % in at least 2 pairs, mean ratio > 1.15)
//   better = the same in the other direction;  anything else = no measurable difference (noise).
// The single-run gate (quality-gate.mjs) cannot tell noise from change: the same code scored 67.7 to 72.7 across runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { formatReport, aggregate } = await import(pathToFileURL(path.resolve(HERE, '..', 'packages', 'backend', 'lab', 'formatMetrics.js')).href);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const idsFile = arg('ids-file'); const pairs = Number(arg('pairs', 3)); const A = JSON.parse(arg('a', '{}')); const B = JSON.parse(arg('b', '{}')); const name = arg('name', 'ab'); const outFile = arg('out');
if (!idsFile) { console.error('usage: node scripts/ab-gate.mjs --ids-file ids.json [--pairs 3] --a JSON --b JSON'); process.exit(2); }
const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8')); const KEY = process.env.LAB_KEY || fs.readFileSync(path.resolve(HERE, '..', 'secrets', 'lab-key.txt'), 'utf8').trim();
const API = (process.env.LAB_API || 'https://api.aitoolsfordoctor.com') + '/lab'; const H = { 'X-Lab-Key': KEY, 'Content-Type': 'application/json' };
const get = async (u) => (await fetch(API + u, { headers: H })).json();
const post = async (u, body) => (await fetch(API + u, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function waitRun(id) { for (;;) { const r = await get(`/runs/${id}`); if (r.status !== 'running') return r; await sleep(8000); } }
async function waitReport(id) { for (;;) { const r = await get(`/reports/${id}`); if (r.status === 'done' || r.status === 'error') return r; await sleep(10000); } }
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

const results = []; const reportJobs = [];
for (let i = 1; i <= pairs; i++) {
  log(`pair ${i}: starting A and B together`);
  const [ra, rb] = await Promise.all([post('/runs', { ids, writerModel: 'gemini-3.7-flash', label: `${name}-A${i}`, ...A }), post('/runs', { ids, writerModel: 'gemini-3.7-flash', label: `${name}-B${i}`, ...B })]);
  const [da, db] = await Promise.all([waitRun(ra.id), waitRun(rb.id)]);
  log(`pair ${i}: generated  A p50=${da.summary?.p50_s}s failed=${da.summary?.failed}  B p50=${db.summary?.p50_s}s failed=${db.summary?.failed}; audits started`);
  const [pa, pb] = await Promise.all([post(`/runs/${ra.id}/report`, { limit: 30 }), post(`/runs/${rb.id}/report`, { limit: 30 })]);
  results.push({ pair: i, A: { run: ra.id, report: pa.id, p50: da.summary?.p50_s, p95: da.summary?.p95_s, failed: da.summary?.failed }, B: { run: rb.id, report: pb.id, p50: db.summary?.p50_s, p95: db.summary?.p95_s, failed: db.summary?.failed } });
  reportJobs.push(waitReport(pa.id), waitReport(pb.id));
}
log('waiting for the audits'); await Promise.all(reportJobs);
for (const r of results) for (const side of ['A', 'B']) {
  const s = r[side]; const au = Object.values((await get(`/runs/${s.run}/audits`)).audits || {}); s.audit = au.length ? +mean(au.map((x) => x.score || 0)).toFixed(1) : null; s.audited = au.length; s.unsafe = au.filter((x) => x.verdict === 'unsafe').length;
  const rep = await get(`/reports/${s.report}`); s.hallucination = (rep.patterns || []).filter((p) => /invent|hallucin|fabricat|unsupported/i.test(p.title)).reduce((n, p) => n + (p.count || 0), 0);
  const run = await get(`/runs/${s.run}`); const rows = []; for (const x of run.rows) { if (x.error) continue; const d = await get(`/runs/${s.run}/rows/${encodeURIComponent(x.id)}`); if (d.note) rows.push(formatReport(d.note, d.gold)); }
  const ag = aggregate(rows); s.problems = ag.ours.problems; s.coverage = ag.gold_problem_coverage;
}
const d = (f) => results.map((r) => r.B[f] - r.A[f]);
const aud = d('audit'), p50 = results.map((r) => r.B.p50 / r.A.p50), prob = d('problems'), cov = d('coverage'), hal = d('hallucination');
const neg = (x) => x.filter((v) => v < 0).length, pos = (x) => x.filter((v) => v > 0).length;
const verdictAudit = mean(aud) <= -1.5 && neg(aud) >= 2 ? 'WORSE' : mean(aud) >= 1.5 && pos(aud) >= 2 ? 'BETTER' : 'no measurable difference (noise)';
const verdictTime = mean(p50) > 1.15 && p50.filter((x) => x > 1.15).length >= 2 ? 'SLOWER' : mean(p50) < 0.87 && p50.filter((x) => x < 0.87).length >= 2 ? 'FASTER' : 'no measurable difference (noise)';
console.log(`\nPAIRED A/B  (A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)}; ${ids.length} transcripts x ${pairs} pairs)`);
console.log('pair  audit A  audit B  diff   | p50 A  p50 B  ratio | problems A/B | coverage A/B | unsafe A/B | invention-pattern A/B');
for (const r of results) console.log(`${String(r.pair).padEnd(5)} ${String(r.A.audit).padStart(7)} ${String(r.B.audit).padStart(8)} ${(r.B.audit - r.A.audit).toFixed(1).padStart(6)} | ${String(r.A.p50).padStart(5)} ${String(r.B.p50).padStart(6)} ${(r.B.p50 / r.A.p50).toFixed(2).padStart(6)} | ${r.A.problems}/${r.B.problems} | ${r.A.coverage}/${r.B.coverage} | ${r.A.unsafe}/${r.B.unsafe} | ${r.A.hallucination}/${r.B.hallucination}`);
console.log(`mean  ${mean(results.map((r) => r.A.audit)).toFixed(1).padStart(7)} ${mean(results.map((r) => r.B.audit)).toFixed(1).padStart(8)} ${mean(aud).toFixed(1).padStart(6)} | ${mean(results.map((r) => r.A.p50)).toFixed(1).padStart(5)} ${mean(results.map((r) => r.B.p50)).toFixed(1).padStart(6)} ${mean(p50).toFixed(2).padStart(6)} |`);
console.log(`\nAUDIT SCORE: ${verdictAudit}   TIME: ${verdictTime}   (problems per note diff ${mean(prob).toFixed(2)}, gold-issue coverage diff ${mean(cov).toFixed(2)}, invention-pattern diff ${mean(hal).toFixed(1)})`);
const out = { A, B, pairs: results, verdict: { audit: verdictAudit, time: verdictTime } }; if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
process.exit(verdictAudit === 'WORSE' || verdictTime === 'SLOWER' ? 1 : 0);
