#!/usr/bin/env node
// Speech-to-text benchmark: the SAME recordings through several engines, scored against the human transcripts.
//   Run inside the lab container (it holds the audio + credentials):  node tools/asr-benchmark.mjs [file ids...]
//   Env: AUDIO_DIR (default /lab-data/audio), OUT_DIR (default /lab-data/asr-bench), MODELS (comma list), MAX_FILES
// Engines: chirp_3 (Google's newest, V2 'us'), chirp_2 (production today, V2 us-central1), latest_long (V1 standard, cheapest),
//          medical_conversation (V1 premium, REFERENCE ONLY), gemini-2.5-flash / gemini-3.7-flash (multimodal audio).
// Metrics: word error rate on normalised text (fillers, speaker labels and punctuation removed), split into substitutions / deletions /
// insertions; recall of clinically important tokens (numbers and drug-like words); wall time; estimated cost. Nothing is stored in the database.
import fs from 'node:fs';
import path from 'node:path';
import { transcodePcm16k } from '../src/asr/audio.js';
import { transcribeChirpPcm, planWindows, pcmDurationSeconds } from '../src/asr/googleSpeech.js';
import { createGeminiService } from '../src/services/LLMService.js';

const AUDIO = process.env.AUDIO_DIR || '/lab-data/audio';
const OUT = process.env.OUT_DIR || '/lab-data/asr-bench';
const ALL = ['chirp_3', 'chirp_2', 'latest_long', 'medical_conversation', 'gemini-2.5-flash', 'gemini-3.7-flash'];
const MODELS = (process.env.MODELS ? process.env.MODELS.split(',') : ALL).map((x) => x.trim());

// ── scoring ──
const FILLERS = new Set(['uh', 'um', 'umm', 'uhm', 'hmm', 'mm', 'mhm', 'erm', 'er', 'ah', 'eh', 'oh', 'huh', 'uhh', 'ahh', 'mmm', 'hm']);
const readText = (f) => { const b = fs.readFileSync(f); return (b.filter((x) => x === 0).length / b.length > 0.3 ? b.toString('latin1').replace(/[\u0000ÿþ]/g, '') : b.toString('utf8')); };
const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// "eight" and "8" are the same word for scoring purposes, and "okay"/"ok" likewise
export function normalise(s) {
  return String(s).toLowerCase().replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (w) => String(NUM[w])).replace(/\bokay\b/g, 'ok')
    .replace(/\b(doctor|physician|patient|speaker\s*\d+|dr|pt|d|p)\s*:/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/(\d),(\d)/g, '$1$2').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w && !FILLERS.has(w));
}
export function align(ref, hyp) {                                  // Levenshtein with backtrace: substitutions / deletions / insertions
  const n = ref.length, m = hyp.length; if (!n) return { wer: m ? 1 : 0, sub: 0, del: 0, ins: m };
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1)); for (let i = 0; i <= n; i++) d[i][0] = i; for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  let i = n, j = m, sub = 0, del = 0, ins = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { if (ref[i - 1] !== hyp[j - 1]) sub++; i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { del++; i--; } else { ins++; j--; }
  }
  return { wer: (sub + del + ins) / n, sub, del, ins };
}
const DRUGISH = /(pril|sartan|statin|olol|azole|mycin|cillin|oxacin|prazole|tidine|formin|gliptin|gliflozin|glutide|zepam|zolam|pam|triptan|setron|caine|profen|fenac|coxib|dipine|thiazide|semide|parin|xaban|navir|vir|mab|nib|cycline|floxacin|ine|ol|in|ide|one|ate)$/;
export function keyTokens(ref) { const set = new Set(); for (const w of ref) if (/\d/.test(w) || (w.length >= 7 && DRUGISH.test(w))) set.add(w); return set; }
export const recall = (keys, hyp) => { if (!keys.size) return null; const h = new Set(hyp); let hit = 0; for (const k of keys) if (h.has(k)) hit++; return hit / keys.size; };

