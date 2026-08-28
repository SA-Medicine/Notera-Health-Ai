'use client';

import { useState, useRef } from 'react';
import type { DraftResult } from './types';
import NoteReview from './NoteReview';

const SPECIALTIES = [
  'general_primary_care', 'musculoskeletal', 'diabetes', 'hypertension', 'mental_health',
  'dermatology', 'gynecology', 'pediatrics', 'weight_loss', 'medication_refill',
];

const SAMPLE = `Speaker 1 (Clinician): What brings you in today?
Speaker 2 (Patient): I've had a sore throat and mild fever for three days.
Speaker 1: Any cough or difficulty swallowing?
Speaker 2: A bit of a cough, swallowing is uncomfortable but okay. No trouble breathing.
Speaker 1: Any allergies? Current medications?
Speaker 2: I'm allergic to penicillin. I take metformin 500mg twice daily for my diabetes.
Speaker 1: Your throat looks a little red, no pus. Chest is clear. I think this is viral.
Speaker 1: Rest, fluids, paracetamol for the fever. Come back if it's not better in a week.`;

export default function NewConsult() {
  const [transcript, setTranscript] = useState('');
  const [specialty, setSpecialty] = useState(SPECIALTIES[0]);
  const [noteType, setNoteType] = useState('consultation');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<DraftResult | null>(null);
  const [devMode, setDevMode] = useState(true);

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [autoGenerate, setAutoGenerate] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const segTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppingRef = useRef(false);
  const transcriptRef = useRef('');          // mirrors `transcript` so segment callbacks read the latest
  const SEGMENT_MS = 40000;                  // cut a fresh ~40s segment (well under Speech's ~60s sync cap)

  // Keep the textarea and the ref in sync (manual edits + streamed segments).
  function updateTranscript(v: string | ((p: string) => string)) {
    setTranscript((prev) => {
      const next = typeof v === 'function' ? (v as (p: string) => string)(prev) : v;
      transcriptRef.current = next;
      return next;
    });
  }

  async function transcribeBlob(blob: Blob): Promise<string> {
    if (!blob || !blob.size) return '';
    const r = await fetch('/backend/api/asr', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.hint || d?.error || 'Transcription failed');
    return (d.transcript || '').trim();
  }

  // One ~40s segment: record → on stop transcribe + append → start the next (or finalize).
  function startSegment() {
    const stream = streamRef.current;
    if (!stream) return;
    const rec = new MediaRecorder(stream);
    recorderRef.current = rec;
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
      try {
        const seg = await transcribeBlob(blob);
        if (seg) updateTranscript((prev) => (prev ? prev.trim() + ' ' : '') + seg);
      } catch (e) { setError((e as Error).message); }

      if (!stoppingRef.current) {
        startSegment();                       // still recording → next segment (near-seamless)
        return;
      }
      // user pressed Stop → finalize the session
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setTranscribing(false);
      const full = transcriptRef.current.trim();
      if (autoGenerate && full) { setPhase('Transcribed ✓ — generating the note…'); await generate(full); }
      else setPhase(full ? 'Transcribed ✓ — review the text, then Generate.' : 'No speech detected — try again.');
    };
    rec.start();
    segTimerRef.current = setTimeout(() => { try { rec.stop(); } catch { /* ignore */ } }, SEGMENT_MS);
  }

  async function toggleRecord() {
    if (recording) {
      // Stop: end the loop; the final segment transcribes, then (optionally) auto-generates.
      stoppingRef.current = true;
      setRecording(false);
      setTranscribing(true);
      setPhase('Finishing transcription…');
      if (segTimerRef.current) clearTimeout(segTimerRef.current);
      try { recorderRef.current?.stop(); } catch { /* ignore */ }
      return;
    }
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stoppingRef.current = false;
      setRecording(true);
      setPhase('Recording… transcript updates every ~40s. Click Stop when the consult ends.');
      startSegment();
    } catch {
      setError('Microphone unavailable. Paste a transcript instead.');
    }
  }

  async function generate(text?: string) {
    const t = (text ?? transcript).trim();
    if (!t) { setError('Nothing to generate — record or paste a transcript first.'); return; }
    setError(''); setResult(null); setLoading(true);
    setPhase('Extracting entities → drafting → structuring the note…');
    try {
      const res = await fetch('/api/consults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: t, specialty, noteType, clinicianId: 'demo-clinician', includeLogs: devMode }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Generation failed');
      setResult(body as DraftResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false); setPhase('');
    }
  }

  if (result) {
    return <NoteReview draft={result} onReset={() => setResult(null)} />;
  }

  return (
    <div className="card intake">
      <div className="row">
        <div>
          <label htmlFor="specialty">Specialty</label>
          <select id="specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
            {SPECIALTIES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="noteType">Note type</label>
          <select id="noteType" value={noteType} onChange={(e) => setNoteType(e.target.value)}>
            <option value="consultation">consultation</option>
            <option value="follow_up">follow up</option>
            <option value="medication_refill">medication refill</option>
          </select>
        </div>
      </div>

      <label htmlFor="transcript">Consultation transcript</label>
      <textarea
        id="transcript"
        placeholder="Paste the consult transcript, or record and paste the transcription…"
        value={transcript}
        onChange={(e) => updateTranscript(e.target.value)}
      />

      <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
        <button className="btn ghost" type="button" onClick={toggleRecord} disabled={transcribing} style={{ flex: 'none' }}>
          {transcribing ? <><span className="spinner" /> Transcribing…</> : recording ? '■ Stop recording' : '● Record'}
        </button>
        <button className="btn ghost" type="button" onClick={() => updateTranscript(SAMPLE)} style={{ flex: 'none' }}>
          Load sample
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontWeight: 600, fontSize: 13, color: 'var(--ink-soft)', flex: 'none', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoGenerate} onChange={(e) => setAutoGenerate(e.target.checked)} style={{ width: 'auto' }} /> Auto‑generate after recording
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontWeight: 600, fontSize: 13, color: 'var(--ink-soft)', flex: 'none', cursor: 'pointer' }}>
          <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} style={{ width: 'auto' }} /> Dev logs
        </label>
        <span className="muted" style={{ flex: 1, textAlign: 'right' }}>{phase}</span>
        <button className="btn" type="button" onClick={() => generate()} disabled={loading || recording || transcribing || !transcript.trim()} style={{ flex: 'none' }}>
          {loading ? <><span className="spinner" /> Generating…</> : 'Generate draft note'}
        </button>
      </div>

      {error && <div className="flag critical" style={{ marginTop: 14 }}><span className="dot" />{error}</div>}
    </div>
  );
}
