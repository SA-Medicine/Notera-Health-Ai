'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './scribe.css';

// All backend calls go through the same-origin /backend proxy (cookies stay first-party).
const API = '/backend';
const SEGMENT_MS = 20_000;   // 20s chunks: well under Google's 60s sync cap even with WebM/Opus
                             // duration over-measurement, so fast sync recognize always works.

const SPECIALTIES = [
  'general_primary_care', 'musculoskeletal', 'diabetes', 'hypertension', 'mental_health',
  'dermatology', 'gynecology', 'pediatrics', 'weight_loss', 'medication_refill',
];

type Panel = 'context' | 'transcript' | 'note' | 'history';
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

  const streamRef = useRef<MediaStream | null>(null);
  const segRecRef = useRef<MediaRecorder | null>(null);
  const fullRecRef = useRef<MediaRecorder | null>(null);
  const segChunks = useRef<Blob[]>([]);
  const fullChunks = useRef<Blob[]>([]);
  const fullBlob = useRef<Blob | null>(null);
  const stopping = useRef(false);
  const startTs = useRef(0);
  const segTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  async function transcribeBlob(blob: Blob): Promise<string> {
    if (!blob.size) return '';
    const r = await fetch(`${API}/api/asr`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': blob.type }, body: blob });
    if (!r.ok) { const d = await readJson(r).catch(() => ({} as any)); throw new Error(d?.hint || d?.error || 'Transcription failed'); }
    const d = await readJson(r);
    return (d.text || d.transcript || '').trim();
  }

  function pushLine(text: string) {
    const secs = (Date.now() - startTs.current) / 1000;
    setLines((prev) => [...prev, { t: mmss(secs), text }]);
    setTx((prev) => (prev ? prev.trim() + ' ' : '') + text);
  }

  function startNextSegment() {
    const stream = streamRef.current;
    if (!stream || stopping.current) return;

    const chunks: BlobPart[] = [];
    const mime = segRecRef.current?.mimeType || 'audio/webm';
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      return;
    }

    segRecRef.current = rec;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    rec.onstop = async () => {
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: mime });
        if (blob.size >= 1000) {
          try {
            const text = await transcribeBlob(blob);
            if (text) pushLine(text);
          } catch (e) {
            console.warn('ASR chunk error:', (e as Error).message);
          }
        }
      }
      if (stopping.current) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (fullRecRef.current && fullRecRef.current.state !== 'inactive') {
          await new Promise<void>((res) => {
            fullRecRef.current!.onstop = () => res();
            try { fullRecRef.current!.stop(); } catch { res(); }
          });
        }
        if (fullChunks.current.length) fullBlob.current = new Blob(fullChunks.current, { type: 'audio/webm' });
        setPhase('done');
      }
    };

    rec.start();

    // Rotate after SEGMENT_MS (20s):
    segTimer.current = setTimeout(() => {
      if (!stopping.current) {
        // Start next segment FIRST for 0ms recording gap
        startNextSegment();
        // Stop current recorder to finalize and transcribe this chunk once
        try { rec.stop(); } catch { /* */ }
      }
    }, SEGMENT_MS);
  }

  async function toggleRecord() {
    if (phase === 'recording') {
      stopping.current = true; setPhase('transcribing');
      if (segTimer.current) clearTimeout(segTimer.current);
      try { segRecRef.current?.stop(); } catch { /* */ }
      return;
    }
    setError(''); setNote(''); setConsultId(null); setLines([]); setTx(''); setElapsed(0);
    setPanel('transcript');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream; stopping.current = false; startTs.current = Date.now();
      fullChunks.current = []; fullBlob.current = null;
      try {
        const fr = new MediaRecorder(stream); fullRecRef.current = fr;
        fr.ondataavailable = (e) => { if (e.data.size) fullChunks.current.push(e.data); };
        fr.start(1000);
      } catch { fullRecRef.current = null; }
      setPhase('recording'); startNextSegment();
    } catch { setError('Microphone unavailable — paste a transcript below instead.'); }
  }

  function loadPastedTranscript() {
    const t = pasteText.trim(); if (!t) return;
    setTx(t); setLines(t.split(/(?<=[.!?])\s+/).filter(Boolean).map((s, i) => ({ t: mmss(i * 5), text: s })));
    setPhase('done'); setPasteText('');
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
    if (!transcriptRef.current.trim()) { setError('Record or paste a transcript first.'); setPanel('transcript'); return; }
    setError(''); setEditing(false); setPhase('generating'); setGenStep(0); setPanel('note');
    const stepper = setInterval(() => setGenStep((s) => Math.min(s + 1, 3)), 3500);
    try {
      const me = await fetch(`${API}/api/auth/me`, { credentials: 'include' }).then((r) => r.ok ? readJson(r) : null).catch(() => null);
      const r = await fetch(`${API}/api/consults`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: buildTranscript(), specialty, noteType: 'consultation', clinicianId: me?.user?.id || 'clinician' }),
      });
      const d = await readJson(r);
      if (!r.ok) throw new Error(d?.error || 'Note generation failed');
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
    } catch (e) { setError((e as Error).message); setPhase(transcriptRef.current ? 'done' : 'idle'); flash((e as Error).message, 'error'); }
    finally { clearInterval(stepper); }
  }

  async function openConsult(id: string) {
    try {
      const r = await fetch(`${API}/api/library/consults/${id}`, { credentials: 'include' });
      const d = await readJson(r); const c = d.consult; if (!c) return;
      const draft = (c.drafts || [])[(c.drafts?.length || 1) - 1];
      setNote(draft?.rendered_note || draft?.note?.rendered || '');
      setTx((c.transcript?.text) || ''); setLines([]); setConsultId(id); setPhase('done'); setEditing(false);
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
    setPhase('idle'); setLines([]); setTx(''); setNote(''); setConsultId(null); setPatient(''); setElapsed(0); setEditing(false); setError(''); setPanel('transcript');
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
          <button className="new-session-btn" onClick={newSession}>{I.plus}<span>New session</span></button>
        </div>
        <nav className="sidebar-nav">
          <div className={`nav-item${panel === 'transcript' ? ' active' : ''}`} onClick={() => setPanel('transcript')}>{I.micStroke}<span>Scribe</span></div>
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
              <div className="session-subtitle">{recording ? 'Recording…' : phase === 'done' ? 'Ready' : 'New consultation'}</div>
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
            <button className="top-create-btn" onClick={createSOAP} disabled={phase === 'generating' || !transcript.trim()}>
              {I.bolt}{phase === 'generating' ? 'Creating…' : 'Create SOAP'}{I.chevronD}
            </button>
            <button className={`top-resume-btn${recording ? ' recording' : ''}`} onClick={toggleRecord} disabled={phase === 'transcribing' || phase === 'generating'}>
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
              <span className="transcript-label">Live Transcript</span>
              <span className="seg-count">{lines.length ? `${lines.length} segment${lines.length > 1 ? 's' : ''}` : ''}</span>
            </div>
            <div className="transcript-box">
              {lines.length === 0 && phase !== 'recording' ? (
                <div className="t-empty">
                  <div className="t-empty-icon">{I.micStroke}</div>
                  <p className="t-empty-title">Transcript will appear here as you record</p>
                  <p className="t-empty-sub">Or paste an existing transcript below to generate a note</p>
                  <div className="transcript-input-card">
                    <div className="transcript-input-header">{I.lines}<span>Paste Transcript</span></div>
                    <textarea className="transcript-input-textarea" rows={6} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="Paste consultation transcript here…" spellCheck={false} />
                    <div className="transcript-input-footer">
                      <span className="transcript-char-count">{pasteText.length} characters</span>
                      <button className="transcript-proceed-btn" onClick={loadPastedTranscript}>{I.bolt}Load transcript</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div id="transcriptLines">
                  {lines.map((l, i) => (
                    <div key={i} className="t-line"><span className="t-time">{l.t}</span><span className="t-text">{l.text}</span></div>
                  ))}
                  {phase === 'recording' && <div className="t-line"><span className="t-time">•••</span><span className="t-text" style={{ color: 'var(--text-faint)' }}>Listening… speak now.</span></div>}
                  {phase === 'transcribing' && <div className="t-line"><span className="t-time">•••</span><span className="t-text" style={{ color: 'var(--text-faint)' }}>Transcribing final segment…</span></div>}
                </div>
              )}
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
                <div className="note-content" style={{ display: 'block' }}>
                  <div className="note-body" ref={noteBodyRef} contentEditable={editing} suppressContentEditableWarning spellCheck={false} style={editing ? { outline: '1px dashed var(--border-mid)', borderRadius: 8 } : undefined} />
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
    </div>
  );
}
