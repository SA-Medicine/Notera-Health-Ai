import fs from 'node:fs';
const l = process.argv[2];
try {
  const r = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${l}.json`, 'utf8'));
  console.log(`${l}: notes ${r.length}, errors ${r.filter((x) => x.error).length}, coverage ran early in ${r.filter((x) => x.coverageEarly).length}/${r.length}, mean ${(r.reduce((s, x) => s + (x.seconds || 0), 0) / r.length).toFixed(1)} s, max ${Math.max(...r.map((x) => x.seconds || 0))} s, calls/note ${(r.reduce((s, x) => s + (x.usage?.calls || 0), 0) / r.length).toFixed(1)}, ledger missing after ${(r.reduce((s, x) => s + (x.ledger?.stillMissing || 0), 0) / r.length).toFixed(2)}/note`);
} catch { console.log(l, 'not finished:', fs.readFileSync(`/lab-data/gold-eval-${l}.log`, 'utf8').split('v2 run total').length - 1, 'notes done'); }
