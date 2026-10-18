#!/usr/bin/env node
// Pushes parity/audit results from docs/reports/iterations/*.json onto the lab runs so Trends can chart them.
import fs from 'node:fs'; import path from 'node:path';
const KEY = fs.readFileSync('secrets/lab-key.txt', 'utf8').trim(); const BASE = 'https://api.aitoolsfordoctor.com/lab'; const DIR = 'docs/reports/iterations';
const put = (id, q) => fetch(`${BASE}/runs/${id}/quality`, { method: 'PUT', headers: { 'X-Lab-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(q) }).then((r) => r.ok);
const byRun = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) { let j; try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; } if (!j.runId) continue; const q = (byRun[j.runId] ||= {});
  if (f.endsWith('.parity.json')) { q.parity_mean = j.mean; q.parity_at90 = j.at90; q.parity_n = j.n; }
  if (typeof j.mean_audit === 'number') { q.audit_mean = j.mean_audit; q.critical_per_note = j.critical_per_note ?? (j.critical_wrong != null ? +(j.critical_wrong / Math.max(1, j.notes)).toFixed(3) : undefined); q.unsafe = j.unsafe; }
  if (typeof j.goldref_mean === 'number') q.goldref_mean = j.goldref_mean; }
let n = 0; for (const [id, q] of Object.entries(byRun)) { for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k]; if (Object.keys(q).length && await put(id, q)) n++; }
console.log('runs updated:', n);
