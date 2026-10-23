#!/usr/bin/env node
// Repairs stored recordings that start with stray bytes in front of the real file header (the six damaged recordings of 8 Sep 2026).
//   docker exec -w /app/packages/backend notera-backend node tools/audio-repair.mjs            -> dry run: shows what would change
//   docker exec -w /app/packages/backend notera-backend node tools/audio-repair.mjs --apply    -> writes the repaired file back to the same object
// A file is only replaced when the cut version really decodes with ffmpeg and is longer than 20 s. The bucket keeps the replaced object for 7 days
// (soft delete), so the original can be restored. Review status, notes and transcripts are not touched; the recording is measured again afterwards.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { query } from '../src/db/pool.js';
import { repairWebm } from '../src/admin/audioStats.js';

const apply = process.argv.includes('--apply');
const bucketName = process.env.GCS_AUDIO_BUCKET;
const rows = await query(`SELECT c.consult_id, c.audio_uri FROM clinical.consults c JOIN ops.audio_review r USING (consult_id) WHERE c.audio_uri LIKE 'gs://%'`);
const { Storage } = await import('@google-cloud/storage'); const bucket = new Storage().bucket(bucketName);
let fixed = 0, skipped = 0;
for (const r of rows) {
  const name = r.audio_uri.replace(`gs://${bucketName}/`, ''); const file = bucket.file(name);
  const [buf] = await file.download(); const rep = repairWebm(buf);
  if (!rep.trimmed) { skipped++; continue; }
  const tmp = `/tmp/repair-${r.consult_id}.webm`; fs.writeFileSync(tmp, rep.buf);
  const p = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', tmp, '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 180000 });
  fs.unlinkSync(tmp);
  const t = [...String(p.stderr || '').split('\n')].reverse().find((l) => /time=\d/.test(l)) || ''; const m = t.match(/time=(\d+):(\d+):(\d+)/); const secs = m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
  const good = p.status === 0 && secs >= 20;
  console.log(JSON.stringify({ id: r.consult_id, cutBytes: rep.trimmed, kbBefore: Math.round(buf.length / 1024), kbAfter: Math.round(rep.buf.length / 1024), decodes: p.status === 0, seconds: secs, action: !good ? 'skipped (does not decode cleanly)' : apply ? 'repaired' : 'would repair' }));
  if (!good || !apply) continue;
  await file.save(rep.buf, { contentType: 'audio/webm', resumable: false });
  await query(`UPDATE ops.audio_review SET analysed_at = NULL, duration_s = NULL, level = NULL, words = NULL, wpm = NULL, flags = '{}', bytes = $2 WHERE consult_id = $1`, [r.consult_id, rep.buf.length]);
  fixed++;
}
console.log(JSON.stringify({ checked: rows.length, alreadyFine: skipped, repaired: fixed, apply }));
process.exit(0);
