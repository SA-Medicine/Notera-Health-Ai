#!/usr/bin/env node
// Why does a stored recording decode badly? Downloads it, runs ffmpeg on it and prints what ffmpeg says (never the audio or the transcript).
//   docker exec -w /app/packages/backend notera-backend node tools/audio-probe.mjs <flag-substring|consultId> [limit]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { query } from '../src/db/pool.js';
const arg = process.argv[2] || 'cannot be decoded'; const limit = Number(process.argv[3]) || 3;
const rows = await query(`SELECT c.consult_id, c.audio_uri, r.bytes, r.duration_s, r.flags FROM clinical.consults c JOIN ops.audio_review r ON r.consult_id = c.consult_id WHERE c.consult_id = $1 OR $1 = ANY(r.flags) OR ($1 = 'ok' AND cardinality(r.flags) = 0) ORDER BY r.bytes DESC LIMIT $2`, [arg, limit]);
const { Storage } = await import('@google-cloud/storage'); const bucket = new Storage().bucket(process.env.GCS_AUDIO_BUCKET);
for (const r of rows) {
  const name = r.audio_uri.replace(`gs://${process.env.GCS_AUDIO_BUCKET}/`, ''); const [buf] = await bucket.file(name).download(); const f = `/tmp/probe-${r.consult_id}.webm`; fs.writeFileSync(f, buf);
  const t0 = Date.now(); const p = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 });
  const err = String(p.stderr || '').split('\n').filter(Boolean);
  const dur = err.find((l) => /Duration:/.test(l)); const time = [...err].reverse().find((l) => /time=\d/.test(l));
  const head = buf.subarray(0, 4).toString('hex'); const headers = (buf.toString('latin1').match(/\x1a\x45\xdf\xa3/g) || []).length;
  console.log(JSON.stringify({ id: r.consult_id, kb: Math.round(buf.length / 1024), analysedDuration: r.duration_s, ffmpegExit: p.status, signal: p.signal, ms: Date.now() - t0, startsWith: head, webmHeaders: headers, duration: dur?.trim().slice(0, 60), decoded: time?.trim().slice(0, 70), lastLines: err.slice(-3).map((l) => l.slice(0, 120)) }));
  fs.unlinkSync(f);
}
process.exit(0);
