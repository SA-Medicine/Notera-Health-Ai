#!/usr/bin/env node
// A/B two eval runs on the same fixtures.
//   node eval/compare_runs.mjs <runA_dir> <runB_dir> [--judge]
// Prints per-fixture metrics side by side and (with --judge) a BLIND pairwise LLM judgement
// (order randomised per fixture) of completeness vs gold, accuracy vs transcript, concision.
// Needs the Vertex env (LLM_BACKEND=vertex, GCP_PROJECT, GOOGLE_APPLICATION_CREDENTIALS).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const [, , dirA, dirB, ...flags] = process.argv;
if (!dirA || !dirB) { console.error('usage: compare_runs.mjs <runA> <runB> [--judge]'); process.exit(2); }
const load = (d) => {
  const base = path.isAbsolute(d) ? d : path.join(__dirname, 'results', d);
  const sum = JSON.parse(fs.readFileSync(path.join(base, '_summary.json'), 'utf8'));
  return { base, rows: new Map(sum.rows.map((r) => [r.id, r])), summary: sum.summary };
};
const A = load(dirA), B = load(dirB);
const ids = [...A.rows.keys()].filter((id) => B.rows.has(id));
const f = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v ?? '-'));

console.log(`\nA = ${dirA}\nB = ${dirB}\n`);
console.log('SUMMARY A', JSON.stringify(A.summary));
console.log('SUMMARY B', JSON.stringify(B.summary), '\n');
console.log('id'.padEnd(34), 'simA   simB   omiA   omiB   wordsA wordsB  secA secB   sA    sB');
for (const id of ids) {
  const a = A.rows.get(id), b = B.rows.get(id);
  console.log(id.slice(0, 33).padEnd(34), [f(a.similarity_to_gold), f(b.similarity_to_gold), f(a.omission_rate), f(b.omission_rate), String(a.note_words ?? '-').padEnd(6), String(b.note_words ?? '-').padEnd(6), f(a.section_coverage), f(b.section_coverage), ((a.ms || 0) / 1000).toFixed(0).padStart(4), ((b.ms || 0) / 1000).toFixed(0).padStart(4)].join('  '));
}

if (flags.includes('--judge')) {
  const { createGeminiService } = await import(pathToFileURL(path.join(ROOT, 'packages/backend/src/services/LLMService.js')).href);
  const llm = await createGeminiService(null, { model: process.env.JUDGE_MODEL || 'gemini-2.5-pro' });
  llm._agent = 'judge';
  const SYS = `You are a senior physician comparing two AI-written SOAP notes (A and B) for the SAME consultation.
You are given the TRANSCRIPT (ground truth of what was said) and a clinician-written GOLD note (reference for what a good note keeps).
Score each note 1-10 on:
- completeness: captures the clinically important facts the gold note keeps (diagnoses, meds+doses, results, plan, follow-up, referrals)
- accuracy: every statement is supported by the transcript (penalise invented or distorted facts hard)
- concision: specific facts only, no padding or repetition
Return JSON {"A":{"completeness":n,"accuracy":n,"concision":n},"B":{...},"winner":"A"|"B"|"tie","note":"one short sentence"}.`;
  const readNote = (side, id) => { try { return JSON.parse(fs.readFileSync(path.join(side.base, `${id}.json`), 'utf8')).renderedNote || ''; } catch { return ''; } };
  const split = (raw) => { const i = raw.search(/^\s*Subjective\s*:/im); return i === -1 ? { t: raw, g: '' } : { t: raw.slice(0, i).trim(), g: raw.slice(i).trim() }; };
  const tot = { A: { completeness: 0, accuracy: 0, concision: 0 }, B: { completeness: 0, accuracy: 0, concision: 0 } };
  let n = 0; const wins = { A: 0, B: 0, tie: 0 };
  for (const id of ids) {
    const a = readNote(A, id), b = readNote(B, id);
    if (!a || !b || A.rows.get(id).gold_corrupt || B.rows.get(id).gold_corrupt) continue;
    const { t, g } = split(fs.readFileSync(path.join(ROOT, 'data', 'gold', `${id}.txt`), 'utf8'));
    const flip = Math.random() < 0.5;                      // blind: randomise which run is shown as "A"
    const [x, y] = flip ? [b, a] : [a, b];
    try {
      const raw = await llm.generateContent(SYS, `=== TRANSCRIPT ===\n${t.slice(0, 60000)}\n\n=== GOLD NOTE ===\n${g.slice(0, 8000)}\n\n=== NOTE A ===\n${x}\n\n=== NOTE B ===\n${y}\n\nReturn ONLY the JSON.`, null, { maxOutputTokens: 2500, temperature: 0, responseMimeType: 'application/json', timeoutMs: 120000, retries: 1, thinkingBudget: 1024 });
      const r = JSON.parse(raw.replace(/^```json|```$/g, ''));
      const pa = flip ? r.B : r.A, pb = flip ? r.A : r.B;   // map back to run A / run B
      const w = r.winner === 'tie' ? 'tie' : ((r.winner === 'A') !== flip ? 'A' : 'B');
      n++; wins[w]++;
      for (const k of Object.keys(tot.A)) { tot.A[k] += Number(pa?.[k] || 0); tot.B[k] += Number(pb?.[k] || 0); }
      console.log(`${id.slice(0, 34).padEnd(35)} winner=${w.padEnd(3)} A=${JSON.stringify(pa)} B=${JSON.stringify(pb)}  ${r.note || ''}`);
    } catch (e) { console.log(`${id}: judge failed — ${e.message}`); }
  }
  if (n) {
    const avg = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(v / n).toFixed(2)]));
    console.log(`\nJUDGE (n=${n})  wins: A=${wins.A} B=${wins.B} tie=${wins.tie}`);
    console.log('  A avg', JSON.stringify(avg(tot.A)));
    console.log('  B avg', JSON.stringify(avg(tot.B)));
  }
}
