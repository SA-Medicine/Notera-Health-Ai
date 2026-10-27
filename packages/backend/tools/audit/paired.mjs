// Paired comparison of an arm against the average of its same-time control runs, per note: difference (arm - control) with a standard error. |t| > 2 = a real difference.
import fs from 'node:fs';
const [ctrlList, arm] = [process.argv[2].split(','), process.argv[3]];
const ISO = /\b(19|20)\d{2}-\d{2}-\d{2}\b/;
const load = (l) => Object.fromEntries(JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${l}.json`, 'utf8')).filter((x) => x.judges && !x.judges.pro.error).map((x) => [x.file, x]));
const C = ctrlList.map(load); const A = load(arm);
const crit = (x) => (x.judges.pro.missing || []).filter((m) => m.importance === 'critical' && !ISO.test(m.fact)).length;
const metrics = { 'pro score': (x) => x.judges.pro.score, 'critical (pro, no date artifacts)': crit, 'wrong lines (pro)': (x) => (x.judges.pro.wrong || []).length, 'critical wrong (pro)': (x) => (x.judges.pro.wrong || []).filter((w) => w.severity === 'critical').length, 'seconds': (x) => x.seconds, 'required facts found before ledger %': (x) => (x.ledger?.required ? (1 - (x.ledger.missingBefore || 0) / x.ledger.required) * 100 : NaN) };
const files = Object.keys(A).filter((f) => C.every((c) => c[f]));
console.log(`${arm} vs mean of ${ctrlList.join(' + ')} over ${files.length} notes`);
for (const [name, fn] of Object.entries(metrics)) {
  const d = files.map((f) => fn(A[f]) - C.reduce((s, c) => s + fn(c[f]), 0) / C.length).filter(Number.isFinite); if (!d.length) continue;
  const m = d.reduce((s, x) => s + x, 0) / d.length; const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1)); const se = sd / Math.sqrt(d.length);
  const cm = files.reduce((s, f) => s + C.reduce((t, c) => t + fn(c[f]), 0) / C.length, 0) / files.length;
  console.log(`  ${name.padEnd(40)} control ${cm.toFixed(2).padStart(7)}   arm - control ${(m >= 0 ? '+' : '') + m.toFixed(2)}   ±${se.toFixed(2)}   t=${(m / (se || 1)).toFixed(1)} ${Math.abs(m / (se || 1)) > 2 ? ' <== real' : ''}`);
}
