import fs from 'node:fs';
for (const label of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${label}.json`, 'utf8')).filter((x) => x.timings);
  const keys = [...new Set(r.flatMap((x) => Object.keys(x.timings)))];
  const tot = (x) => x.timings.total || Object.values(x.timings).reduce((a, b) => a + b, 0);
  const slow = [...r].sort((a, b) => tot(b) - tot(a));
  console.log(`== ${label}: ${r.length} notes, total mean ${(r.reduce((a, x) => a + tot(x), 0) / r.length / 1000).toFixed(1)} s, over 60 s: ${r.filter((x) => tot(x) > 60000).length}`);
  console.log('stage            mean s   max s   (sum of stages > total: stages that overlap)');
  for (const k of keys) { const v = r.map((x) => x.timings[k] || 0); console.log(`${k.padEnd(18)} ${(v.reduce((a, b) => a + b, 0) / v.length / 1000).toFixed(1).padStart(5)}  ${(Math.max(...v) / 1000).toFixed(1).padStart(6)}`); }
  for (const x of slow.slice(0, 4)) console.log(`slow: ${x.file} ${(tot(x) / 1000).toFixed(0)} s | ` + Object.entries(x.timings).filter(([k, v]) => k !== 'total' && v > 2500).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(', '));
}
