#!/usr/bin/env node
// Speech-to-text accuracy variants: the SAME recordings through Chirp 2 with and without each improvement, scored against the human transcripts.
//   Run inside the lab container (it holds the audio + credentials):  node tools/asr-variants.mjs [file ids...]
//   Env: AUDIO_DIR (default /lab-data/audio), OUT_DIR (default /lab-data/asr-variants), VARIANTS (comma list), MAX_FILES
// Variants: base (Chirp 2 as it ran before) · hints (+ medical vocabulary) · overlap (+ overlap-safe windows) · both · gem (Gemini 2.5 Flash audio) ·
//           base+gem / both+gem (the Chirp text checked against Gemini: medical-word swaps and filled-in sentences, see src/asr/consensus.js)
// Metrics: word error rate (substitutions / deletions / insertions) on normalised text, recall of numbers and drug-like words, and recall of MEDICAL
// vocabulary words in the reference (the words the clinical decisions depend on). Nothing is stored in the database.
import fs from 'node:fs';
import path from 'node:path';
import { transcodePcm16k } from '../src/asr/audio.js';
import { transcribeChirpPcm, pcmDurationSeconds } from '../src/asr/googleSpeech.js';
import { defaultRunners } from '../src/asr/engines.js';
import { reconcile } from '../src/asr/consensus.js';
import { MEDICAL_TERMS } from '../src/asr/medicalVocab.js';
import { normalise, align, keyTokens, recall } from './asr-benchmark.mjs';

const AUDIO = process.env.AUDIO_DIR || '/lab-data/audio';
const OUT = process.env.OUT_DIR || '/lab-data/asr-variants';
const ALL = ['base', 'hints', 'overlap', 'both', 'gem', 'base+gem', 'both+gem'];
const VARIANTS = (process.env.VARIANTS ? process.env.VARIANTS.split(',') : ALL).map((x) => x.trim());
const readText = (f) => { const b = fs.readFileSync(f); return (b.filter((x) => x === 0).length / b.length > 0.3 ? b.toString('latin1').replace(/[\u0000ÿþ]/g, '') : b.toString('utf8')); };

const chirp = (pcm, o) => transcribeChirpPcm(pcm, { model: 'chirp_2', location: 'us-central1', log: () => {}, ...o }).then((r) => r.text);
const gem = (pcm) => defaultRunners.gemini(pcm, 'gemini-2.5-flash', () => {}).then((r) => r.text);

export async function runAll(pcm, wanted) {
  const need = new Set(wanted.flatMap((v) => v.split('+')));
  const t = {}; const ms = {};
  const run = (k, fn) => { const t0 = Date.now(); return fn().then((x) => { t[k] = x; ms[k] = Date.now() - t0; }, (e) => { t[k] = null; ms[k] = Date.now() - t0; console.log(`   ${k} FAILED ${String(e.message).slice(0, 160)}`); }); };
  const jobs = [];
  if (need.has('base')) jobs.push(run('base', () => chirp(pcm, { hints: false, overlapSeconds: 0 })));
  if (need.has('hints')) jobs.push(run('hints', () => chirp(pcm, { hints: true, overlapSeconds: 0 })));
  if (need.has('overlap')) jobs.push(run('overlap', () => chirp(pcm, { hints: false, overlapSeconds: 3 })));
  if (need.has('both')) jobs.push(run('both', () => chirp(pcm, { hints: true, overlapSeconds: 3 })));
  if (need.has('gem')) jobs.push(run('gem', () => gem(pcm)));
  await Promise.all(jobs);
  for (const v of wanted) if (v.includes('+')) { const [a, b] = v.split('+'); if (t[a] && t[b]) { const r = reconcile(t[a], t[b]); t[v] = r.text; t[v + ':swaps'] = r.swaps; t[v + ':fills'] = r.fills; } else t[v] = null; }
  return { t, ms };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3')).map((f) => f.replace(/\.mp3$/, '')).sort().slice(0, Number(process.env.MAX_FILES) || 99);
  const results = [];
  for (const id of ids) {
    const mp3 = fs.readFileSync(path.join(AUDIO, id + '.mp3')); const ref = normalise(readText(path.join(AUDIO, id + '.txt'))); const keys = keyTokens(ref);
    const med = new Set(ref.filter((w) => MEDICAL_TERMS.has(w)));
    const pcm = await transcodePcm16k(mp3); const seconds = pcmDurationSeconds(pcm.length);
    console.log(`\n== ${id}: ${seconds.toFixed(0)}s, ${ref.length} reference words, ${keys.size} key tokens, ${med.size} medical terms`);
    const { t, ms } = await runAll(pcm, VARIANTS); const row = { id, seconds, ref_words: ref.length, key_tokens: keys.size, med_terms: med.size, variants: {} };
    for (const v of VARIANTS) {
      if (!t[v]) { row.variants[v] = { ok: false }; continue; }
      const hyp = normalise(t[v]); const a = align(ref, hyp); const mr = recall(med, hyp);
      const missingMed = [...med].filter((w) => !hyp.includes(w));
      row.variants[v] = { ok: true, wer: a.wer, sub: a.sub, del: a.del, ins: a.ins, words: hyp.length, key_recall: recall(keys, hyp), med_recall: mr, missing_med: missingMed.slice(0, 30), swaps: t[v + ':swaps']?.length, fills: t[v + ':fills'], ms: ms[v] };
      fs.writeFileSync(path.join(OUT, `${id}.${v.replace('+', '_')}.txt`), t[v]);
      console.log(`   ${v.padEnd(10)} WER ${(a.wer * 100).toFixed(1).padStart(5)}% (sub ${a.sub} del ${a.del} ins ${a.ins})  key ${keys.size ? (recall(keys, hyp) * 100).toFixed(0) + '%' : '—'}  medical ${med.size ? (mr * 100).toFixed(0) + '%' : '—'}${t[v + ':swaps'] ? `  swaps ${t[v + ':swaps'].length} fills ${t[v + ':fills'].length}` : ''}`);
    }
    results.push(row); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  console.log('\n=== SUMMARY (mean over files) ===');
  const summary = VARIANTS.map((v) => {
    const rows = results.map((r) => r.variants[v]).filter((x) => x?.ok); const tw = results.reduce((s, r) => s + (r.variants[v]?.ok ? r.ref_words : 0), 0);
    const mrs = rows.map((x) => x.med_recall).filter((x) => x != null); const krs = rows.map((x) => x.key_recall).filter((x) => x != null);
    return { variant: v, files: rows.length, wer_mean: mean(rows.map((x) => x.wer)), del_pct: tw ? rows.reduce((s, x) => s + x.del, 0) / tw : null, med_recall: mean(mrs), key_recall: mean(krs), swaps: rows.reduce((s, x) => s + (x.swaps || 0), 0), fills: rows.reduce((s, x) => s + (x.fills?.length || 0), 0) };
  });
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  for (const s of summary) console.log(`${s.variant.padEnd(10)} WER ${s.wer_mean == null ? '—' : (s.wer_mean * 100).toFixed(2) + '%'}  missed words ${s.del_pct == null ? '—' : (s.del_pct * 100).toFixed(1) + '%'}  medical-term recall ${s.med_recall == null ? '—' : (s.med_recall * 100).toFixed(1) + '%'}  key-token recall ${s.key_recall == null ? '—' : (s.key_recall * 100).toFixed(1) + '%'}  swaps ${s.swaps} fills ${s.fills}`);
}
if (process.argv[1] && /asr-variants\.mjs$/.test(process.argv[1])) await main();
