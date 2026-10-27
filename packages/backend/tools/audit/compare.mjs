// One table for gold-test runs: quality (both judges, with and without the de-identification date artifacts), speed, cost, judge-free recall.
import fs from 'node:fs';
const P = { 'gemini-3.7-flash': [0.75, 3.75], 'gemini-3.8-flash': [0.75, 3.75], 'gemini-3.6-flash': [0.75, 3.75], 'gemini-2.5-flash': [0.3, 2.5], 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-2.5-pro': [1.25, 10], 'gemini-3.1-pro-preview': [2, 12] };
const ISO = /\b(19|20)\d{2}-\d{2}-\d{2}\b/;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f1 = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '  - ');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const rows = [];
const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 6);
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).map(stem));
const sim = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
let S = []; try { S = JSON.parse(fs.readFileSync('/lab-data/recurring-S.json', 'utf8')); } catch { /* no fixed set yet */ }
for (const l of process.argv.slice(2)) {
  let r; try { r = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${l}.json`, 'utf8')); } catch { console.log(l, 'not finished'); continue; }
  const ok = r.filter((x) => x.judges && !x.judges.pro.error && !x.judges.flash.error);
  const crit = (x, j, art) => (x.judges[j].missing || []).filter((m) => m.importance === 'critical' && (art || !ISO.test(m.fact))).length;
  const wrong = (x, j, sev) => (x.judges[j].wrong || []).filter((w) => !sev || w.severity === 'critical').length;
  const secs = ok.map((x) => x.seconds);
  const usage = ok.map((x) => x.usage).filter(Boolean);
  const cost = usage.length ? mean(usage.map((u) => Object.entries(u.byModel || {}).reduce((s, [m, v]) => s + (((v.prompt * (P[m] || P['gemini-3.7-flash'])[0]) + ((v.output + v.thoughts) * (P[m] || P['gemini-3.7-flash'])[1])) / 1e6), 0))) : NaN;
  const led = r.filter((x) => x.ledger && x.ledger.required);
  rows.push({ l, n: ok.length, score: mean(ok.map((x) => (x.judges.pro.score + x.judges.flash.score) / 2)), proScore: mean(ok.map((x) => x.judges.pro.score)),
    cPro: mean(ok.map((x) => crit(x, 'pro', true))), cProX: mean(ok.map((x) => crit(x, 'pro', false))), cFl: mean(ok.map((x) => crit(x, 'flash', true))), cFlX: mean(ok.map((x) => crit(x, 'flash', false))),
    anyX: ok.filter((x) => crit(x, 'pro', false) > 0).length, wPro: mean(ok.map((x) => wrong(x, 'pro'))), wCrit: mean(ok.map((x) => wrong(x, 'pro', true))),
    t: mean(secs), p90: pct(secs, 0.9), over60: secs.filter((s) => s > 60).length, mx: Math.max(...secs),
    calls: usage.length ? mean(usage.map((u) => u.calls)) : NaN, tokIn: usage.length ? mean(usage.map((u) => u.prompt)) / 1000 : NaN, think: usage.length ? mean(usage.map((u) => u.thoughts)) / 1000 : NaN, cost,
    recall: led.length ? mean(led.map((x) => 1 - (x.ledger.missingBefore || 0) / x.ledger.required)) * 100 : NaN, still: led.length ? mean(led.map((x) => x.ledger.stillMissing || 0)) : NaN,
    gap: (() => { const g = r.map((x) => x.groundGap).filter(Boolean); return g.length ? mean(g.map((x) => x.unseen)) : NaN; })(),
    errs: r.filter((x) => x.error).length,
    sHit: S.length ? S.filter((s) => { const x = ok.find((y) => y.file === s.file); return x && ['pro', 'flash'].some((j) => (x.judges[j].missing || []).some((m) => m.importance === 'critical' && sim(m.fact, s.fact) >= 0.5)); }).length : NaN });
}
const H = ['run', 'n', 'score', 'proSc', 'critP', 'critP*', 'critF', 'critF*', 'notes*', 'wrongP', 'wrongCrit', 'time', 'p90', '>60', 'max', 'calls', 'inK', 'thinkK', '$/note', 'recall%', 'still', 'unseen', 'err', 'S-hit/'+S.length];
console.log(H.join('\t'));
for (const x of rows) console.log([x.l, x.n, f1(x.score), f1(x.proScore), f1(x.cPro, 2), f1(x.cProX, 2), f1(x.cFl, 2), f1(x.cFlX, 2), x.anyX, f1(x.wPro, 2), f1(x.wCrit, 2), f1(x.t), x.p90, x.over60, x.mx, f1(x.calls), f1(x.tokIn), f1(x.think), Number.isFinite(x.cost) ? x.cost.toFixed(4) : '-', f1(x.recall), f1(x.still, 2), f1(x.gap, 1), x.errs, Number.isFinite(x.sHit) ? x.sHit : '-'].join('\t'));
console.log('\n* = without the critical "misses" that are only a synthetic date from the de-identified gold transcripts. crit = per note; notes* = notes with a pro-judge critical miss (without artifacts).');
