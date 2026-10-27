// How noisy is the JUDGE alone? Re-judge the SAME notes (from one finished run) several times with the same judge prompt and compare.
import fs from 'node:fs';
import path from 'node:path';
import { createGeminiService } from '/app/packages/backend/src/services/LLMService.js';
const label = process.argv[2]; const times = Number(process.argv[3] || 3); const model = process.argv[4] || 'gemini-2.5-pro';
const src = fs.readFileSync('/app/packages/backend/tools/gold-eval.mjs', 'utf8'); const i = src.indexOf('export const JUDGE_SYS = `'); const a = src.indexOf('`', i); let j = a + 1; while (src[j] !== '`') { if (src[j] === '\\') j++; j++; }
const JUDGE_SYS = new Function('return `' + src.slice(a + 1, j) + '`')();
const set = JSON.parse(fs.readFileSync('/app/eval/gold-set.json', 'utf8')).pairs;
const run = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${label}.json`, 'utf8')).filter((x) => x.note);
const ISO = /\b(19|20)\d{2}-\d{2}-\d{2}\b/;
const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 6);
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).map(stem));
const sim = (x, y) => { const A = words(x), B = words(y); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
async function judge(tx, ref, cand) {
  const llm = await createGeminiService(null, { model }); llm._agent = 'gold-judge';
  const raw = await llm.generateContent(JUDGE_SYS, `TRANSCRIPT:\n"""\n${tx.slice(0, 60000)}\n"""\n\nREFERENCE (the doctor's note):\n${ref}\n\nCANDIDATE:\n${cand}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 6000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 1024, hedgeMs: 0 });
  const o = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return { score: Number(o.score) || 0, crit: (o.missing || []).filter((m) => m.importance === 'critical' && !ISO.test(m.fact)).map((m) => m.fact), wrong: (o.wrong || []).length };
}
const out = []; let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < run.length) {
    const x = run[next++]; const t = fs.readFileSync('/app/data/gold/' + x.file, 'utf8'); const k = t.search(/\n\s*\**Subjective:?\**/i); const tx = t.slice(0, k).replace(/^\s*\d+:\d+\s*$/gm, ' ').trim(); const ref = t.slice(k).trim();
    const rs = []; for (let n = 0; n < times; n++) { try { rs.push(await judge(tx, ref, x.note)); } catch { /* skip */ } }
    out.push({ file: x.file, rs });
  }
}));
let same = 0, total = 0, sc = [], cnt = [];
for (const o of out) {
  if (o.rs.length < 2) continue; sc.push(Math.max(...o.rs.map((r) => r.score)) - Math.min(...o.rs.map((r) => r.score))); cnt.push(o.rs.map((r) => r.crit.length));
  const first = o.rs[0].crit; for (const f of first) { total++; if (o.rs.slice(1).every((r) => r.crit.some((c) => sim(c, f) >= 0.5))) same++; }
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
console.log(`judge ${model}, ${times} passes over the SAME ${out.length} notes of ${label}:`);
console.log(`  score spread per note (max-min across passes): mean ${mean(sc).toFixed(1)} points`);
console.log(`  critical count per note across passes: mean per pass ${[0, 1, 2].map((i) => mean(cnt.map((c) => c[i] ?? 0)).toFixed(2)).join(' / ')}; notes where the count differs between passes: ${cnt.filter((c) => new Set(c).size > 1).length}/${cnt.length}`);
console.log(`  a critical fact listed in pass 1 is listed again in EVERY other pass: ${same}/${total} (${((same / Math.max(1, total)) * 100).toFixed(0)}%)`);
process.exit(0);
