'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './scribe.css';
import Onboarding from './Onboarding';

// All backend calls go through the same-origin /backend proxy (cookies stay first-party).
const API = '/backend';
const SEGMENT_MS = 20_000;   // 20s chunks: well under Google's 60s sync cap even with WebM/Opus
const EMPTY_SEG_LIMIT = 9;   // audio safety: 9 consecutive SILENT 20s chunks (~3 min). Only counts
                             // chunks that transcribed successfully with no speech — a failed
                             // request is a failure, not silence — and only discards the session
                             // when no speech was ever captured (mic left on by mistake).
const CHUNK_RETRIES = 3;                       // per-segment ASR retries before giving up on it
const CHUNK_RETRY_MS = [1_000, 4_000, 10_000]; // backoff between those retries
const ASR_REQUEST_TIMEOUT_MS = 30_000;          // a 20s chunk answers in ~1-3s; a hung request must not hold a slot
const MAX_INFLIGHT = 3;                        // concurrent ASR requests (the backend queues too)

// One recorded 20s window and what came back for it.
type Segment = {
  status: 'pending' | 'done' | 'failed';
  text: string;
  offsetMs: number;     // start offset within the session, for the transcript timestamp
  attempts: number;
  blob: Blob | null;    // retained only while the segment still needs transcribing
};

const SPECIALTIES = [
  'general_primary_care', 'musculoskeletal', 'diabetes', 'hypertension', 'mental_health',
  'dermatology', 'gynecology', 'pediatrics', 'weight_loss', 'medication_refill',
];

type Panel = 'context' | 'transcript' | 'note' | 'history' | 'paste';
type Phase = 'idle' | 'recording' | 'transcribing' | 'generating' | 'done';
type Line = { t: string; text: string };
type HistItem = { consult_id: string; title: string | null; specialty: string | null; status: string; audio_uri: string | null; created_at: string };

const mmss = (secs: number) => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

// Safely read a JSON response. If the backend proxy is misconfigured the request
// falls through to Next's HTML 404 page, so guard against parsing "<!DOCTYPE …".
async function readJson(r: Response): Promise<any> {
  const ct = r.headers.get('content-type') || '';
  const body = await r.text();
  if (!ct.includes('application/json')) {
    throw new Error(r.ok ? 'Backend returned a non-JSON response (is the API reachable?).' : `Request failed (${r.status}).`);
  }
  try { return JSON.parse(body); } catch { throw new Error('Backend returned an invalid response.'); }
}