// ── engines ──
async function v1Transcribe(pcm, model) {
  const speech = (await import('@google-cloud/speech')).default; const client = new speech.SpeechClient(); const windows = planWindows(pcm, {});
  const parts = []; let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => { while (next < windows.length) { const i = next++; const w = windows[i];
    const [r] = await client.recognize({ audio: { content: pcm.subarray(w.start, w.end).toString('base64') }, config: { languageCode: 'en-US', encoding: 'LINEAR16', sampleRateHertz: 16000, audioChannelCount: 1, enableAutomaticPunctuation: true, model } });
    parts[i] = (r.results || []).map((x) => x.alternatives?.[0]?.transcript || '').join(' '); } }));
  return parts.join(' ');
}
const GEMINI_PROMPT = 'Transcribe this recorded medical consultation word for word, in English. Label each turn "Doctor:" or "Patient:". Write numbers, doses and drug names exactly as spoken. Do not summarise, correct or add anything. Output only the transcript.';
async function geminiTranscribe(mp3, model) {
  const svc = await createGeminiService(null, { model }); const url = svc._endpoint(false, model); const headers = await svc._authHeaders();
  const body = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mpeg', data: mp3.toString('base64') } }, { text: GEMINI_PROMPT }] }], generationConfig: { temperature: 0, maxOutputTokens: 60000, thinkingConfig: { thinkingBudget: 0 } } };
  let r, j;
  for (let attempt = 0; attempt < 4; attempt++) {   // Vertex answers 429 when several long audio requests run at once: back off and retry
    r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(200000) }); j = await r.json();
    if (r.status !== 429 || attempt === 3) break; await new Promise((res) => setTimeout(res, 15000 * (attempt + 1)));
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ');
  return { text, usage: j.usageMetadata || {} };
}
const PRICE_PER_MIN = { chirp_3: 0.016, chirp_2: 0.016, latest_long: 0.016, medical_conversation: 0.078 };   // Google list prices, USD per audio minute (assumption, check the current price list)
const GEMINI_PRICE = { 'gemini-2.5-flash': { in: 1.0, out: 2.5 }, 'gemini-3.7-flash': { in: 1.0, out: 3.0 } };    // USD per million tokens (audio input / text output) — estimates

const withTimeout = (p, ms, label) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
async function runEngine(name, pcm, mp3, minutes) {
  const t0 = Date.now();
  try {
    return await withTimeout(runEngineInner(name, pcm, mp3, minutes, t0), 300000, name);
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 240), ms: Date.now() - t0 }; }
}
async function runEngineInner(name, pcm, mp3, minutes, t0) {
  try {
    let text, cost = null, note = '';
    if (name === 'chirp_3') ({ text } = await transcribeChirpPcm(pcm, { model: 'chirp_3', location: 'us', log: () => {} }));
    else if (name === 'chirp_2') ({ text } = await transcribeChirpPcm(pcm, { model: 'chirp_2', location: 'us-central1', log: () => {} }));
    else if (name === 'latest_long' || name === 'medical_conversation') text = await v1Transcribe(pcm, name);
    else { const g = await geminiTranscribe(mp3, name); text = g.text; const p = GEMINI_PRICE[name] || { in: 1, out: 3 }; cost = ((g.usage.promptTokenCount || 0) * p.in + (g.usage.candidatesTokenCount || 0) * p.out) / 1e6; note = `tokens in ${g.usage.promptTokenCount} out ${g.usage.candidatesTokenCount}`; }
    if (cost == null) cost = (PRICE_PER_MIN[name] || 0) * minutes;
    return { ok: true, text, ms: Date.now() - t0, cost, note };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 240), ms: Date.now() - t0 }; }
}

