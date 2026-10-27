// Is extraction the bottleneck? An INDEPENDENT list of the facts a complete note must hold (one strong model reading the whole transcript, not the pipeline's extractor),
// then for each such fact: is it in the fact graph, is it in the final note?
//   node extractaudit.mjs oracle              -> /lab-data/oracle<SUFFIX>.json (once per gold set)
//   node extractaudit.mjs score <run> [...]   -> graph/note coverage of the oracle facts for finished runs (writes <run>.oracle.json)
// Env: GOLD_SET (default gold-set.json), FACTS_FILE (graph facts), ORACLE_FILE.
import fs from 'node:fs';
import { createGeminiService } from '/app/packages/backend/src/services/LLMService.js';
const mode = process.argv[2];
const ORACLE = process.env.ORACLE_FILE || '/lab-data/oracle.json'; const FACTS = process.env.FACTS_FILE || '/lab-data/gold-facts.json';
const set = JSON.parse(fs.readFileSync('/app/eval/' + (process.env.GOLD_SET || 'gold-set.json'), 'utf8')).pairs;
const txOf = (file) => { const t = fs.readFileSync('/app/data/gold/' + file, 'utf8'); const i = t.search(/\n\s*\**Subjective:?\**/i); return t.slice(0, i).replace(/^\s*\d+:\d+\s*$/gm, ' ').trim(); };
const parse = (raw) => JSON.parse(String(raw).replace(/^```json|```$/g, '').trim());
const pool = async (items, n, fn) => { let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) await fn(items[k++]); })); };

const ORACLE_SYS = `You read a doctor-patient consultation recording and list EVERY fact a complete, safe clinic note must contain.
Include: the reasons for the visit and each problem's history, symptoms with duration and severity, relevant negatives the doctor asked about, examination findings and results, assessments, and ALL plan details: each medicine (name, dose, frequency, quantity, refills, pharmacy, started/stopped/changed/continued/only discussed), investigations ordered or reviewed (with timing), referrals, advice and warnings given, follow-up and recheck timing, and what the patient agreed to or declined.
Do not list small talk. Each fact is ONE short statement with the exact words from the recording as "quote" (copy word for word, at most 30 words).
importance: "critical" if leaving it out could change diagnosis, treatment or safety; "major" if a clinician would expect it in the note; "minor" otherwise.
Return ONLY JSON: {"facts":[{"id":"O01","text":"...","quote":"...","importance":"critical|major|minor","section":"subjective|objective|assessment|plan"}]}`;

if (mode === 'oracle') {
  const out = fs.existsSync(ORACLE) ? JSON.parse(fs.readFileSync(ORACLE, 'utf8')) : {};
  await pool(set.filter((p) => !out[p.file]), 4, async (p) => {
    const tx = txOf(p.file); const txl = tx.toLowerCase().replace(/\s+/g, ' ');
    try {
      const llm = await createGeminiService(null, { model: 'gemini-2.5-pro' }); llm._agent = 'gold-judge';
      const j = parse(await llm.generateContent(ORACLE_SYS, `RECORDING:\n${tx}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 12000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 180000, retries: 1, hedgeMs: 0 }));
      out[p.file] = (j.facts || []).map((f) => ({ ...f, quoteOk: !!f.quote && txl.includes(String(f.quote).toLowerCase().replace(/\s+/g, ' ').slice(0, 40)) }));
      console.log(p.file.slice(0, 18), out[p.file].length, 'facts');
    } catch (e) { console.log(p.file, 'failed', String(e.message).slice(0, 80)); }
  });
  fs.writeFileSync(ORACLE, JSON.stringify(out));
  const all = Object.values(out).flat();
  console.log(`oracle facts ${all.length} (${(all.length / Object.keys(out).length).toFixed(1)}/note), critical ${all.filter((f) => f.importance === 'critical').length}, quote verified ${all.filter((f) => f.quoteOk).length}`);
  process.exit(0);
}

const SYS = `You compare three things for one consultation: the NOTE, the GRAPH (a list of facts an extractor pulled from the recording) and the ORACLE facts (what a complete note must hold).
For every ORACLE fact answer two questions:
- "graph": is the same fact (same meaning, same numbers, drug, dose, side, timing) stated by any GRAPH entry? "yes", "part" (only some of it) or "no".
- "note": does the NOTE state it, in any section? "yes", "part" or "no".
Return ONLY JSON: {"r":{"O01":{"graph":"yes|part|no","note":"yes|part|no"}, ...}} with an entry for every oracle fact.`;
const oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8')); const graph = JSON.parse(fs.readFileSync(FACTS, 'utf8'));
for (const label of process.argv.slice(3)) {
  const run = JSON.parse(fs.readFileSync(`/lab-data/gold-eval/${label}.json`, 'utf8')).filter((x) => x.note && oracle[x.file] && graph[x.file]);
  const rows = [];
  await pool(run, 6, async (x) => {
    const o = oracle[x.file].filter((f) => f.quoteOk);
    try {
      const llm = await createGeminiService(null, { model: 'gemini-2.5-pro' }); llm._agent = 'gold-judge';
      const j = parse(await llm.generateContent(SYS, `NOTE:\n${x.note}\n\nGRAPH:\n${graph[x.file].map((f) => `- ${f.text}`).join('\n')}\n\nORACLE:\n${o.map((f) => `${f.id} ${f.text}`).join('\n')}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 9000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 180000, retries: 1, hedgeMs: 0 })).r || {};
      for (const f of o) rows.push({ file: x.file, id: f.id, imp: f.importance, section: f.section, text: f.text, quote: f.quote, graph: j[f.id]?.graph || '?', note: j[f.id]?.note || '?' });
    } catch (e) { console.log(x.file, 'failed', String(e.message).slice(0, 80)); }
  });
  fs.writeFileSync(`/lab-data/gold-eval/${label}.oracle.json`, JSON.stringify(rows));
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : 'n/a') + '%';
  for (const imp of ['critical', 'major', 'all']) {
    const r = rows.filter((x) => imp === 'all' || x.imp === imp); const miss = r.filter((x) => x.note === 'no');
    const missNotInGraph = miss.filter((x) => x.graph === 'no').length;
    console.log(`${label} ${imp.padEnd(8)} oracle facts ${r.length} | in graph ${pct(r.filter((x) => x.graph === 'yes').length, r.length)} | in note ${pct(r.filter((x) => x.note === 'yes').length, r.length)} | missing from note ${miss.length}: not in graph ${missNotInGraph} (${pct(missNotInGraph, miss.length)}), in graph but not written ${miss.length - missNotInGraph}`);
  }
  const g = rows.filter((x) => x.graph === 'no'); const bySec = {}; for (const x of g) bySec[x.section] = (bySec[x.section] || 0) + 1;
  console.log(`${label} facts the graph lacks by section:`, JSON.stringify(bySec));
}
process.exit(0);