// simple, safe markdown → HTML (headings, bold, lists, line breaks)
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc(md || '').split('\n'); const out: string[] = []; let inList = false;
  for (const ln of lines) {
    // Numbered A&P problem heading: "1. **Title**" → keep the number inside the bold
    // so the whole "1. Title" stays on one line (the stylesheet block-displays a
    // leading <strong>, which otherwise orphans the bare "1." on its own line).
    const numHead = ln.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/);
    if (numHead) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<p class="ap-head"><strong>${numHead[1]}. ${numHead[2]}</strong></p>`); continue; }
    if (/^\s*[-*]\s+/.test(ln)) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + ln.replace(/^\s*[-*]\s+/, '') + '</li>'); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    if (/^#{1,6}\s/.test(ln)) { const h = ln.match(/^#+/)![0].length; out.push(`<h${h}>` + ln.replace(/^#+\s/, '') + `</h${h}>`); continue; }
    if (!ln.trim()) { out.push('<br/>'); continue; }
    out.push('<p>' + ln + '</p>');
  }
  if (inList) out.push('</ul>');
  return out.join('').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// tiny inline icons
const I = {
  mic: <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2H3v2a9 9 0 008 8.94V23h2v-2.06A9 9 0 0021 12v-2z" /></svg>,
  micStroke: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>,
  bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>,
  cal: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>,
  doc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>,
  lines: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" /></svg>,
  moon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
  chevronD: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11"><polyline points="6 9 12 15 18 9" /></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20" /></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>,
  logout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>,
};

export default function Scribe() {
  const [panel, setPanel] = useState<Panel>('transcript');
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [transcript, setTranscript] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [specialty, setSpecialty] = useState('auto');
  const [patient, setPatient] = useState('');
  const [error, setError] = useState('');
  const [genStep, setGenStep] = useState(0);
  const [consultId, setConsultId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistItem[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [dark, setDark] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);
  const [ctx, setCtx] = useState({ age: '', sex: '', pmhx: '', meds: '' });
  const [me, setMe] = useState<{ fullName: string; email: string; initials: string } | null>(null);
  const [historyView, setHistoryView] = useState(false);   // true when a saved consult is opened from History
  const [pendingSegs, setPendingSegs] = useState(0);       // segments still being transcribed
  const [failedSegs, setFailedSegs] = useState(0);         // segments that never transcribed

  const streamRef = useRef<MediaStream | null>(null);
  const segRecRef = useRef<MediaRecorder | null>(null);
  const emptySegs = useRef(0);          // consecutive SILENT segments (failures don't count)
  const silenceAbort = useRef(false);   // true once the silence watchdog has fired this session
  const fullRecRef = useRef<MediaRecorder | null>(null);
  const fullChunks = useRef<Blob[]>([]);
  const fullBlob = useRef<Blob | null>(null);
  const fullMime = useRef('audio/webm');
  const segMime = useRef('audio/webm');
  const segments = useRef<Map<number, Segment>>(new Map());   // index → segment (ordered transcript)
  const segSeq = useRef(0);             // next segment index
  const segQueue = useRef<number[]>([]);// indices waiting for an ASR slot
  const inFlight = useRef(0);           // ASR requests currently open
  const retryWaiting = useRef(0);        // segments sleeping before a retry (not in a slot)
  const captureLive = useRef(false);    // a segment recorder is still open
  const finishing = useRef(false);      // maybeFinish() already ran for this session
  const stopping = useRef(false);
  const startTs = useRef(0);
  const segTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef('');
  const noteBodyRef = useRef<HTMLDivElement | null>(null);

  const flash = (msg: string, kind: 'success' | 'error' = 'success') => { setToast({ msg, kind }); setTimeout(() => setToast(null), 2600); };

  const setTx = (v: string | ((p: string) => string)) =>
    setTranscript((prev) => { const n = typeof v === 'function' ? (v as (p: string) => string)(prev) : v; transcriptRef.current = n; return n; });

  // dark mode ↔ body class (scribe.css uses body.dark-mode)
  useEffect(() => {
    document.body.classList.toggle('dark-mode', dark);
    return () => document.body.classList.remove('dark-mode');
  }, [dark]);

  // render note into the contenteditable body when not editing
  useEffect(() => {
    if (!editing && noteBodyRef.current) noteBodyRef.current.innerHTML = mdToHtml(note);
  }, [note, editing]);

  // recording timer
  useEffect(() => {
    if (phase === 'recording') {
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startTs.current) / 1000)), 1000);
    } else if (timerRef.current) { clearInterval(timerRef.current); }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  const loadHistory = useCallback(async () => {
    try { const r = await fetch(`${API}/api/library/consults`, { credentials: 'include' }); if (r.ok) setHistory((await readJson(r)).consults || []); } catch { /* */ }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Report uncaught frontend errors to the ops log (no PHI — message/stack/route only).
  useEffect(() => {
    const post = (code: string, message: string, stack?: string) => {
      fetch(`${API}/api/ops/client-error`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, message: String(message).slice(0, 500), stack: stack?.slice(0, 4000), route: location.pathname }),
      }).catch(() => {});
    };
    const onErr = (e: ErrorEvent) => post('CLIENT_JS', e.message, e.error?.stack);
    const onRej = (e: PromiseRejectionEvent) => post('CLIENT_UNHANDLED', String(e.reason?.message || e.reason), e.reason?.stack);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => { window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onRej); };
  }, []);

  useEffect(() => {
    fetch(`${API}/api/auth/me`, { credentials: 'include' })
      .then((r) => r.ok ? readJson(r) : null)
      .then((d) => {
        const u = d?.user;
        if (!u) return;
        const name = u.full_name || u.fullName || u.email || 'Clinician';
        const parts = name.trim().split(/\s+/);
        const initials = parts.length >= 2
          ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
          : name.slice(0, 2).toUpperCase();
        setMe({ fullName: name, email: u.email || '', initials });
      })
      .catch(() => {});
  }, []);

  async function logout() {
    try {
      await fetch(`${API}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch { /* */ }
    window.location.href = '/login';
  }

  // ── Segment transcription ──────────────────────────────────────────────────
  // Each 20s segment is transcribed on its own, but results arrive out of order:
  // under load one chunk can take far longer than the next, and the old code simply
  // appended whatever finished first, scrambling the transcript the note is written
  // from. Segments are therefore keyed by their INDEX and the transcript is always
  // rendered in index order.
  async function transcribeBlob(blob: Blob): Promise<string> {
    if (!blob.size) return '';
    const r = await fetch(`${API}/api/asr`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': blob.type }, body: blob, signal: AbortSignal.timeout(ASR_REQUEST_TIMEOUT_MS) });
    if (!r.ok) { const d = await readJson(r).catch(() => ({} as any)); throw new Error(d?.hint || d?.error || 'Transcription failed'); }
    const d = await readJson(r);
    return (d.text || d.transcript || '').trim();
  }

  // Re-render the transcript from the segment map, ordered by segment index.
  function renderSegments() {
    const ordered = [...segments.current.entries()].sort((a, b) => a[0] - b[0]);
    const rows: Line[] = [];
    for (const [, seg] of ordered) {
      if (seg.status !== 'done' || !seg.text) continue;
      rows.push({ t: mmss(seg.offsetMs / 1000), text: seg.text });
    }
    setLines(rows);
    setTx(rows.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim());
    setPendingSegs([...segments.current.values()].filter((s) => s.status === 'pending').length);
    setFailedSegs([...segments.current.values()].filter((s) => s.status === 'failed').length);
  }

  // Transcribe one segment, retrying transient failures. A failure is NOT silence:
  // the old code counted every error toward the silence watchdog, so a run of server
  // timeouts on a long consult looked like an empty room and wiped the whole session.
  async function transcribeSegment(index: number) {
    const seg = segments.current.get(index);
    if (!seg || !seg.blob) return;
    const blob = seg.blob;
    try {
      const text = await transcribeBlob(blob);
      seg.status = 'done';
      seg.text = text;
      seg.blob = null;                      // free the audio once it is transcribed
      if (text) emptySegs.current = 0;
      else countEmptySegment();
      renderSegments();
    } catch (e) {
      const attempt = seg.attempts || 0;
      seg.attempts = attempt + 1;
      if (attempt >= CHUNK_RETRIES) {
        // Keep the segment marked failed (and its audio) so the post-recording
        // full-audio pass can recover what it said. Never surface this as a hard
        // error and never discard the session over it.
        seg.status = 'failed';
        renderSegments();
        console.warn(`ASR segment ${index} failed after ${attempt + 1} attempts:`, (e as Error).message);
        return;
      }
      // Back off OUTSIDE the concurrency slot: sleeping in here used to hold one of the
      // in-flight slots, so two failing chunks stalled every later chunk.
      retryWaiting.current += 1;
      setTimeout(() => {
        retryWaiting.current -= 1;
        segQueue.current.push(index);
        drainSegQueue();
        maybeFinish();
      }, CHUNK_RETRY_MS[attempt] ?? 5000);
    }
  }

  // Client-side concurrency limit. The backend has no ASR queue (each request decodes and
  // recognises on its own), so firing every segment at once only deepens contention.
  function enqueueSegment(index: number) {
    segQueue.current.push(index);
    drainSegQueue();
  }
  function drainSegQueue() {
    while (inFlight.current < MAX_INFLIGHT && segQueue.current.length) {
      const index = segQueue.current.shift()!;
      inFlight.current += 1;
      transcribeSegment(index).finally(() => {
        inFlight.current -= 1;
        drainSegQueue();
        maybeFinish();
      });
    }
  }

  // A segment that transcribed successfully but contained no speech. Only these count
  // toward the silence watchdog.
  function countEmptySegment() {
    if (stopping.current) return;
    emptySegs.current += 1;
    if (emptySegs.current < EMPTY_SEG_LIMIT) return;
    // Mic left on by mistake (nothing captured at all) → stop and discard, which is
    // the whole point of the watchdog. If real speech WAS captured, the quiet stretch
    // is part of the consult (a long examination, a phone call) — keep recording.
    const hasSpeech = [...segments.current.values()].some((s) => s.status === 'done' && s.text);
    if (!hasSpeech) { abortForSilence(); return; }
    emptySegs.current = 0;
    flash('No speech detected for a few minutes — still recording.', 'error');
  }

  function abortForSilence() {
    if (silenceAbort.current) return;                 // fire once
    silenceAbort.current = true;
    stopping.current = true;
    emptySegs.current = 0;
    teardownCapture();
    segments.current.clear();
    segQueue.current = [];
    fullChunks.current = []; fullBlob.current = null;  // discard the silent audio — nothing saved
    setLines([]); setTx(''); setElapsed(0); setPendingSegs(0); setFailedSegs(0); setPhase('idle');
    flash('Recording stopped — no speech detected for about 3 minutes. Nothing was saved.', 'error');
    fetch(`${API}/api/ops/audio-event`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consultId, reason: 'silence_timeout', meta: { emptySegments: EMPTY_SEG_LIMIT } }),
    }).catch(() => {});
  }

  function teardownCapture() {
    if (segTimer.current) clearTimeout(segTimer.current);
    segTimer.current = null;
    if (stallTimer.current) clearInterval(stallTimer.current);
    stallTimer.current = null;
    try { segRecRef.current?.stop(); } catch { /* */ }
    segRecRef.current = null;
    try { if (fullRecRef.current && fullRecRef.current.state !== 'inactive') fullRecRef.current.stop(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    streamRef.current = null;
  }

  // Called whenever a segment settles. Once the user has stopped AND every segment has
  // settled, recover any failed segments from the full recording and finish.
  async function maybeFinish() {
    if (!stopping.current || silenceAbort.current || finishing.current) return;
    if (segQueue.current.length || inFlight.current > 0 || retryWaiting.current > 0) return;
    if (captureLive.current) return;                  // the final segment is still closing
    finishing.current = true;
    if (fullChunks.current.length) fullBlob.current = new Blob(fullChunks.current, { type: fullMime.current });
    await recoverFailedSegments();
    setPhase('done');
  }

  // SAFETY NET for long consults: if any segment never transcribed, send the WHOLE
  // recording once and use it when it recovers more than the per-segment transcript did.
  // This is what guarantees a 5-minute visit still produces a complete transcript even
  // when the ASR backend was briefly saturated.
  async function recoverFailedSegments() {
    const failed = [...segments.current.values()].filter((s) => s.status === 'failed');
    if (!failed.length || !fullBlob.current?.size) return;
    setPhase('transcribing');
    flash(`Recovering ${failed.length} segment${failed.length > 1 ? 's' : ''} from the full recording…`);
    try {
      const whole = await transcribeBlob(fullBlob.current);
      const partial = transcriptRef.current.trim();
      if (whole && whole.length > partial.length) {
        // Spread the recovered text back over sentences so the transcript keeps its
        // readable, roughly-timestamped shape instead of collapsing to one block. The
        // offsets are evenly spaced across the known recording length — approximate, and
        // labelled as such, but far more usable than a single 00:00 wall of text.
        const sentences = whole.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
        const totalMs = Math.max(1, Date.now() - startTs.current);
        segments.current.clear();
        sentences.forEach((text, i) => {
          segments.current.set(i, {
            status: 'done', text, attempts: 1, blob: null,
            offsetMs: Math.round((i / Math.max(1, sentences.length)) * totalMs),
          });
        });
        renderSegments();
        flash('Transcript recovered from the full recording (timings approximate)');
        return;
      }
      flash(`${failed.length} segment${failed.length > 1 ? 's' : ''} could not be transcribed — review the transcript before creating the note.`, 'error');
    } catch (e) {
      console.warn('full-audio recovery failed:', (e as Error).message);
      flash(`${failed.length} segment${failed.length > 1 ? 's' : ''} could not be transcribed — review the transcript before creating the note.`, 'error');
    }
  }

  // Start a MediaRecorder for the next segment. Rotation used to fail silently: if
  // constructing the recorder threw, the function simply returned, so capture ended
  // while the UI kept showing "Recording…" and counting up.
  function startNextSegment() {
    const stream = streamRef.current;
    if (!stream || stopping.current) return;

    const index = segSeq.current++;
    const offsetMs = Date.now() - startTs.current;
    const chunks: BlobPart[] = [];
    const preferred = segRecRef.current?.mimeType || segMime.current;
    let rec: MediaRecorder | null = null;
    for (const mime of [preferred, 'audio/webm', '']) {
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); break; }
      catch { /* try the next option */ }
    }
    if (!rec) {
      segSeq.current -= 1;
      setError('Recording stopped unexpectedly — the audio device rejected a new segment. Your transcript so far is kept.');
      stopRecording();
      return;
    }
    segRecRef.current = rec;
    segMime.current = rec.mimeType || 'audio/webm';
    captureLive.current = true;
    segments.current.set(index, { status: 'pending', text: '', offsetMs, attempts: 0, blob: null });

    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    rec.onstop = () => {
      const seg = segments.current.get(index);
      const blob = chunks.length ? new Blob(chunks, { type: segMime.current }) : null;
      if (!seg) return;
      if (!blob || blob.size < 1000) {
        // Nothing usable in this window — treat it as genuine silence, not a failure.
        seg.status = 'done';
        seg.text = '';
        countEmptySegment();
        renderSegments();
      } else {
        seg.blob = blob;
        enqueueSegment(index);
      }
      if (stopping.current && segRecRef.current === rec) {
        captureLive.current = false;
        maybeFinish();
      }
    };

    try { rec.start(); } catch {
      segments.current.delete(index);
      captureLive.current = false;
      setError('Recording stopped unexpectedly — the microphone became unavailable. Your transcript so far is kept.');
      stopRecording();
      return;
    }

    // Rotate after SEGMENT_MS: start the next recorder FIRST so there is no audio gap,
    // then close this one so its window is transcribed exactly once.
    segTimer.current = setTimeout(() => {
      if (stopping.current) return;
      startNextSegment();
      try { rec!.stop(); } catch { /* */ }
    }, SEGMENT_MS);
  }

  // Stop capture, keeping everything recorded so far. Pending segments keep
  // transcribing; maybeFinish() moves to 'done' once they all settle.
  function stopRecording() {
    if (stopping.current) return;
    stopping.current = true;
    setPhase('transcribing');
    if (segTimer.current) clearTimeout(segTimer.current);
    segTimer.current = null;
    if (stallTimer.current) clearInterval(stallTimer.current);
    stallTimer.current = null;
    const rec = segRecRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { captureLive.current = false; }
    } else {
      captureLive.current = false;
    }
    try { if (fullRecRef.current && fullRecRef.current.state !== 'inactive') fullRecRef.current.stop(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    streamRef.current = null;
    maybeFinish();
  }

  async function toggleRecord() {
    if (phase === 'recording') { stopRecording(); return; }
    setError(''); setNote(''); setConsultId(null); setLines([]); setTx(''); setElapsed(0); setHistoryView(false);
    setPendingSegs(0); setFailedSegs(0);
    emptySegs.current = 0; silenceAbort.current = false; finishing.current = false;
    segments.current.clear(); segQueue.current = []; inFlight.current = 0; segSeq.current = 0;
    segMime.current = 'audio/webm';
    setPanel('transcript');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream; stopping.current = false; startTs.current = Date.now();
      fullChunks.current = []; fullBlob.current = null;
      try {
        const fr = new MediaRecorder(stream); fullRecRef.current = fr;
        fullMime.current = fr.mimeType || 'audio/webm';
        fr.ondataavailable = (e) => { if (e.data.size) fullChunks.current.push(e.data); };
        fr.start(1000);
      } catch { fullRecRef.current = null; }
      setPhase('recording');
      startNextSegment();
      // Capture-stall watchdog: if the segment recorder dies without firing onstop
      // (device change, tab throttling, a driver hiccup), restart it instead of
      // leaving the UI "recording" with nothing being captured.
      stallTimer.current = setInterval(() => {
        if (stopping.current) return;
        const rec = segRecRef.current;
        if (!rec || rec.state === 'inactive') {
          console.warn('segment recorder stalled — restarting capture');
          startNextSegment();
        }
      }, SEGMENT_MS);
    } catch { setError('Microphone unavailable — paste a transcript below instead.'); }
  }

  function loadPastedTranscript() {
    const t = pasteText.trim(); if (!t) return;
    setHistoryView(false);
    setTx(t); setLines(t.split(/(?<=[.!?])\s+/).filter(Boolean).map((s, i) => ({ t: mmss(i * 5), text: s })));
    setPhase('done'); setPasteText(''); setPanel('transcript');
    flash('Transcript loaded');
  }

  function buildTranscript(): string {
    const parts: string[] = [];
    const c: string[] = [];
    if (ctx.age) c.push(`Age: ${ctx.age}`);
    if (ctx.sex) c.push(`Sex: ${ctx.sex}`);
    if (ctx.pmhx) c.push(`PMHx: ${ctx.pmhx}`);
    if (ctx.meds) c.push(`Current medications: ${ctx.meds}`);
    if (c.length) parts.push('[Patient context] ' + c.join('; '));
    parts.push(transcriptRef.current.trim());
    return parts.join('\n');
  }

  async function createSOAP() {
    // Guard: once a note is generated, the user must start a new session
    if (note) {
      setError('A note has already been created for this session. Start a new session to generate another.');
      setPanel('note');
      return;
    }
    // On a long consult the last segments can still be transcribing when the clinician
    // hits Create. Generating now would write the note from a truncated transcript, so
    // wait for them (up to 4 minutes) rather than silently losing the tail.
    if (segQueue.current.length || inFlight.current > 0 || retryWaiting.current > 0 || captureLive.current) {
      setPanel('transcript');
      flash('Finishing transcription before writing the note…');
      const deadline = Date.now() + 4 * 60_000;
      while ((segQueue.current.length || inFlight.current > 0 || retryWaiting.current > 0 || captureLive.current) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!transcriptRef.current.trim()) { setError('Record or paste a transcript first.'); setPanel('transcript'); return; }
    setError(''); setEditing(false); setPhase('generating'); setGenStep(0); setPanel('note');
    const stepper = setInterval(() => setGenStep((s) => Math.min(s + 1, 3)), 3500);
    // Async job + polling: the pipeline can run >100s on long transcripts, which would die at
    // Cloudflare's edge timeout if we held one long request. Instead we kick off a background
    // job and poll a tiny status endpoint every 3s for up to 5 minutes — no request ever
    // approaches the edge timeout, so there is effectively no client-side timeout.
    const POLL_MS = 3_000, MAX_WAIT_MS = 8 * 60_000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const meRes = await fetch(`${API}/api/auth/me`, { credentials: 'include' }).then((r) => r.ok ? readJson(r) : null).catch(() => null);
      const start = await fetch(`${API}/api/consults/async`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: buildTranscript(), specialty, noteType: 'consultation', clinicianId: meRes?.user?.id || 'clinician' }),
      });
      const startBody = await readJson(start);
      if (!start.ok || !startBody?.jobId) throw new Error(startBody?.error || 'Could not start note generation');
      const jobId = startBody.jobId as string;
      // Poll until the job finishes (or errors, or we hit the 5-minute ceiling).
      let d: any = null; const t0 = Date.now();
      for (;;) {
        await sleep(POLL_MS);
        const pr = await fetch(`${API}/api/consults/job/${jobId}`, { credentials: 'include' }).catch(() => null);
        const pj = pr ? await readJson(pr).catch(() => null) : null;
        if (pj?.status === 'done') { d = pj.result; break; }
        if (pj?.status === 'error') throw new Error(pj.error || 'Note generation failed');
        if (Date.now() - t0 > MAX_WAIT_MS) throw new Error('Note generation is taking longer than 8 minutes — it may still finish; check History shortly.');
        // status 'pending' (or a transient network blip) → keep polling
      }
      const md = d.renderedNote || d.rawRenderedNote || '';
      setNote(md); setConsultId(d.consultId || null); setPhase('done');
      flash('Note generated');
      const cid = d.consultId;
      const resolvedSpec = (specialty === 'auto' ? (d.detectedSpecialty || 'consult') : specialty) as string;
      if (cid) {
        fetch(`${API}/api/library/consults`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consultId: cid, transcript: transcriptRef.current.trim(), renderedNote: md, title: patient || `${resolvedSpec.replace(/_/g, ' ')} · ${new Date().toLocaleDateString()}`, specialty: resolvedSpec, noteType: 'consultation', status: 'ready' }),
        })
          .then(() => { if (fullBlob.current?.size) return fetch(`${API}/api/library/consults/${cid}/audio`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': fullBlob.current!.type }, body: fullBlob.current! }); })
          .then(() => loadHistory()).catch(() => {});
      }
    } catch (e) {
      const msg = (e as Error).message || 'Note generation failed';
      setError(msg); setPhase(transcriptRef.current ? 'done' : 'idle'); flash(msg, 'error');
      loadHistory();   // the backend may have finished after we gave up — surface it in History
    } finally {
      clearInterval(stepper);
    }
  }

  async function openConsult(id: string) {
    try {
      const r = await fetch(`${API}/api/library/consults/${id}`, { credentials: 'include' });
      const d = await readJson(r); const c = d.consult; if (!c) return;
      const draft = (c.drafts || [])[(c.drafts?.length || 1) - 1];
      setNote(draft?.rendered_note || draft?.note?.rendered || '');
      const savedTx: string = (c.transcript?.text) || '';
      setTx(savedTx);
      // Render the saved transcript as timestamped rows, exactly like the live transcript.
      const parts = savedTx.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
      const segs = (parts.length > 1 ? parts : savedTx.split(/(?<=[.!?])\s+/))
        .map((s) => s.trim()).filter(Boolean);
      setLines(segs.map((s, i) => ({ t: mmss(i * 5), text: s })));
      setConsultId(id); setPhase('done'); setEditing(false);
      setHistoryView(true);   // read-only saved transcript, not the live paste box
      setPanel('note');
    } catch { /* */ }
  }
  async function downloadAudio(id: string) {
    try { const r = await fetch(`${API}/api/library/consults/${id}/audio`, { credentials: 'include' }); const d = await readJson(r); if (d.url) window.open(d.url, '_blank'); else flash('No audio for this consult', 'error'); } catch { /* */ }
  }
  async function deleteConsult(id: string) {
    if (!confirm('Delete this consult?')) return;
    await fetch(`${API}/api/library/consults/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    loadHistory();
  }
  function newSession() {
    teardownCapture();
    segments.current.clear(); segQueue.current = []; inFlight.current = 0; segSeq.current = 0;
    stopping.current = false; captureLive.current = false; finishing.current = false;
    emptySegs.current = 0; silenceAbort.current = false;
    fullChunks.current = []; fullBlob.current = null;
    setPendingSegs(0); setFailedSegs(0);
    setPhase('idle'); setLines([]); setTx(''); setNote(''); setConsultId(null); setPatient(''); setElapsed(0); setEditing(false); setError(''); setHistoryView(false); setPasteText(''); setPanel('transcript');
  }

  function toggleEdit() {
    if (editing && noteBodyRef.current) setNote(noteBodyRef.current.innerText);
    setEditing((v) => !v);
  }
  const copy = (plain: boolean) => {
    const text = plain ? note.replace(/[#*_`>]/g, '').replace(/\n{3,}/g, '\n\n') : note;
    navigator.clipboard.writeText(text); flash(plain ? 'Copied for EMR' : 'Copied');
  };

  const genSteps = ['Extracting clinical facts', 'De-identifying & drafting', 'Structuring the SOAP note', 'Grounding & final check'];
  const recording = phase === 'recording';
  const dateStr = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`notera-shell${dark ? ' dark-mode' : ''}`}>
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-icon">{I.micStroke}</div>
            <span className="brand-name">Notera</span>
          </div>
        </div>
        <div className="sidebar-section">
          <button className="new-session-btn" data-tour="new" onClick={newSession}>{I.plus}<span>New session</span></button>
        </div>
        <nav className="sidebar-nav">
          <div className={`nav-item${panel === 'transcript' ? ' active' : ''}`} onClick={() => setPanel('transcript')}>{I.micStroke}<span>Scribe</span></div>
          <div className={`nav-item${panel === 'paste' ? ' active' : ''}`} data-tour="paste" onClick={() => setPanel('paste')}>{I.lines}<span>Paste transcript</span></div>
          <div className={`nav-item${panel === 'context' ? ' active' : ''}`} onClick={() => setPanel('context')}>{I.doc}<span>Context</span></div>
          <div className={`nav-item${panel === 'history' ? ' active' : ''}`} onClick={() => { setPanel('history'); loadHistory(); }}>{I.clock}<span>History</span></div>
        </nav>
        <div className="sidebar-spacer" />
        <nav className="sidebar-nav sidebar-nav-lower">
          <div className="nav-item" onClick={() => setDark((v) => !v)}>{I.settings}<span>{dark ? 'Light mode' : 'Dark mode'}</span></div>
          <div className="nav-item nav-item-logout" onClick={logout} title="Sign out">{I.logout}<span>Log out</span></div>
        </nav>
        <div className="user-profile">
          <div className="user-avatar">{me?.initials || 'DR'}</div>
          <div className="user-info">
            <div className="user-name">{me?.fullName || 'Clinician'}</div>
            <div className="user-email">{me?.email || 'Notera scribe'}</div>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        {/* Top bar */}
        <header className="top-bar">
          <div className="top-bar-left">
            <button className="trash-btn" title="New session" onClick={newSession}>{I.trash}</button>
            <div className="session-info">
              <div className="session-title-row">
                <input className="session-title-input" value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Add patient name / ID" />
                <div className={`rec-dot${recording ? ' recording' : phase === 'done' ? ' done' : ''}`} role="status" />
              </div>
              <div className="session-subtitle">{
                recording ? (pendingSegs ? `Recording… (${pendingSegs} segment${pendingSegs > 1 ? 's' : ''} transcribing)` : 'Recording…')
                  : phase === 'transcribing' ? (pendingSegs ? `Transcribing ${pendingSegs} segment${pendingSegs > 1 ? 's' : ''}…` : 'Finishing transcription…')
                  : phase === 'done' ? (failedSegs ? `Ready — ${failedSegs} segment${failedSegs > 1 ? 's' : ''} missing` : 'Ready')
                  : 'New consultation'
              }</div>
            </div>
            <div className="meta-pills">
              <div className="meta-pill">{I.cal}<span>{dateStr}</span></div>
              <div className="meta-pill">{I.globe}
                <select className="pill-select" value={specialty} onChange={(e) => setSpecialty(e.target.value)} aria-label="Specialty">
                  <option value="auto">Auto-detect</option>
                  {SPECIALTIES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
            </div>
          </div>
          <div className="top-bar-right">
            <button className="top-icon-btn" title="Toggle theme" onClick={() => setDark((v) => !v)}>{I.moon}</button>
            <button className="top-create-btn" onClick={createSOAP} data-tour="create"
              disabled={phase === 'generating' || !transcript.trim() || !!note}
              title={note ? 'Note already generated — start a new session' : ''}
              style={note ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            >
              {I.bolt}{phase === 'generating' ? 'Creating…' : note ? 'Note Created ✓' : 'Create SOAP'}{!note && I.chevronD}
            </button>
            <button className={`top-resume-btn${recording ? ' recording' : ''}`} data-tour="start" onClick={toggleRecord} disabled={phase === 'transcribing' || phase === 'generating'}>
              {I.mic}<span>{recording ? 'Stop' : phase === 'transcribing' ? 'Finishing…' : 'Start'}</span>
            </button>
            <div className="timer-block">{I.clock}<span className="timer-text">{mmss(elapsed)}</span></div>
            <div className="mic-block">
              {I.mic}
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Default mic</span>
              <div className={`audio-bars${recording ? ' active' : ''}`}>
                <div className="bar" /><div className="bar" /><div className="bar" /><div className="bar" /><div className="bar" />
              </div>
            </div>
          </div>
        </header>

        {/* Tab bar */}
        <nav className="tab-bar">
          <button className={`main-tab${panel === 'context' ? ' active' : ''}`} onClick={() => setPanel('context')}>{I.doc}Context</button>
          <button className={`main-tab${panel === 'transcript' ? ' active' : ''}`} onClick={() => setPanel('transcript')}>{I.lines}Transcript</button>
          <button className={`main-tab${panel === 'note' ? ' active' : ''}`} onClick={() => setPanel('note')}>{I.doc}Note</button>
          <button className={`main-tab${panel === 'history' ? ' active' : ''}`} onClick={() => { setPanel('history'); loadHistory(); }}>{I.clock}History</button>
        </nav>

        {error && <div style={{ padding: '8px 20px', background: 'var(--red-pale)', color: 'var(--red)', fontSize: 12.5, fontWeight: 600 }}>{error}</div>}

        <div className="panels-container">
          {/* Context */}
          <div className={`main-panel${panel === 'context' ? ' active' : ''}`}>
            <div className="context-form">
              <h2 className="context-form-title">Patient Context</h2>
              <p className="context-form-sub">Details here are injected into the AI to improve note accuracy.</p>
              <div className="context-form-group"><label>Age</label><input value={ctx.age} onChange={(e) => setCtx({ ...ctx, age: e.target.value })} placeholder="e.g. 45" /></div>
              <div className="context-form-group"><label>Sex</label><input value={ctx.sex} onChange={(e) => setCtx({ ...ctx, sex: e.target.value })} placeholder="e.g. Male" /></div>
              <div className="context-form-group"><label>Past Medical History (PMHx)</label><textarea rows={3} value={ctx.pmhx} onChange={(e) => setCtx({ ...ctx, pmhx: e.target.value })} placeholder="e.g. Hypertension, Type 2 diabetes…" /></div>
              <div className="context-form-group"><label>Current Medications</label><textarea rows={3} value={ctx.meds} onChange={(e) => setCtx({ ...ctx, meds: e.target.value })} placeholder="e.g. Lisinopril 10mg daily…" /></div>
            </div>
          </div>

          {/* Transcript */}
          <div className={`main-panel${panel === 'transcript' ? ' active' : ''}`}>
            <div className="transcript-header">
              <span className="transcript-label">{historyView ? 'Saved Transcript' : 'Live Transcript'}</span>
              <span className="seg-count">{[
                lines.length ? `${lines.length} segment${lines.length > 1 ? 's' : ''}` : '',
                pendingSegs ? `${pendingSegs} transcribing` : '',
                failedSegs ? `${failedSegs} failed` : '',
              ].filter(Boolean).join(' · ')}</span>
            </div>
            <div className="transcript-box">
              {historyView ? (
                lines.length ? (
                  <div id="transcriptLines">
                    {lines.map((l, i) => (
                      <div key={i} className="t-line"><span className="t-time">{l.t}</span><span className="t-text">{l.text}</span></div>
                    ))}
                  </div>
                ) : (
                  <div className="t-empty">
                    <div className="t-empty-icon">{I.lines}</div>
                    <p className="t-empty-title">No transcript was saved for this consult</p>
                  </div>
                )
              ) : lines.length === 0 && phase !== 'recording' ? (
                <div className="t-empty">
                  <div className="t-empty-icon">{I.micStroke}</div>
                  <p className="t-empty-title">Transcript will appear here as you record</p>
                  <p className="t-empty-sub">Press <strong>Start</strong> to record the visit — the transcript builds live as you talk.</p>
                  <button className="paste-link-btn" onClick={() => setPanel('paste')}>{I.lines}Have a transcript already? Paste it</button>
                </div>
              ) : (
                <div id="transcriptLines">
                  {lines.map((l, i) => (
                    <div key={i} className="t-line"><span className="t-time">{l.t}</span><span className="t-text">{l.text}</span></div>
                  ))}
                  {phase === 'recording' && <div className="t-line"><span className="t-time">•••</span><span className="t-text" style={{ color: 'var(--text-faint)' }}>Listening… speak now.</span></div>}
                  {phase === 'transcribing' && <div className="t-line"><span className="t-time">•••</span><span className="t-text" style={{ color: 'var(--text-faint)' }}>{pendingSegs ? `Transcribing ${pendingSegs} remaining segment${pendingSegs > 1 ? 's' : ''}…` : 'Finishing transcription…'}</span></div>}
                </div>
              )}
            </div>
          </div>

          {/* Paste transcript (its own screen — not shown by default) */}
          <div className={`main-panel${panel === 'paste' ? ' active' : ''}`}>
            <div className="paste-screen">
              <div className="paste-screen-head">
                <h2 className="paste-screen-title">Paste a transcript</h2>
                <p className="paste-screen-sub">Already have the consult text? Drop it in and Notera will turn it into a SOAP note — no recording needed.</p>
              </div>
              <div className="transcript-input-card paste-screen-card">
                <div className="transcript-input-header">{I.lines}<span>Consultation transcript</span></div>
                <textarea className="transcript-input-textarea" rows={12} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="Paste the full consultation transcript here…" spellCheck={false} />
                <div className="transcript-input-footer">
                  <span className="transcript-char-count">{pasteText.length} characters</span>
                  <button className="transcript-proceed-btn" onClick={loadPastedTranscript} disabled={!pasteText.trim()}>{I.bolt}Load transcript</button>
                </div>
              </div>
            </div>
          </div>

          {/* Note */}
          <div className={`main-panel${panel === 'note' ? ' active' : ''}`}>
            <div className="editor-toolbar">
              <div className="editor-toolbar-left">
                <button className="format-btn active">{I.bolt}SOAP</button>
              </div>
              <div className="editor-toolbar-right">
                {note && <button className="format-btn" onClick={toggleEdit} style={editing ? { background: 'var(--blue)', color: '#fff', borderColor: 'var(--blue)' } : undefined}>{editing ? 'Done' : 'Edit'}</button>}
                <div className="copy-group">
                  <button className="copy-btn" onClick={() => copy(true)} disabled={!note}>Copy to EMR</button>
                  <button className="copy-btn" onClick={() => copy(false)} disabled={!note} style={{ borderLeft: '1px solid rgba(255,255,255,0.1)', borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}>Copy</button>
                </div>
              </div>
            </div>
            <div className="note-scroll-area">
              {phase === 'generating' ? (
                <div className="note-empty">
                  <div className="spinner" style={{ borderTopColor: 'var(--blue)' }} />
                  <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
                    {genSteps.map((s, i) => (
                      <div key={i} style={{ fontSize: 13, color: i < genStep ? 'var(--green)' : i === genStep ? 'var(--text-primary)' : 'var(--text-faint)', fontWeight: i === genStep ? 700 : 500 }}>
                        {i < genStep ? '✓ ' : i === genStep ? '• ' : '   '}{s}
                      </div>
                    ))}
                  </div>
                </div>
              ) : note ? (
                <div className="note-content">
                  <div className="note-body" ref={noteBodyRef} contentEditable={editing} suppressContentEditableWarning spellCheck={false} style={editing ? { outline: '1px dashed var(--border-mid)', borderRadius: 8 } : undefined} />
                  <div className="note-done-banner">
                    ✓ Note saved to history — click <strong>New session</strong> in the sidebar to start another consult
                  </div>
                </div>
              ) : (
                <div className="note-empty">
                  {I.doc}
                  <p className="empty-note-title">No note generated yet</p>
                  <p className="empty-note-sub">Record or paste a transcript, then press <strong>Create SOAP</strong></p>
                  <button className="start-hint-btn" onClick={toggleRecord}>{I.mic}Start recording</button>
                </div>
              )}
            </div>
          </div>

          {/* History */}
          <div className={`main-panel${panel === 'history' ? ' active' : ''}`}>
            <div className="hist-header">
              <span className="hist-title">Session History</span>
              <button className="link-btn" onClick={loadHistory}>Refresh</button>
            </div>
            <div id="historyList" style={{ overflow: 'auto', padding: '4px 0' }}>
              {history.length === 0 ? (
                <div className="h-empty">{I.clock}<p>No sessions saved yet</p></div>
              ) : history.map((h) => (
                <div key={h.consult_id} className="h-item">
                  <div className="h-item-main" onClick={() => openConsult(h.consult_id)} style={{ cursor: 'pointer', flex: 1 }}>
                    <div className="h-item-title">{h.title || 'Consult'}</div>
                    <div className="h-item-meta">{new Date(h.created_at).toLocaleString()} · {(h.specialty || '').replace(/_/g, ' ')}</div>
                  </div>
                  <div className="h-item-actions">
                    {h.audio_uri && <button className="h-icon" title="Download audio" onClick={() => downloadAudio(h.consult_id)}>{I.download}</button>}
                    <button className="h-icon" title="Delete" onClick={() => deleteConsult(h.consult_id)}>{I.trash}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {toast && <div className={`toast show ${toast.kind}`}>{toast.msg}</div>}
      <Onboarding />
    </div>
  );
}
