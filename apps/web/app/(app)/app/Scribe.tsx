'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// All backend calls go through the same-origin /backend proxy (cookies stay first-party).
const API = '/backend';
const SPECIALTIES = [
  'general_primary_care', 'musculoskeletal', 'diabetes', 'hypertension', 'mental_health',
  'dermatology', 'gynecology', 'pediatrics', 'weight_loss', 'medication_refill',
];
const SEGMENT_MS = 40_000;

type Phase = 'idle' | 'recording' | 'transcribing' | 'generating' | 'done';
type Line = { t: string; text: string };
type HistItem = { consult_id: string; title: string | null; specialty: string | null; status: string; audio_uri: string | null; created_at: string };

const mmss = (secs: number) => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

// simple, safe markdown → HTML (headings, bold, lists, line breaks)
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc(md || '').split('\n'); const out: string[] = []; let inList = false;
  for (let ln of lines) {
    if (/^\s*[-*]\s+/.test(ln)) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + ln.replace(/^\s*[-*]\s+/, '') + '</li>'); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    if (/^#{1,6}\s/.test(ln)) { const h = ln.match(/^#+/)![0].length; out.push(`<h${h}>` + ln.replace(/^#+\s/, '') + `</h${h}>`); continue; }
    if (!ln.trim()) { out.push('<br/>'); continue; }
    out.push('<p>' + ln + '</p>');
  }
  if (inList) out.push('</ul>');
  return out.join('').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export default function Scribe() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [transcript, setTranscript] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [specialty, setSpecialty] = useState(SPECIALTIES[0]);
  const [noteType, setNoteType] = useState('consultation');
  const [patient, setPatient] = useState('');
  const [error, setError] = useState('');
  const [genStep, setGenStep] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistItem[]>([]);
  const [consultId, setConsultId] = useState<string | null>(null);
  const [pasteMode, setPasteMode] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const segRecRef = useRef<MediaRecorder | null>(null);
  const fullRecRef = useRef<MediaRecorder | null>(null);
  const segChunks = useRef<Blob[]>([]);
  const fullChunks = useRef<Blob[]>([]);
  const fullBlob = useRef<Blob | null>(null);
  const stopping = useRef(false);
  const startTs = useRef(0);
  const segTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef('');

  const setTx = (v: string | ((p: string) => string)) =>
    setTranscript((prev) => { const n = typeof v === 'function' ? (v as any)(prev) : v; transcriptRef.current = n; return n; });

  // ── history ────────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    try { const r = await fetch(`${API}/api/library/consults`, { credentials: 'include' }); if (r.ok) setHistory((await r.json()).consults || []); } catch { /* */ }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── ASR for one audio blob ───────────────────────────────────────────────────
  async function transcribeBlob(blob: Blob): Promise<string> {
    if (!blob.size) return '';
    const r = await fetch(`${API}/api/asr`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': blob.type }, body: blob });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.hint || d?.error || 'Transcription failed');
    return (d.text || d.transcript || '').trim();
  }

  function pushLine(text: string) {
    const secs = (Date.now() - startTs.current) / 1000;
    setLines((prev) => [...prev, { t: mmss(secs), text }]);
    setTx((prev) => (prev ? prev.trim() + ' ' : '') + text);
  }

  function startSegment() {
    const stream = streamRef.current; if (!stream) return;
    const rec = new MediaRecorder(stream);
    segRecRef.current = rec; segChunks.current = [];
    rec.ondataavailable = (e) => { if (e.data.size) segChunks.current.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(segChunks.current, { type: rec.mimeType || 'audio/webm' });
      try { const seg = await transcribeBlob(blob); if (seg) pushLine(seg); } catch (e) { setError((e as Error).message); }
      if (!stopping.current) { startSegment(); return; }
      stream.getTracks().forEach((t) => t.stop()); streamRef.current = null;
      // finalise the full recording
      if (fullRecRef.current && fullRecRef.current.state !== 'inactive') {
        await new Promise<void>((res) => { fullRecRef.current!.onstop = () => res(); try { fullRecRef.current!.stop(); } catch { res(); } });
      }
      if (fullChunks.current.length) fullBlob.current = new Blob(fullChunks.current, { type: 'audio/webm' });
      setPhase('done');
    };
    rec.start();
    segTimer.current = setTimeout(() => { try { rec.stop(); } catch { /* */ } }, SEGMENT_MS);
  }

  async function toggleRecord() {
    if (phase === 'recording') {
      stopping.current = true; setPhase('transcribing');
      if (segTimer.current) clearTimeout(segTimer.current);
      try { segRecRef.current?.stop(); } catch { /* */ }
      return;
    }
    setError(''); setNote(''); setConsultId(null); setLines([]); setTx('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream; stopping.current = false; startTs.current = Date.now();
      fullChunks.current = []; fullBlob.current = null;
      try {
        const fr = new MediaRecorder(stream); fullRecRef.current = fr;
        fr.ondataavailable = (e) => { if (e.data.size) fullChunks.current.push(e.data); };
        fr.start(1000);
      } catch { fullRecRef.current = null; }
      setPhase('recording'); setPasteMode(false); startSegment();
    } catch { setError('Microphone unavailable — use “Paste transcript” instead.'); }
  }

  // ── generate the SOAP note ───────────────────────────────────────────────────
  async function createSOAP() {
    const t = transcriptRef.current.trim();
    if (!t) { setError('Record or paste a transcript first.'); return; }
    setError(''); setEditing(false); setPhase('generating'); setGenStep(0);
    const stepper = setInterval(() => setGenStep((s) => Math.min(s + 1, 3)), 3500);
    try {
      const me = await fetch(`${API}/api/auth/me`, { credentials: 'include' }).then((r) => r.ok ? r.json() : null).catch(() => null);
      const r = await fetch(`${API}/api/consults`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: t, specialty, noteType, clinicianId: me?.user?.id || 'clinician' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Note generation failed');
      const md = d.renderedNote || d.rawRenderedNote || '';
      setNote(md); setConsultId(d.consultId || null); setPhase('done');
      // persist per-user + audio (best-effort)
      const cid = d.consultId;
      if (cid) {
        fetch(`${API}/api/library/consults`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consultId: cid, transcript: t, renderedNote: md, title: patient || `${specialty.replace(/_/g, ' ')} · ${new Date().toLocaleDateString()}`, specialty, noteType, status: 'ready' }) })
          .then(() => { if (fullBlob.current?.size) return fetch(`${API}/api/library/consults/${cid}/audio`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': fullBlob.current!.type }, body: fullBlob.current! }); })
          .then(() => loadHistory()).catch(() => {});
      }
    } catch (e) { setError((e as Error).message); setPhase(transcriptRef.current ? 'done' : 'idle'); }
    finally { clearInterval(stepper); }
  }

  async function openConsult(id: string) {
    try {
      const r = await fetch(`${API}/api/library/consults/${id}`, { credentials: 'include' });
      const d = await r.json(); const c = d.consult;
      if (!c) return;
      const draft = (c.drafts || [])[c.drafts?.length - 1];
      setNote(draft?.rendered_note || draft?.note?.rendered || '');
      setTx((c.transcript?.text) || '');
      setLines([]); setConsultId(id); setPhase('done'); setShowHistory(false);
    } catch { /* */ }
  }
  async function downloadAudio(id: string) {
    try { const r = await fetch(`${API}/api/library/consults/${id}/audio`, { credentials: 'include' }); const d = await r.json(); if (d.url) window.open(d.url, '_blank'); else setError('No audio for this consult'); } catch { /* */ }
  }
  async function deleteConsult(id: string) {
    if (!confirm('Delete this consult?')) return;
    await fetch(`${API}/api/library/consults/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
    loadHistory();
  }

  const copy = (plain: boolean) => {
    const text = plain ? note.replace(/[#*_`>]/g, '').replace(/\n{3,}/g, '\n\n') : note;
    navigator.clipboard.writeText(text);
  };

  const genSteps = ['Extracting clinical facts', 'De‑identifying & drafting', 'Structuring the SOAP note', 'Grounding & final check'];

  return (
    <div className="flex h-[calc(100vh-57px)] flex-col bg-slate-50 text-slate-900">
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <input value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Patient name / ID"
          className="w-44 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500" />
        <select value={specialty} onChange={(e) => setSpecialty(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
          {SPECIALTIES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={noteType} onChange={(e) => setNoteType(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
          <option value="consultation">consultation</option><option value="follow_up">follow up</option><option value="medication_refill">medication refill</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setShowHistory(true)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">History</button>
          <button onClick={toggleRecord} disabled={phase === 'transcribing' || phase === 'generating'}
            className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-semibold text-white ${phase === 'recording' ? 'bg-red-600 animate-pulse' : 'bg-slate-800 hover:bg-slate-900'} disabled:opacity-50`}>
            <span className={`h-2 w-2 rounded-full ${phase === 'recording' ? 'bg-white' : 'bg-red-500'}`} />
            {phase === 'recording' ? 'Stop' : phase === 'transcribing' ? 'Finishing…' : 'Record'}
          </button>
          <button onClick={createSOAP} disabled={phase === 'recording' || phase === 'generating' || !transcript.trim()}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
            {phase === 'generating' ? 'Creating…' : 'Create SOAP'}
          </button>
        </div>
      </div>

      {error && <div className="mx-4 mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {/* Split: transcript | note */}
      <div className="grid flex-1 gap-px overflow-hidden bg-slate-200 md:grid-cols-2">
        {/* Transcript */}
        <section className="flex min-h-0 flex-col bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <span>{phase === 'recording' ? '● Live transcript' : 'Transcript'}</span>
            <button onClick={() => setPasteMode((v) => !v)} className="text-blue-600 hover:underline">{pasteMode ? 'Hide paste' : 'Paste transcript'}</button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {pasteMode ? (
              <textarea value={transcript} onChange={(e) => setTx(e.target.value)} placeholder="Paste the consultation transcript…"
                className="h-full w-full resize-none rounded-lg border border-slate-200 p-3 text-sm outline-none focus:border-blue-500" />
            ) : lines.length ? (
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="flex gap-3 text-sm"><span className="shrink-0 font-mono text-xs text-slate-400">{l.t}</span><span>{l.text}</span></div>
                ))}
                {phase === 'transcribing' && <div className="text-sm text-slate-400">Transcribing final segment…</div>}
              </div>
            ) : phase === 'recording' ? (
              <div className="flex h-full flex-col items-center justify-center text-slate-400">
                <div className="mb-3 flex gap-1">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="h-6 w-1 animate-pulse rounded bg-red-400" style={{ animationDelay: `${i * 120}ms` }} />)}</div>
                <p className="text-sm">Listening… start speaking. Your words appear here live.</p>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center text-slate-400">
                <p className="text-sm">Press <b>Record</b> to capture the consult, or <button onClick={() => setPasteMode(true)} className="text-blue-600 hover:underline">paste a transcript</button>.</p>
              </div>
            )}
          </div>
        </section>

        {/* Note */}
        <section className="flex min-h-0 flex-col bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">SOAP note</span>
            {note && phase === 'done' && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setEditing((v) => !v)} className={`rounded-md px-2.5 py-1 text-xs font-medium ${editing ? 'bg-blue-600 text-white' : 'border border-slate-300 hover:bg-slate-50'}`}>{editing ? 'Done' : 'Edit'}</button>
                <button onClick={() => copy(true)} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">Copy to EMR</button>
                <button onClick={() => copy(false)} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">Copy</button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-auto p-5">
            {phase === 'generating' ? (
              <div className="flex h-full flex-col items-center justify-center">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
                <div className="mt-5 space-y-1.5 text-center">
                  {genSteps.map((s, i) => (
                    <div key={i} className={`text-sm ${i < genStep ? 'text-emerald-600' : i === genStep ? 'font-semibold text-slate-800' : 'text-slate-400'}`}>
                      {i < genStep ? '✓ ' : i === genStep ? '• ' : '  '}{s}
                    </div>
                  ))}
                </div>
              </div>
            ) : note ? (
              editing ? (
                <textarea value={note} onChange={(e) => setNote(e.target.value)} className="h-full w-full resize-none rounded-lg border border-slate-200 p-3 font-mono text-sm outline-none focus:border-blue-500" />
              ) : (
                <div className="text-sm leading-relaxed [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_p]:my-1 [&_strong]:font-semibold" dangerouslySetInnerHTML={{ __html: mdToHtml(note) }} />
              )
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center text-slate-400">
                <p className="text-sm">No note yet.</p>
                <p className="mt-1 text-xs">Record or paste a transcript, then press <b>Create SOAP</b>.</p>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* History drawer */}
      {showHistory && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setShowHistory(false)}>
          <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold">History</h2>
              <button onClick={() => setShowHistory(false)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>
            <div className="divide-y divide-slate-100">
              {history.length === 0 && <p className="p-6 text-center text-sm text-slate-400">No saved consults yet.</p>}
              {history.map((h) => (
                <div key={h.consult_id} className="flex items-center gap-2 px-4 py-3 hover:bg-slate-50">
                  <button onClick={() => openConsult(h.consult_id)} className="flex-1 text-left">
                    <div className="text-sm font-medium">{h.title || 'Consult'}</div>
                    <div className="text-xs text-slate-500">{new Date(h.created_at).toLocaleString()} · {(h.specialty || '').replace(/_/g, ' ')}</div>
                  </button>
                  {h.audio_uri && <button onClick={() => downloadAudio(h.consult_id)} title="Download audio" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-emerald-600">⤓</button>}
                  <button onClick={() => deleteConsult(h.consult_id)} title="Delete" className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600">✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
