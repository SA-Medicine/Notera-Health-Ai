// ASR audio helpers: browser containers in, 16 kHz mono 16-bit PCM out.
//
// Decoding to raw PCM does two jobs for us: Google Speech needs LINEAR16 to be told an
// exact sample rate, and the byte count gives the EXACT duration — MediaRecorder's
// WebM/Opus container carries none, which is why short clips used to be rejected as
// "sync input too long". The exact duration is also what lets long audio be split into
// windows that fit the API's synchronous limit.
//
// These helpers intentionally never log audio bytes or transcript content.
'use strict';

import { spawn } from 'node:child_process';

// Decoding a 20s chunk takes well under a second; decoding a whole consult (sent when the
// client recovers segments that failed) takes proportionally longer. A flat ceiling killed
// the long case, so the budget scales with the input: base + per-MB, capped.
const FFMPEG_BASE_MS = () => Number(process.env.ASR_FFMPEG_TIMEOUT_MS || 45000);
const FFMPEG_PER_MB_MS = () => Number(process.env.ASR_FFMPEG_PER_MB_MS || 4000);
const FFMPEG_MAX_MS = () => Number(process.env.ASR_FFMPEG_MAX_TIMEOUT_MS || 600000);

export function ffmpegTimeoutMs(bytes = 0) {
  const mb = Math.max(0, bytes) / (1024 * 1024);
  return Math.min(FFMPEG_MAX_MS(), FFMPEG_BASE_MS() + Math.round(mb * FFMPEG_PER_MB_MS()));
}

function runFfmpeg(args, inputBuf = null) {
  const timeoutMs = ffmpegTimeoutMs(inputBuf ? inputBuf.length : 0);
  return new Promise((resolve, reject) => {
    let ff;
    try { ff = spawn('ffmpeg', args); }
    catch (e) { return reject(new Error('ffmpeg unavailable')); }

    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ff.kill('SIGKILL');
      reject(new Error(`ffmpeg conversion timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(e?.message || 'ffmpeg failed'));
    });
    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(out));
      const detail = Buffer.concat(err).toString('utf8').trim().slice(0, 240);
      reject(new Error(detail ? `ffmpeg conversion failed: ${detail}` : 'ffmpeg conversion failed'));
    });
    if (inputBuf) {
      ff.stdin.on('error', () => {});
      ff.stdin.write(inputBuf);
      ff.stdin.end();
    } else {
      ff.stdin.end();
    }
  });
}

export function extractMultipartFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const header = buf.slice(start, headerEnd).toString('utf8');
    const next = buf.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    if (/name="file"|filename=/i.test(header)) return buf.slice(headerEnd + 4, next - 2);
    start = next;
  }
  return null;
}

/**
 * Decode any browser audio container to headerless 16 kHz mono 16-bit little-endian PCM.
 * Returns null when ffmpeg is unavailable or the input cannot be decoded, so the caller
 * can fall back to sending the container as-is.
 * @param {Buffer} inputBuf
 * @returns {Promise<Buffer|null>}
 */
/**
 * Is ffmpeg callable? Checked at startup because without it long audio CANNOT be
 * windowed: the handler falls back to sending the raw container, which is limited to
 * what synchronous recognize accepts (~60s). That makes long recordings fail again, so
 * it must be loud in the logs rather than a silent per-request downgrade.
 */
export function ffmpegAvailable() {
  return new Promise((resolve) => {
    let ff;
    try { ff = spawn('ffmpeg', ['-hide_banner', '-version']); }
    catch { return resolve(false); }
    let out = '';
    ff.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ff.stderr.on('data', () => {});
    ff.on('error', () => resolve(false));
    ff.on('close', (code) => resolve(code === 0 ? (out.split('\n')[0] || 'ffmpeg').trim() : false));
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } resolve(false); }, 5000);
  });
}

export async function transcodePcm16k(inputBuf) {
  try {
    return await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ], inputBuf);
  } catch {
    return null;
  }
}
