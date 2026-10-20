#!/usr/bin/env node
// Real-consult check: for recordings the doctors actually made in the app, compare what the LIVE pipeline stored (20-second chunks) with
// the whole recording transcribed by each engine. No human reference exists for real consults, so this measures (a) whether the live
// transcript is missing speech (words per minute, words the whole-file engines heard that the stored text lacks) and (b) how much the
// engines agree with each other. It prints ONLY statistics and short ids — never any transcript text.
//   node tools/asr-real-check.mjs [N=8]
import { query } from '../src/db/pool.js';
import { transcodePcm16k } from '../src/asr/audio.js';
import { pcmDurationSeconds } from '../src/asr/googleSpeech.js';
import { ENGINES, transcribeWithChain, defaultRunners } from '../src/asr/engines.js';
import { normalise, align } from './asr-benchmark.mjs';

const N = Number(process.argv[2]) || 8; const BUCKET = process.env.GCS_AUDIO_BUCKET || '';
const ENGINE_LIST = (process.env.ENGINES || 'chirp_3,chirp_2,latest_long').split(',');
const rows = await query(`SELECT consult_id, audio_uri, transcript->>'text' AS text FROM clinical.consults WHERE audio_uri IS NOT NULL AND audio_uri <> '' AND length(coalesce(transcript->>'text','')) > 1500 ORDER BY created_at DESC LIMIT $1`, [N]);
const { Storage } = await import('@google-cloud/storage'); const bucket = new Storage().bucket(BUCKET);
const out = [];
for (const r of rows) {
  const name = r.audio_uri.replace(`gs://${BUCKET}/`, '');
  let pcm; try { const [buf] = await bucket.file(name).download(); pcm = await transcodePcm16k(buf); } catch (e) { console.log(`${r.consult_id.slice(-6)}: audio unavailable (${String(e.message).slice(0, 60)})`); continue; }
  const sec = pcmDurationSeconds(pcm.length); const stored = normalise(r.text);
  const row = { id: r.consult_id.slice(-6), minutes: +(sec / 60).toFixed(1), stored_words: stored.length, stored_wpm: Math.round(stored.length / (sec / 60)), engines: {} };
  for (const e of ENGINE_LIST) {
    const t0 = Date.now();
    try { const res = await transcribeWithChain(pcm, { settings: { primary: e, fallbacks: [], timeoutMs: 170000, breakerFailures: 99, breakerCooldownMs: 10000, speechCheck: false }, log: () => {} }); const hyp = normalise(res.text);
      const a = align(stored, hyp); row.engines[e] = { words: hyp.length, wpm: Math.round(hyp.length / (sec / 60)), vs_stored_wer: +a.wer.toFixed(3), heard_but_not_stored: a.ins, stored_but_not_heard: a.del, s: Math.round((Date.now() - t0) / 1000), _hyp: hyp }; }
    catch (err) { row.engines[e] = { error: String(err.message).slice(0, 80) }; }
  }
  const names = Object.keys(row.engines).filter((k) => row.engines[k]._hyp);
  row.pairwise = {}; for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) row.pairwise[`${names[i]}~${names[j]}`] = +align(row.engines[names[i]]._hyp, row.engines[names[j]]._hyp).wer.toFixed(3);
  for (const k of names) delete row.engines[k]._hyp;
  out.push(row); console.log(JSON.stringify(row));
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
console.log('\n=== REAL CONSULTS (' + out.length + ') ===');
console.log('stored (live) words/min mean:', Math.round(mean(out.map((r) => r.stored_wpm))));
for (const e of ENGINE_LIST) { const rs = out.map((r) => r.engines[e]).filter((x) => x && !x.error); console.log(e.padEnd(12), 'whole-file words/min', Math.round(mean(rs.map((x) => x.wpm)) || 0), '| differs from stored by', ((mean(rs.map((x) => x.vs_stored_wer)) || 0) * 100).toFixed(1) + '%', '| words heard but missing from stored', Math.round(mean(rs.map((x) => x.heard_but_not_stored)) || 0), '| stored but not heard', Math.round(mean(rs.map((x) => x.stored_but_not_heard)) || 0), '| runs', rs.length); }
const pairs = {}; for (const r of out) for (const [k, v] of Object.entries(r.pairwise)) (pairs[k] ||= []).push(v); for (const [k, v] of Object.entries(pairs)) console.log('agreement', k.padEnd(24), 'differ by', (mean(v) * 100).toFixed(1) + '%');
process.exit(0);
