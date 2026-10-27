#!/usr/bin/env node
// Scores the pipeline against the doctor's own notes (the reference set picked by gold-pick.mjs from data/gold).
// For each pair the pipeline writes a note from the transcript (the pair's own note is kept out of the reference examples), then TWO judges
// (Gemini 2.5 Pro and Gemini 2.5 Flash, so one model's quirks do not decide) compare it with the doctor's note and the transcript:
//   missing: what the doctor recorded that our note lacks (critical / important / minor), wrong: what our note says that the transcript does not
//   support, and a 0-100 score. The two judges are averaged; a fact counts as missing when either judge lists it as critical.
//   docker exec -w /app/packages/backend notera-lab node tools/gold-eval.mjs <label> [concurrency=4] [--env=KEY=V,...] [--limit=N]
// Output: /lab-data/gold-eval/<label>.json and a summary. About $0.08 and 60 s per pair.
import fs from 'node:fs';
import path from 'node:path';
import { generateNote } from '../src/orchestrator/generateNote.js';
import { createGeminiService } from '../src/services/LLMService.js';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--')); const flag = (n, d) => ((process.argv.find((a) => a.startsWith('--' + n + '=')) || '').split('=').slice(1).join('=')) || d;
const [label = 'gold', concArg = '4'] = pos; for (const kv of String(flag('env', '')).split(',').filter(Boolean)) { const i = kv.indexOf('='); process.env[kv.slice(0, i)] = kv.slice(i + 1); }
const ROOT = process.env.REPO_ROOT || '/app'; const OUT = '/lab-data/gold-eval'; fs.mkdirSync(OUT, { recursive: true });
const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'gold-set.json'), 'utf8')).pairs.slice(0, Number(flag('limit', '999')));
const slug = (f) => f.replace(/\.txt$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const JUDGE_SYS = `You compare a CANDIDATE clinic note with the REFERENCE note the doctor wrote for the same visit, using the TRANSCRIPT as the truth.
Return ONLY JSON: {"missing":[{"fact":"","importance":"critical|important|minor"}],"wrong":[{"claim":"","why":"","severity":"critical|major|minor"}],"score":0}
- missing: clinical facts the REFERENCE records (and the transcript supports) that the CANDIDATE does not say anywhere, in any words. Same fact in other words or another section is NOT missing. critical = a diagnosis, medicine, dose, test, referral, follow-up or safety advice decided in the visit; important = a key history fact or result; minor = context.
- wrong: statements in the CANDIDATE that the transcript contradicts or does not support (invented drugs, doses, sides, plans). Different wording or layout is NOT wrong.
- score: 0-100, how well the CANDIDATE could replace the REFERENCE for patient care (completeness 60%, correctness 40%). Style and layout do not count.`;

async function judge(model, tx, ref, cand) {
  const llm = await createGeminiService(null, { model }); llm._agent = 'gold-judge';
  try { const raw = await llm.generateContent(JUDGE_SYS, `TRANSCRIPT:\n"""\n${tx.slice(0, 60000)}\n"""\n\nREFERENCE (the doctor's note):\n${ref}\n\nCANDIDATE:\n${cand}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 6000, temperature: 0, timeoutMs: 120000, retries: 2, responseMimeType: 'application/json', thinkingBudget: model.includes('pro') ? 2048 : 0 });
    const j = JSON.parse(String(raw).replace(/^```json|```$/g, '').trim()); return { score: Number(j.score) || 0, missing: j.missing || [], wrong: j.wrong || [] };
  } catch (e) { return { error: String(e.message).slice(0, 160) }; }
}

const results = []; let next = 0;
await Promise.all(Array.from({ length: Number(concArg) || 4 }, async () => {
  while (next < set.length) {
    const p = set[next++]; const t = fs.readFileSync(path.join(ROOT, 'data', 'gold', p.file), 'utf8'); const i = t.search(/\n\s*\**Subjective:?\**/i);
    const tx = t.slice(0, i).replace(/^\s*\d+:\d+\s*$/gm, ' ').trim(); const ref = t.slice(i).trim(); const t0 = Date.now(); const trace = {};
    try {
      const r = await generateNote({ transcript: tx, specialty: 'auto', noteType: 'consultation', clinicianId: 'gold-eval' }, { persist: false, mode: 'v2', trace, exemplarExclude: [slug(p.file), p.file] });
      const note = r.renderedNote || ''; const seconds = Math.round((Date.now() - t0) / 1000);
      const [a, b] = await Promise.all([judge('gemini-2.5-pro', tx, ref, note), judge('gemini-2.5-flash', tx, ref, note)]);
      results.push({ file: p.file, tw: p.tw, seconds, note, judges: { pro: a, flash: b }, ledger: trace.factLedger?.summary || null, drugs: (trace.drugs || []).length, timings: trace.timings, tokens: r.tokenUsage || null, usage: r.note?.metadata?.quality?.usage || null, groundGap: trace.grounding?.gap || null, groundDelta: trace.groundDelta || null, negation: trace.negation || null, coverageEarly: !!trace.coverage?.early, story: trace.story ? { applied: trace.story.applied, why: trace.story.why } : null });
    } catch (e) { results.push({ file: p.file, error: String(e.message).slice(0, 200) }); }
    process.stderr.write(`\r${results.length}/${set.length}`);
  }
}));
fs.writeFileSync(path.join(OUT, label + '.json'), JSON.stringify(results));
const ok = results.filter((x) => x.judges && !x.judges.pro.error && !x.judges.flash.error);
const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null);
const cnt = (x, k, lvl) => (x.judges[k][lvl === 'wrong' ? 'wrong' : 'missing'] || []).filter((m) => (lvl === 'wrong' ? true : m.importance === lvl)).length;
console.log(`\n${label}: ${ok.length}/${results.length} pairs judged by both`);
for (const k of ['pro', 'flash']) console.log(`  ${k.padEnd(5)} score ${mean(ok.map((x) => x.judges[k].score))} | missing critical ${mean(ok.map((x) => cnt(x, k, 'critical')))} important ${mean(ok.map((x) => cnt(x, k, 'important')))} minor ${mean(ok.map((x) => cnt(x, k, 'minor')))} | wrong ${mean(ok.map((x) => cnt(x, k, 'wrong')))}`);
console.log(`  both  score ${mean(ok.map((x) => (x.judges.pro.score + x.judges.flash.score) / 2))} | notes with a critical miss (either judge) ${ok.filter((x) => cnt(x, 'pro', 'critical') + cnt(x, 'flash', 'critical') > 0).length}/${ok.length} | judge agreement on score (mean |pro-flash|) ${mean(ok.map((x) => Math.abs(x.judges.pro.score - x.judges.flash.score)))}`);
console.log(`  time per note mean ${mean(ok.map((x) => x.seconds))} s, max ${Math.max(...ok.map((x) => x.seconds))} s`);
process.exit(0);
