// Offline check of the negation guard on finished gold notes: how many flags per note, and do they line up with what the judge called wrong?
import fs from 'node:fs';
import { negationGuard } from '/app/packages/backend/src/orchestrator/negationGuard.js';
const label = process.argv[2]; const showN = Number(process.argv[3] || 25);
const run = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${label}.json`, 'utf8')).filter((x) => x.note);
const jr = (() => { try { return Object.fromEntries(JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${label}-j3.json`, 'utf8')).map((x) => [x.file, x])); } catch { return {}; } })();
const txOf = (file) => { const t = fs.readFileSync('/app/data/gold/' + file, 'utf8'); const i = t.search(/\n\s*\**Subjective:?\**/i); return t.slice(0, i).replace(/^\s*\d+:\d+\s*$/gm, ' ').trim(); };
let flags = 0, checked = 0, negated = 0; const all = []; const NEGW = /\b(no|not|never|without|denies|denied|declin|refus|stopp|discontinu|no longer|negat|revers)/i;
let judgeNeg = 0, caught = 0;
for (const x of run) {
  const r = negationGuard(x.note, txOf(x.file)); flags += r.flags.length; checked += r.checked; negated += r.negated; for (const f of r.flags) all.push({ file: x.file, ...f });
  for (const w of (jr[x.file]?.judges?.pro?.wrong || [])) { const c = `${w.claim} ${w.why || ''}`; if (NEGW.test(c)) { judgeNeg++; const words = new Set(c.toLowerCase().split(/\W+/).filter((t) => t.length > 4)); if (r.flags.some((f) => [...words].filter((t) => f.message.toLowerCase().includes(t)).length >= 2)) caught++; } }
}
console.log(`${label}: notes ${run.length}, lines checked ${checked} (negated ${negated}), flags ${flags} = ${(flags / run.length).toFixed(2)} per note`);
console.log(`judge "wrong" claims that mention a negation: ${judgeNeg}; of those the guard flagged a matching line: ${caught}`);
console.log(`by kind: ${['unsupported_negation', 'reversed_negation'].map((k) => `${k} ${all.filter((f) => f.kind === k).length}`).join(', ')}`);
for (const f of all.slice(0, showN)) console.log(`  ${f.file.slice(0, 18).padEnd(19)} [${f.section.slice(0, 12)}] ${f.message}`);
process.exit(0);
