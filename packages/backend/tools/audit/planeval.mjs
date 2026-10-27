// Offline: run the plan action check over finished gold notes; compare its flags with the judge's consensus "wrong" plan claims.
import fs from 'node:fs';
import { createGeminiService } from '/app/packages/backend/src/services/LLMService.js';
import { planActionCheck, planItems } from '/app/packages/backend/src/orchestrator/planActionCheck.js';
const label = process.argv[2]; const show = Number(process.argv[3] || 30);
const run = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${label}-j3.json`, 'utf8')).filter((x) => x.note);
const txOf = (file) => { const t = fs.readFileSync('/app/data/gold/' + file, 'utf8'); const i = t.search(/\n\s*\**Subjective:?\**/i); return t.slice(0, i).replace(/^\s*\d+:\d+\s*$/gm, ' ').trim(); };
const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 6);
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3).map(stem));
const sim = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
let items = 0, flags = 0, matched = 0, wrongPlan = 0, caught = 0, ms = 0; const rows = []; let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < run.length) {
    const x = run[next++]; const llm = await createGeminiService(null, { model: 'gemini-2.5-flash' }); llm._agent = 'v2-ground';
    const r = await planActionCheck(llm, x.note, txOf(x.file)); items += r.checked; flags += r.flags.length; ms += r.ms;
    const wr = (x.judges?.pro?.wrong || []).filter((w) => /^(critical|major)$/.test(w.severity || '') || true);
    for (const f of r.flags) { const hit = wr.find((w) => sim(f.message, w.claim) >= 0.5); if (hit) matched++; rows.push({ file: x.file, kind: f.kind, msg: f.message, hit: !!hit }); }
    const planWrong = wr.filter((w) => planItems(x.note).some((p) => sim(p.text, w.claim) >= 0.5)); wrongPlan += planWrong.length; caught += planWrong.filter((w) => r.flags.some((f) => sim(f.message, w.claim) >= 0.5)).length;
  }
}));
console.log(`${label}: ${run.length} notes, plan items checked ${items} (${(items / run.length).toFixed(1)}/note), flags ${flags} = ${(flags / run.length).toFixed(2)}/note, mean ${(ms / run.length / 1000).toFixed(1)} s per note`);
console.log(`flags that match a judge "wrong" claim: ${matched}/${flags} (${flags ? ((matched / flags) * 100).toFixed(0) : 0}%) | judge wrong claims on plan items: ${wrongPlan}, of which flagged: ${caught} (${wrongPlan ? ((caught / wrongPlan) * 100).toFixed(0) : 0}%)`);
console.log('by kind (flags, judge agrees): ' + ['option', 'wrong_detail', 'not_said'].map((k) => `${k} ${rows.filter((r) => r.kind === k).length}/${rows.filter((r) => r.kind === k && r.hit).length}`).join(', '));
for (const r of rows.filter((r) => r.kind !== "not_said").slice(0, show)) console.log(`  ${r.hit ? '[judge agrees]' : '[judge silent] '} ${r.file.slice(0, 16).padEnd(17)} ${r.msg.slice(0, 200)}`);
process.exit(0);
