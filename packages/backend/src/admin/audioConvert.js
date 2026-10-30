// Recordings are stored as WebM (Opus), what the browser records. For download the admin can get them as MP4 (AAC audio), which plays everywhere.
// ffmpeg writes to a temp file (an MP4 needs a seekable output), which is read back and removed. A recording ffmpeg cannot read is returned unchanged by the caller.
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function webmToMp4(input, { timeoutMs = 90_000 } = {}) {
  const out = path.join(os.tmpdir(), `notera-${crypto.randomBytes(6).toString('hex')}.mp4`);
  return new Promise((resolve, reject) => {
    let ff; let err = '';
    try { ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', out]); }
    catch (e) { return reject(e); }
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    ff.stderr.on('data', (d) => { err += d.toString('utf8').slice(0, 400); });
    ff.stdin.on('error', () => { /* ffmpeg closed early: the exit code tells */ });
    ff.on('error', (e) => { fs.rm(out, { force: true }, () => {}); done(reject, e); });
    ff.on('close', (code) => {
      if (code !== 0) { fs.rm(out, { force: true }, () => {}); return done(reject, new Error(`ffmpeg exit ${code}: ${err.trim()}`)); }
      fs.readFile(out, (e, buf) => { fs.rm(out, { force: true }, () => {}); e ? done(reject, e) : done(resolve, buf); });
    });
    ff.stdin.end(input);
  });
}
