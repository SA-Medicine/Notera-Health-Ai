// Persistent local faster-whisper worker. Node keeps one Python process alive so
// large-v3-turbo is loaded once and reused across ASR requests.
'use strict';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'local_whisper_worker.py');

const rid = () => Math.random().toString(36).slice(2, 10);

function asBool(v, fallback) {
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function languageForWhisper() {
  const raw = process.env.ASR_WHISPER_LANGUAGE || process.env.ASR_LANGUAGE || 'en';
  return String(raw).toLowerCase().split(/[-_]/)[0] || 'en';
}

class LocalWhisperWorker {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.readyPromise = null;
    this.pending = new Map();
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.start();
  }

  start() {
    if (this.proc) return;
    const python = process.env.ASR_PYTHON || (process.platform === 'win32' ? 'python' : '/opt/notera-asr-venv/bin/python');
    this.readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this.proc = spawn(python, [WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.proc.stdout.on('data', (d) => this.onStdout(d));
    this.proc.stderr.on('data', (d) => this.onStderr(d));
    this.proc.on('error', (e) => this.failAll(e));
    this.proc.on('exit', (code, signal) => this.failAll(new Error(`local Whisper worker exited (${signal || code})`)));
  }

  onStdout(d) {
    this.stdoutBuf += d.toString('utf8');
    for (;;) {
      const idx = this.stdoutBuf.indexOf('\n');
      if (idx === -1) break;
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'ready') {
        this.ready = msg;
        this._readyResolve?.(msg);
        continue;
      }
      const pending = this.pending.get(msg.request_id);
      if (!pending) continue;
      this.pending.delete(msg.request_id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg);
      else pending.reject(new Error(msg.error || 'local Whisper transcription failed'));
    }
  }

  onStderr(d) {
    this.stderrBuf += d.toString('utf8');
    for (;;) {
      const idx = this.stderrBuf.indexOf('\n');
      if (idx === -1) break;
      const line = this.stderrBuf.slice(0, idx).trim();
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      if (line) console.warn(`[asr:whisper] ${line}`);
    }
  }

  failAll(err) {
    this.proc = null;
    this.ready = null;
    this._readyReject?.(err);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  async transcribe(audioPath, meta = {}) {
    this.start();
    await this.readyPromise;
    const requestId = meta.requestId || rid();
    const timeoutMs = Number(process.env.ASR_TIMEOUT_MS || 180000);
    const payload = {
      type: 'transcribe',
      request_id: requestId,
      audio_path: audioPath,
      language: languageForWhisper(),
      beam_size: Number(process.env.ASR_WHISPER_BEAM_SIZE || 5),
      vad_filter: asBool(process.env.ASR_WHISPER_VAD_FILTER, true),
      condition_on_previous_text: asBool(process.env.ASR_WHISPER_CONDITION_ON_PREVIOUS_TEXT, true),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('local Whisper transcription timed out'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }
}

let singleton = null;

export async function preloadLocalWhisper() {
  singleton = singleton || new LocalWhisperWorker();
  return singleton.readyPromise;
}

export async function transcribeLocalAudioFile(audioPath, meta = {}) {
  singleton = singleton || new LocalWhisperWorker();
  return singleton.transcribe(audioPath, meta);
}

export function localWhisperEnabled() {
  return (process.env.ASR_PROVIDER || 'google').toLowerCase() === 'whisper_local';
}
