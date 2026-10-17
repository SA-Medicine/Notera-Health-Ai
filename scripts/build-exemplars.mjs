#!/usr/bin/env node
// Builds packages/backend/exemplars/bank.json: clinician-written (transcript → note) pairs the writer can be shown as
// few-shot references. Only short-enough, clean pairs; evaluation notes are EXCLUDED so tests never see their own answer.
//   node scripts/build-exemplars.mjs [--n 300] [--max-chars 4500] [--exclude-file docs/reports/iterations/iter0-baseline.json]
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i === -1 ? d : process.argv[i + 1]; };
const N = Number(arg('n', 300)), MAX = Number(arg('max-chars', 4500));
const M = await import('../eval/metrics.mjs');
const exclude = new Set();
for (const f of String(arg('exclude-file', 'docs/reports/iterations/iter0-baseline.json')).split(',').filter(Boolean)) if (fs.existsSync(f)) Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).scores || {}).forEach((i) => exclude.add(i));
const cleanTx = (t) => t.replace(/^Transcript started.*$/m, '').replace(/^\s*\d+:\d{2}(?::\d{2})?\s*$/gm, '').replace(/\n{2,}/g, '\n').trim();
const pool = [];
for (const f of fs.readdirSync('data/gold').filter((x) => x.endsWith('.txt'))) {
  const id = f.replace(/\.txt$/, ''); if (exclude.has(id)) continue;
  const raw = fs.readFileSync(path.join('data/gold', f), 'utf8'); const i = raw.search(/^\s*Subjective\s*:/im); if (i < 0) continue;
  const tx = cleanTx(raw.slice(0, i)); const note = raw.slice(i).trim();
  if (tx.length < 400 || tx.length > MAX || note.length < 300 || note.length > 3500 || M.isGoldCorrupt(note)) continue;
  pool.push({ id, tx, note });
}
let seed = 20261017; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const bank = pool.slice(0, N);
fs.mkdirSync('packages/backend/exemplars', { recursive: true });
fs.writeFileSync('packages/backend/exemplars/bank.json', JSON.stringify(bank));
console.log(`bank: ${bank.length} pairs from ${pool.length} eligible (excluded ${exclude.size} evaluation notes), ${(fs.statSync('packages/backend/exemplars/bank.json').size / 1e6).toFixed(2)} MB`);
