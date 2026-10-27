// The paper's hallucination taxonomy applied to OUR judged "wrong" claims (fabrication / negation / causality / contextual, + where in the note, + major or minor).
import fs from 'node:fs';
import { createGeminiService } from '/app/packages/backend/src/services/LLMService.js';
const labels = process.argv.slice(2); const claims = [];
for (const l of labels) for (const x of JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${l}-j3.json`, 'utf8'))) for (const w of (x.judges?.pro?.wrong || [])) claims.push({ run: l, file: x.file, claim: w.claim, why: w.why || '', severity: w.severity || 'minor' });
// one pass per unique claim text
const uniq = [...new Map(claims.map((c) => [c.claim.toLowerCase().slice(0, 120), c])).values()];
const SYS = `You classify errors in AI-written clinical notes using this taxonomy (Asgari et al. 2025).
type: "fabrication" (information not evidenced in the consultation), "negation" (a clinically relevant fact is negated, or a negation is dropped or reversed), "causality" (a cause is speculated without support), "contextual" (topics that do not belong together are mixed, or a fact is attached to the wrong problem, person or time), "detail" (the fact exists but a number, dose, drug, side or date is wrong).
section: where the line sits in the note: "subjective", "objective", "assessment", "plan" (medicines, investigations, referrals, advice, follow-up all count as plan).
Return ONLY JSON: {"items":[{"i":0,"type":"...","section":"..."}]}`;
const out = [];
for (let k = 0; k < uniq.length; k += 40) {
  const batch = uniq.slice(k, k + 40); const llm = await createGeminiService(null, { model: 'gemini-2.5-flash' }); llm._agent = 'gold-judge';
  const raw = await llm.generateContent(SYS, batch.map((c, i) => `${i}. CLAIM: ${c.claim} | WHY WRONG: ${c.why.slice(0, 160)}`).join('\n') + '\n\nReturn ONLY the JSON.', null, { maxOutputTokens: 4000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 90000, retries: 1, thinkingBudget: 0, hedgeMs: 0 });
  const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); for (const it of j.items || []) if (batch[it.i]) out.push({ ...batch[it.i], type: it.type, section: it.section });
}
const by = (f) => { const m = {}; for (const o of out) m[f(o)] = (m[f(o)] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${((v / out.length) * 100).toFixed(0)}%)`).join(', '); };
console.log(`classified ${out.length} distinct wrong claims from ${labels.join(', ')}`);
console.log('by type:    ' + by((o) => o.type)); console.log('by section: ' + by((o) => o.section)); console.log('by severity (judge): ' + by((o) => o.severity));
const major = out.filter((o) => o.severity === 'critical' || o.severity === 'major'); const bm = {}; for (const o of major) bm[o.section] = (bm[o.section] || 0) + 1;
console.log(`critical+major only (${major.length}): by section ${JSON.stringify(bm)}; by type ${JSON.stringify(Object.fromEntries(Object.entries(major.reduce((m, o) => ((m[o.type] = (m[o.type] || 0) + 1), m), {}))))}`);
fs.writeFileSync('/lab-data/taxonomy.json', JSON.stringify(out)); process.exit(0);
