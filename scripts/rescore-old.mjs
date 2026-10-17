#!/usr/bin/env node
// Re-scores OLD stored results (eval/results/<run>/*.md = generated note + gold) with TODAY's parity comparator, and prints the
// old cached score next to it. Answers: was the earlier "90+" the pipeline, or the judge?
//   node scripts/rescore-old.mjs run_2026-09-01_07-16-58 [run_...] [--max 30]
import fs from 'node:fs';
import path from 'node:path';

const KEY = fs.readFileSync(path.resolve('secrets/lab-key.txt'), 'utf8').trim(); const BASE = process.env.LAB_URL || 'https://api.aitoolsfordoctor.com/lab';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--')); const maxI = process.argv.indexOf('--max'); const MAX = maxI > -1 ? Number(process.argv[maxI + 1]) : 30;
const args2 = args.filter((a) => a !== String(MAX));
const parity = async (note, gold) => { const r = await fetch(BASE + '/parity', { method: 'POST', headers: { 'X-Lab-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ note, gold }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
for (const run of args2) {
  const dir = path.isAbsolute(run) || run.includes('/') ? run : path.join('eval/results', run); const items = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('_'))) {
    const cf = path.join(dir, f.replace(/\.md$/, '.compare.json')); const old = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, 'utf8')) : { overall_score: null };
    const secs = []; let cur = { title: '_head', body: [] };
    for (const ln of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { const m = ln.match(/──\s*(.+?)\s*──/); if (m) { secs.push(cur); cur = { title: m[1], body: [] }; } else cur.body.push(ln); }
    secs.push(cur); const find = (rx) => (secs.find((s) => rx.test(s.title))?.body.join('\n').trim() || '');
    const note = find(/generated/i), gold = find(/gold/i); if (note && gold) items.push({ f, note, gold, old: old.overall_score });
  }
  const pick = items.slice(0, MAX); const out = []; let i = 0;
  await Promise.all(Array.from({ length: 5 }, async () => { while (i < pick.length) { const it = pick[i++]; try { const p = await parity(it.note, it.gold); out.push({ f: it.f, old: it.old, now: p.overall_score }); } catch { /* skip */ } } }));
  const hasOld = out.every((x) => typeof x.old === 'number');
  console.log(`${run}: ${out.length} notes · ` + (hasOld ? `judge THEN mean ${mean(out.map((x) => x.old)).toFixed(1)} (${out.filter((x) => x.old >= 90).length} at 90+) → ` : '') + `judge NOW mean ${mean(out.map((x) => x.now)).toFixed(1)} (${out.filter((x) => x.now >= 90).length} at 90+)`);
  if (process.argv.includes('--list')) out.sort((a, b) => a.f.localeCompare(b.f)).forEach((x) => console.log('   ', x.f.padEnd(34), x.old ?? '-', x.now));
}
