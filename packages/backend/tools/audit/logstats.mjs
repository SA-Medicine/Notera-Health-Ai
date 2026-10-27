import fs from 'node:fs';
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
for (const l of process.argv.slice(2)) {
  const log = fs.readFileSync(`/lab-data/gold-eval-${l}.log`, 'utf8');
  const g = [...log.matchAll(/v2:ground\] (\d+) lines: (\d+) supported by the fact graph, (\d+) checked · removed (\d+)/g)].map((m) => m.slice(1).map(Number));
  const dose = [...log.matchAll(/v2:dose\] [^\n]*/g)].map((m) => m[0]);
  const removed = [...log.matchAll(/v2:ground\] checked \d+ lines · doubted \d+ · kept after second look \d+ · removed (\d+)/g)].map((m) => +m[1]);
  const delta = [...log.matchAll(/v2:ground-delta\] checked (\d+) late line\(s\) · removed (\d+) · flagged (\d+)/g)].map((m) => m.slice(1).map(Number));
  console.log(`${l.padEnd(11)} graph-aware ground: ${g.length} notes, lines ${mean(g.map((x) => x[0])).toFixed(1)}, supported by graph ${mean(g.map((x) => x[1])).toFixed(1)}, sent to the model ${mean(g.map((x) => x[2])).toFixed(1)}, removed ${mean(g.map((x) => x[3])).toFixed(2)}/note | plain ground removed ${mean(removed).toFixed(2)}/note (${removed.length} notes) | late-line check: ${delta.length} notes with changes, removed ${delta.reduce((s, x) => s + x[1], 0)}, flagged ${delta.reduce((s, x) => s + x[2], 0)} | dose repairs ${dose.length}${dose.length ? ': ' + dose.slice(0, 3).join(' || ') : ''}`);
}
