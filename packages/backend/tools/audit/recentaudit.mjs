// Completeness check of a few real notes: what the clinician DID or DECIDED (actions) and the details that go with it, against the note.
//   node recentaudit.mjs score <in.json> <out.json>   in: [{id, transcript, note}]  -> out: per note the actions with present / partial / absent (pro model, two steps)
//   node recentaudit.mjs rerun <in.json> <out.json>   re-writes every note with the CURRENT pipeline (env switches apply) -> same shape as the input
//   node recentaudit.mjs show <scored.json>           prints the absent and partial items
// Lab only (paths /app/...). Real transcripts are real patient data: keep the files in /lab-data.
import fs from 'node:fs';
const [mode, inp, outp] = process.argv.slice(2);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const parse = (raw) => JSON.parse(String(raw).replace(/^```json|```$/g, '').trim());
const pool = async (items, n, fn) => { let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) await fn(items[k++]); })); };

if (mode === 'show') {
  for (const x of read(inp)) {
    const bad = x.items.filter((i) => i.verdict !== 'present');
    console.log(`\n${x.id}: ${x.items.length} actions/details, absent ${x.items.filter((i) => i.verdict === 'absent').length}, partial ${x.items.filter((i) => i.verdict === 'partial').length}`);
    for (const i of bad) console.log(`  [${i.verdict}] (${i.kind}) ${i.text}`);
  }
  process.exit(0);
}
const { createGeminiService } = await import('/app/packages/backend/src/services/LLMService.js');
const data = read(inp);

if (mode === 'rerun') {
  const { generateNote } = await import('/app/packages/backend/src/orchestrator/generateNote.js');
  const out = []; const t0 = Date.now();
  await pool(data, 3, async (x) => {
    const s = Date.now(); const trace = {};
    try { const r = await generateNote({ transcript: x.transcript, specialty: 'general_primary_care', noteType: 'consultation', clinicianId: 'recent-audit' }, { persist: false, mode: 'v2', trace });
      out.push({ id: x.id, transcript: x.transcript, note: r.note?.rendered || r.rendered || r.markdown || '', seconds: Math.round((Date.now() - s) / 1000), noteJson: r.note }); }
    catch (e) { console.log(x.id, 'failed', String(e.message).slice(0, 100)); }
  });
  fs.writeFileSync(outp, JSON.stringify(out)); console.log(`rewrote ${out.length} notes, mean ${(out.reduce((s, x) => s + x.seconds, 0) / out.length).toFixed(0)} s`); process.exit(0);
}

const ACT_SYS = `You read a doctor-patient consultation recording and list EVERY ACTION AND DECISION of the visit with the details a colleague would need to carry it out or check it, plus the facts that make the visit complete.
Kinds: "prescription" (drug, dose, frequency, quantity, refills, pharmacy, and HOW it was sent: faxed, printed, e-prescribed), "medication_change" (started, stopped, increased, decreased, continued, declined), "test" (blood test, scan, requisition printed, timing, where), "referral", "vaccine" (given today or deferred), "follow_up" (when, with whom, conditional on what), "advice" (instructions, warnings, return-if), "decision" (patient agreed, declined, deferred, will think about it), "exam" (what was examined and found), "history" (a symptom, duration, severity, negative or past event that matters).
One item per action or detail, as a short plain statement with the exact words from the recording as "quote" (word for word, at most 25 words). Do not invent. Do not list small talk. The recording comes from speech recognition and may contain mistakes: list what was said.
Return ONLY JSON: {"items":[{"id":"A01","kind":"...","text":"...","quote":"..."}]}`;
const CHK_SYS = `You check whether a clinic NOTE states each numbered ITEM. "present": the note says it (any words, any section, same meaning, drug, dose, number, route/way of sending, timing). "partial": the note says it but leaves out a detail that was in the item (say which in "missing"). "absent": the note does not say it.
Return ONLY JSON: {"r":{"A01":{"verdict":"present|partial|absent","missing":""}, ...}} with an entry for every item.`;
const out = [];
await pool(data, 4, async (x) => {
  try {
    const llm = await createGeminiService(null, { model: 'gemini-2.5-pro' }); llm._agent = 'gold-judge';
    const fixed = process.env.ITEMS ? (read(process.env.ITEMS).find((y) => y.id === x.id)?.items || []).map(({ verdict, missing, ...i }) => i) : null;   // ITEMS=<scored.json>: judge a new version of the notes against the SAME list
    const items = fixed || (parse(await llm.generateContent(ACT_SYS, `RECORDING:\n${x.transcript}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 12000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 180000, retries: 1, hedgeMs: 0 })).items || []);
    const llm2 = await createGeminiService(null, { model: 'gemini-2.5-pro' }); llm2._agent = 'gold-judge';
    const r = parse(await llm2.generateContent(CHK_SYS, `NOTE:\n${x.note}\n\nITEMS:\n${items.map((i) => `${i.id} [${i.kind}] ${i.text}`).join('\n')}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 9000, temperature: 0, responseMimeType: 'application/json', timeoutMs: 180000, retries: 1, hedgeMs: 0 })).r || {};
    out.push({ id: x.id, items: items.map((i) => ({ ...i, verdict: r[i.id]?.verdict || '?', missing: r[i.id]?.missing || '' })) });
  } catch (e) { console.log(x.id, 'failed', String(e.message).slice(0, 100)); }
});
fs.writeFileSync(outp, JSON.stringify(out));
const all = out.flatMap((x) => x.items); const pct = (n) => ((n / all.length) * 100).toFixed(1) + '%';
const kinds = [...new Set(all.map((i) => i.kind))];
console.log(`${out.length} notes, ${all.length} items: present ${pct(all.filter((i) => i.verdict === 'present').length)}, partial ${pct(all.filter((i) => i.verdict === 'partial').length)}, absent ${pct(all.filter((i) => i.verdict === 'absent').length)}`);
for (const k of kinds) { const a = all.filter((i) => i.kind === k); console.log(`  ${k.padEnd(18)} ${String(a.length).padStart(3)} items | present ${a.filter((i) => i.verdict === 'present').length} partial ${a.filter((i) => i.verdict === 'partial').length} absent ${a.filter((i) => i.verdict === 'absent').length}`); }
process.exit(0);
