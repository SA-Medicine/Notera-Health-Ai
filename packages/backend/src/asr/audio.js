// ASR audio helpers: browser containers in, normalized 16 kHz mono PCM WAV out.
// These helpers intentionally never log audio bytes or transcript content.
'use strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FFMPEG_TIMEOUT_MS = () => Number(process.env.ASR_FFMPEG_TIMEOUT_MS || 45000);

function runFfmpeg(args, inputBuf = null) {
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
      reject(new Error('ffmpeg conversion timed out'));
    }, FFMPEG_TIMEOUT_MS());

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

export async function transcodePcm16k(inputBuf) {
  try {
    return await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
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

async function secureTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notera-asr-'));
  try { await fs.chmod(dir, 0o700); } catch { /* Windows or restricted FS */ }
  return dir;
}

function wavDurationFromSize(bytes) {
  return Math.max(0, (Math.max(0, bytes - 44) / 2 / 16000));
}

async function normalizeToWav(args, inputBuf = null) {
  const tmpDir = await secureTempDir();
  const wavPath = path.join(tmpDir, 'audio.wav');
  try {
    await runFfmpeg([...args, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', '-y', wavPath], inputBuf);
    const stat = await fs.stat(wavPath);
    return { tmpDir, wavPath, durationSeconds: wavDurationFromSize(stat.size), bytes: stat.size };
  } catch (e) {
    await cleanupTempDir(tmpDir);
    throw e;
  }
}

export async function normalizeBufferToWav16k(inputBuf) {
  return normalizeToWav(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0'], inputBuf);
}

export async function normalizeFileToWav16k(inputPath) {
  return normalizeToWav(['-hide_banner', '-loglevel', 'error', '-i', inputPath]);
}

export async function cleanupTempDir(dir) {
  if (!dir) return;
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
