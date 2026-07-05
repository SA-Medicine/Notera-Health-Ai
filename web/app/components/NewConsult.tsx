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
  const recorderRef = useRef<MediaRecorder | null>(null);

  async function toggleRecord() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setPhase('Recording… click Stop when the consult ends.');
    } catch {
      setError('Microphone unavailable. Paste a transcript instead.');
    }
  }

  async function generate() {
    setError(''); setResult(null); setLoading(true);
    setPhase('Transcribing → extracting entities → drafting → structuring…');
    try {
      const res = await fetch('/api/consults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, specialty, noteType, clinicianId: 'demo-clinician', includeLogs: devMode }),
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
        onChange={(e) => setTranscript(e.target.value)}
      />

      <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
        <button className="btn ghost" type="button" onClick={toggleRecord} style={{ flex: 'none' }}>
          {recording ? '■ Stop recording' : '● Record'}
        </button>
        <button className="btn ghost" type="button" onClick={() => setTranscript(SAMPLE)} style={{ flex: 'none' }}>
          Load sample
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontWeight: 600, fontSize: 13, color: 'var(--ink-soft)', flex: 'none', cursor: 'pointer' }}>
          <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} style={{ width: 'auto' }} /> Dev logs
        </label>
        <span className="muted" style={{ flex: 1, textAlign: 'right' }}>{phase}</span>
        <button className="btn" type="button" onClick={generate} disabled={loading || !transcript.trim()} style={{ flex: 'none' }}>
          {loading ? <><span className="spinner" /> Generating…</> : 'Generate draft note'}
        </button>
      </div>

      {error && <div className="flag critical" style={{ marginTop: 14 }}><span className="dot" />{error}</div>}
    </div>
  );
}
