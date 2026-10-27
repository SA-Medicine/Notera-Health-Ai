// Paired per-note difference in oracle omissions: node pairedoracle.mjs <ctrl1,ctrl2,...> <arm> [more arms...]   (runs scored by extractaudit.mjs)
// Counts facts the note lacks (note === "no"), all and critical+major, per note; the control is the mean of the controls given. Prints mean difference +- standard error and t.
import fs from 'node:fs';
const load = (l) => JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${l}.oracle.json`, 'utf8'));
const per = (rows, sel) => { const m = {}; for (const r of rows) { m[r.file] ||= 0; if (r.note === 'no' && sel(r)) m[r.file]++; } return m; };
const ctrls = process.argv[2].split(',').map(load);
const sels = { 'all': () => true, 'critical+major': (r) => r.imp !== 'minor', 'critical': (r) => r.imp === 'critical', 'plan': (r) => r.section === 'plan' };
for (const arm of process.argv.slice(3)) {
  const a = load(arm);
  for (const [name, sel] of Object.entries(sels)) {
    const c = ctrls.map((r) => per(r, sel)); const x = per(a, sel);
    const d = Object.keys(x).map((f) => x[f] - c.reduce((s, m) => s + (m[f] || 0), 0) / c.length);
    const n = d.length; const mean = d.reduce((s, v) => s + v, 0) / n; const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)); const se = sd / Math.sqrt(n);
    console.log(`${arm.padEnd(10)} ${name.padEnd(15)} missing per note: arm - control = ${mean >= 0 ? '+' : ''}${mean.toFixed(2)} +- ${se.toFixed(2)}  (t ${(mean / se).toFixed(1)}, ${n} notes; control ${(c.reduce((s, m) => s + Object.values(m).reduce((u, v) => u + v, 0), 0) / c.length / n).toFixed(2)}/note)`);
  }
}
