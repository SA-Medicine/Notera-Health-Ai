// Case-level reading of the "critical miss" metric over runs of the SAME current configuration.
import fs from 'node:fs';
const runs = process.argv.slice(2);
const load = (l) => Object.fromEntries(JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${l}.json`, 'utf8')).filter((x) => x.judges).map((x) => [x.file, x]));
const R = runs.map((l) => [l, load(l)]);
const ISO = /\b(19|20)\d{2}-\d{2}-\d{2}\b/;
const VAGUE = /\b(specific|not specified|unspecified|not documented|not mentioned|exact (date|number|timeframe))\b/i;
const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 6);
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).map(stem));
const sim = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
let total = 0, artifact = 0, vague = 0; const perJudge = { pro: 0, flash: 0 }; let both = 0, onlyOne = 0;
const byNote = {};
for (const [l, rs] of R) for (const [f, x] of Object.entries(rs)) {
  const c = {}; for (const j of ['pro', 'flash']) c[j] = (x.judges[j].missing || []).filter((m) => m.importance === 'critical').map((m) => m.fact);
  perJudge.pro += c.pro.length; perJudge.flash += c.flash.length;
  for (const a of c.pro) { if (c.flash.some((b) => sim(a, b) >= 0.5)) both++; else onlyOne++; }
  for (const b of c.flash) if (!c.pro.some((a) => sim(a, b) >= 0.5)) onlyOne++;
  for (const fact of [...c.pro, ...c.flash]) { total++; if (ISO.test(fact)) artifact++; else if (VAGUE.test(fact)) vague++; (byNote[f] ||= []).push({ run: l, fact }); }
}
console.log(`runs ${runs.join(', ')} — notes ${Object.keys(R[0][1]).length}`);
console.log(`critical facts listed (both judges, all runs): ${total}  | with a synthetic date (de-identification artifact): ${artifact} (${((artifact / total) * 100).toFixed(0)}%)  | vague "specific/not specified": ${vague} (${((vague / total) * 100).toFixed(0)}%)`);
console.log(`judge agreement: pro ${perJudge.pro}, flash ${perJudge.flash}; flagged by both ${both}, by one only ${onlyOne}`);
// recurring: same fact (sim>=0.5) in >= 2 different runs
const rec = [];
for (const [f, items] of Object.entries(byNote)) {
  const groups = [];
  for (const it of items) { const g = groups.find((g) => sim(g.fact, it.fact) >= 0.5); if (g) g.runs.add(it.run); else groups.push({ fact: it.fact, runs: new Set([it.run]) }); }
  for (const g of groups) if (g.runs.size >= Number(process.env.THRESH||2) && !ISO.test(g.fact)) rec.push({ file: f, fact: g.fact, n: g.runs.size });
}
rec.sort((a, b) => b.n - a.n);
console.log(`\nRECURRING non-artifact critical misses (same fact in >=2 of ${runs.length} runs): ${rec.length}`);
for (const r of rec) console.log(`  [${r.n}/${runs.length}] ${r.file.replace('.txt', '')}: ${r.fact.slice(0, 200)}`);
const notesWithAny = new Set(Object.keys(byNote)).size; const notesRecurring = new Set(rec.map((r) => r.file)).size;
console.log(`\nnotes with any critical listed in any run: ${notesWithAny}; notes with a recurring one: ${notesRecurring}`);
fs.writeFileSync(process.env.OUT||'/tmp/recurring.json', JSON.stringify(rec));
