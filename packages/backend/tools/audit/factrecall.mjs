// Fixed-fact omission measure (the paper's "omitted transcript sentences", on the transcript's own facts instead of the doctor's note).
//   build : node factrecall.mjs build            -> reads the 30 gold transcripts, extracts the fact graph ONCE, keeps the required facts (/lab-data/gold-facts.json)
//   score : node factrecall.mjs score <run>...   -> for each run, one model call per note: which of those facts does the note state? prints recall by importance
import fs from 'node:fs';
import { buildFactGraph } from '/app/packages/backend/src/orchestrator/factGraph.js';
import { requiredFacts } from '/app/packages/backend/src/orchestrator/factLedger.js';
import { createGeminiService } from '/app/packages/backend/src/services/LLMService.js';
const mode = process.argv[2]; const FACTS = process.env.FACTS_FILE || '/lab-data/gold-facts.json';
const set = JSON.parse(fs.readFileSync('/app/eval/' + (process.env.GOLD_SET || 'gold-set.json'), 'utf8')).pairs;
const txOf = (file) => { const t = fs.readFileSync('/app/data/gold/' + file, 'utf8'); const i = t.search(/\n\s*\**Subjective:?\**/i); return t.slice(0, i).replace(/^\s*\d+:\d+\s*$/gm, ' ').trim(); };
if (mode === 'build') {
  const out = {}; let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => { while (next < set.length) { const p = set[next++]; const g = await buildFactGraph(txOf(p.file), { log: () => {} }); out[p.file] = requiredFacts(g.facts).map((f) => ({ id: f.id, type: f.type, text: f.text, importance: f.importance, quote: String(f.quote || '').slice(0, 200), medication: f.medication || '' })); process.stderr.write(`\r${Object.keys(out).length}/${set.length}`); } }));
  fs.writeFileSync(FACTS, JSON.stringify(out)); const all = Object.values(out).flat();
  console.log(`\nfacts kept: ${all.length} (${(all.length / set.length).toFixed(1)} per note); by importance: ${['critical', 'major', 'minor'].map((i) => `${i} ${all.filter((f) => f.importance === i).length}`).join(', ')}`); process.exit(0);
}
const SYS = `You check whether a clinic NOTE states each numbered FACT. A fact is "present" if the note says it, in any words and in any section (same meaning, same numbers, same drug and dose, same negation); "partial" if the note says only part of it (for example the drug but not the dose, or the test but not the result); "absent" if it is not in the note. Be strict about numbers, doses, negations and sides.
Return ONLY JSON: {"r":{"F001":"present|partial|absent", ...}} with an entry for every fact.`;
const facts = JSON.parse(fs.readFileSync(FACTS, 'utf8'));
const verdictOf = async (note, fs_) => {
  const llm = await createGeminiService(null, { model: 'gemini-2.5-pro' }); llm._agent = 'gold-judge';
  const raw = await llm.generateContent(SYS, `NOTE:\n${note}\n\nFACTS:\n${fs_.map((f) => `${f.id} [${f.importance}] ${f.text}${f.quote ? ' (said: "' + f.quote + '")' : ''}`).join('\n')}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 4000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 512, hedgeMs: 0 });
  return JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()).r || {};
};
for (const label of process.argv.slice(3)) {
  const run = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${label}.json`, 'utf8')).filter((x) => x.note && facts[x.file]);
  const rows = []; let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < run.length) { const x = run[next++]; try { const v = await verdictOf(x.note, facts[x.file]); for (const f of facts[x.file]) rows.push({ file: x.file, id: f.id, imp: f.importance, type: f.type, text: f.text, v: v[f.id] || 'absent' }); } catch { /* note skipped */ } } }));
  fs.writeFileSync(`/lab-data/gold-eval/${label}.recall.json`, JSON.stringify(rows));
  const rate = (sel, w) => { const r = rows.filter(sel); return r.length ? r.reduce((s, x) => s + (x.v === 'present' ? 1 : x.v === 'partial' ? w : 0), 0) / r.length * 100 : NaN; };
  const per = (sel) => { const files = [...new Set(rows.map((r) => r.file))]; return files.length ? rows.filter(sel).length / files.length : 0; };
  console.log(`${label.padEnd(18)} facts ${rows.length}  recall(present only): all ${rate(() => true, 0).toFixed(1)}%  critical ${rate((x) => x.imp === 'critical', 0).toFixed(1)}%  major ${rate((x) => x.imp === 'major', 0).toFixed(1)}% | absent per note: critical ${(rows.filter((x) => x.imp === 'critical' && x.v === 'absent').length / new Set(rows.map((r) => r.file)).size).toFixed(2)}, major ${(rows.filter((x) => x.imp === 'major' && x.v === 'absent').length / new Set(rows.map((r) => r.file)).size).toFixed(2)}, partial ${(rows.filter((x) => x.v === 'partial').length / new Set(rows.map((r) => r.file)).size).toFixed(2)}`);
}
process.exit(0);
