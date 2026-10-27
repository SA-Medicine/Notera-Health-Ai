// Score several finished gold runs TOGETHER, notes shuffled across runs, so that no run is judged at a different time of day than another (the control was always judged first
// when runs were scored one after the other: a possible bias). Writes <label>-j3.json (pro judge, 3 passes, consensus) and <label>.recall.json (fixed-fact recall) for every label.
//   node score-multi.mjs <label>...
import fs from 'node:fs';
import { createGeminiService } from '/app/packages/backend/src/services/LLMService.js';
const labels = process.argv.slice(2); const N = 3;
const src = fs.readFileSync('/app/packages/backend/tools/gold-eval.mjs', 'utf8'); const i = src.indexOf('export const JUDGE_SYS = `'); const a = src.indexOf('`', i); let j = a + 1; while (src[j] !== '`') { if (src[j] === '\\') j++; j++; }
const JUDGE_SYS = new Function('return `' + src.slice(a + 1, j) + '`')();
const FACTS = JSON.parse(fs.readFileSync(process.env.FACTS_FILE || '/lab-data/gold-facts.json', 'utf8'));
const RSYS = `You check whether a clinic NOTE states each numbered FACT. A fact is "present" if the note says it, in any words and in any section (same meaning, same numbers, same drug and dose, same negation); "partial" if the note says only part of it (for example the drug but not the dose, or the test but not the result); "absent" if it is not in the note. Be strict about numbers, doses, negations and sides.
Return ONLY JSON: {"r":{"F001":"present|partial|absent", ...}} with an entry for every fact.`;
const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 6);
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).map(stem));
const sim = (x, y) => { const A = words(x), B = words(y); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
const runs = Object.fromEntries(labels.map((l) => [l, JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${l}.json`, 'utf8'))]));
const tasks = []; for (const l of labels) for (const x of runs[l]) if (x.note && x.judges) tasks.push({ l, x });
for (let k = tasks.length - 1; k > 0; k--) { const r = Math.floor(Math.random() * (k + 1)); [tasks[k], tasks[r]] = [tasks[r], tasks[k]]; }
const txOf = (file) => { const t = fs.readFileSync('/app/data/gold/' + file, 'utf8'); const i2 = t.search(/\n\s*\**Subjective:?\**/i); return { tx: t.slice(0, i2).replace(/^\s*\d+:\d+\s*$/gm, ' ').trim(), ref: t.slice(i2).trim() }; };
async function pass(tx, ref, cand) {
  const llm = await createGeminiService(null, { model: 'gemini-2.5-pro' }); llm._agent = 'gold-judge';
  const raw = await llm.generateContent(JUDGE_SYS, `TRANSCRIPT:\n"""\n${tx.slice(0, 60000)}\n"""\n\nREFERENCE (the doctor's note):\n${ref}\n\nCANDIDATE:\n${cand}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 6000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 1024, hedgeMs: 0 });
  const o = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return { score: Number(o.score) || 0, missing: o.missing || [], wrong: o.wrong || [] };
}
async function recall(note, facts) {
  const llm = await createGeminiService(null, { model: 'gemini-2.5-pro' }); llm._agent = 'gold-judge';
  const raw = await llm.generateContent(RSYS, `NOTE:\n${note}\n\nFACTS:\n${facts.map((f) => `${f.id} [${f.importance}] ${f.text}${f.quote ? ' (said: "' + f.quote + '")' : ''}`).join('\n')}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 4000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 512, hedgeMs: 0 });
  return JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()).r || {};
}
function consensus(passes, key, textOf, need) {
  const groups = [];
  for (const [pi, p] of passes.entries()) for (const it of p[key]) { const g = groups.find((g) => sim(g.text, textOf(it)) >= 0.5); if (g) { g.passes.add(pi); g.items.push(it); } else groups.push({ text: textOf(it), passes: new Set([pi]), items: [it] }); }
  return groups.filter((g) => g.passes.size >= need).map((g) => g.items[0]);
}
const outJ = Object.fromEntries(labels.map((l) => [l, []])); const outR = Object.fromEntries(labels.map((l) => [l, []])); let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < tasks.length) {
    const { l, x } = tasks[next++]; const { tx, ref } = txOf(x.file);
    const ps = (await Promise.all(Array.from({ length: N }, () => pass(tx, ref, x.note).catch(() => null)))).filter(Boolean); const need = Math.ceil(ps.length / 2);
    outJ[l].push(ps.length ? { ...x, judges: { pro: { score: +(ps.reduce((s, p) => s + p.score, 0) / ps.length).toFixed(1), missing: consensus(ps, 'missing', (m) => m.fact, need), wrong: consensus(ps, 'wrong', (w) => w.claim, need), passes: ps.length }, flash: x.judges.flash } } : x);
    if (FACTS[x.file]) { try { const v = await recall(x.note, FACTS[x.file]); for (const f of FACTS[x.file]) outR[l].push({ file: x.file, id: f.id, imp: f.importance, type: f.type, text: f.text, v: v[f.id] || 'absent' }); } catch { /* skipped */ } }
    process.stderr.write(`\r${next}/${tasks.length}`);
  }
}));
for (const l of labels) {
  fs.writeFileSync(`/lab-data/gold-eval/${l}-j3.json`, JSON.stringify(outJ[l])); fs.writeFileSync(`/lab-data/gold-eval/${l}.recall.json`, JSON.stringify(outR[l]));
  const rows = outR[l]; const notes = new Set(rows.map((r) => r.file)).size || 1; const rate = (sel) => { const r = rows.filter(sel); return r.length ? (r.filter((x) => x.v === 'present').length / r.length) * 100 : NaN; };
  console.log(`${l.padEnd(16)} recall: all ${rate(() => true).toFixed(1)}%  critical ${rate((x) => x.imp === 'critical').toFixed(1)}%  major ${rate((x) => x.imp === 'major').toFixed(1)}% | absent per note: critical ${(rows.filter((x) => x.imp === 'critical' && x.v === 'absent').length / notes).toFixed(2)}, major ${(rows.filter((x) => x.imp === 'major' && x.v === 'absent').length / notes).toFixed(2)}`);
}
process.exit(0);