async function main() {
fs.mkdirSync(OUT, { recursive: true });
const ids = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3')).map((f) => f.replace(/\.mp3$/, '')).sort().slice(0, Number(process.env.MAX_FILES) || 99);
const results = [];
for (const id of ids) {
  const mp3 = fs.readFileSync(path.join(AUDIO, id + '.mp3')); const refRaw = readText(path.join(AUDIO, id + '.txt')); const ref = normalise(refRaw); const keys = keyTokens(ref);
  const pcm = await transcodePcm16k(mp3); const seconds = pcmDurationSeconds(pcm.length); const minutes = seconds / 60;
  console.log(`\n== ${id}: ${seconds.toFixed(0)}s audio, ${ref.length} reference words, ${keys.size} key tokens`);
  const row = { id, seconds, ref_words: ref.length, key_tokens: keys.size, engines: {} };
  const outs = await Promise.all(MODELS.map((m) => runEngine(m, pcm, mp3, minutes).then((r) => [m, r])));
  for (const [m, r] of outs) {
    if (!r.ok) { row.engines[m] = { ok: false, error: r.error, ms: r.ms }; console.log(`   ${m.padEnd(22)} FAILED ${r.error}`); continue; }
    const hyp = normalise(r.text); const a = align(ref, hyp);
    row.engines[m] = { ok: true, wer: a.wer, sub: a.sub, del: a.del, ins: a.ins, hyp_words: hyp.length, key_recall: recall(keys, hyp), ms: r.ms, rtf: r.ms / 1000 / seconds, cost: r.cost, labelled: /doctor:|patient:|speaker \d/i.test(r.text), note: r.note };
    fs.writeFileSync(path.join(OUT, `${id}.${m}.txt`), r.text);
    console.log(`   ${m.padEnd(22)} WER ${(a.wer * 100).toFixed(1).padStart(5)}%  (sub ${a.sub} del ${a.del} ins ${a.ins})  key-terms ${recall(keys, hyp) == null ? '—' : (recall(keys, hyp) * 100).toFixed(0) + '%'}  ${(r.ms / 1000).toFixed(0)}s  $${r.cost.toFixed(4)}`);
  }
  results.push(row); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
}
// ── summary ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const summary = MODELS.map((m) => { const rows = results.map((r) => r.engines[m]).filter((x) => x?.ok); const tw = results.reduce((s, r) => s + (r.engines[m]?.ok ? r.ref_words : 0), 0);
  return { model: m, files: rows.length, failed: results.length - rows.length, wer_mean: mean(rows.map((x) => x.wer)), wer_worst: rows.length ? Math.max(...rows.map((x) => x.wer)) : null, deletions_pct: tw ? rows.reduce((s, x, i) => s + x.del, 0) / tw : null, key_recall: mean(rows.map((x) => x.key_recall).filter((x) => x != null)), rtf: mean(rows.map((x) => x.rtf)), cost_per_10min: mean(rows.map((x, i) => x.cost / (results.find((r) => r.engines[m] === x).seconds / 600))), labelled: rows.some((x) => x.labelled) }; });
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
console.log('\n=== SUMMARY (mean over files) ===');
for (const s of summary) console.log(`${s.model.padEnd(22)} WER ${s.wer_mean == null ? '—' : (s.wer_mean * 100).toFixed(1) + '%'}  worst ${s.wer_worst == null ? '—' : (s.wer_worst * 100).toFixed(0) + '%'}  missed words ${s.deletions_pct == null ? '—' : (s.deletions_pct * 100).toFixed(1) + '%'}  key-terms ${s.key_recall == null ? '—' : (s.key_recall * 100).toFixed(0) + '%'}  RTF ${s.rtf == null ? '—' : s.rtf.toFixed(2)}  $${s.cost_per_10min == null ? '—' : s.cost_per_10min.toFixed(3)}/10min  speakers:${s.labelled ? 'yes' : 'no'}  failed ${s.failed}`);
}
if (process.argv[1] && /asr-benchmark\.mjs$/.test(process.argv[1])) await main();
