'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import type { DraftResult, Note, Flag, APIssue } from './types';
import PipelineLogsPanel from './PipelineLogsPanel';

// Draft review + edit + sign-off — renders the exact SOAP template (schema v2).
export default function NoteReview({ draft, onReset }: { draft: DraftResult; onReset: () => void }) {
  const [note, setNote] = useState<Note>(draft.note);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState<string | null>(null);
  const [error, setError] = useState('');
  const flags: Flag[] = note.metadata?.flags || draft.flags || [];

  function setPath(path: string, value: unknown) {
    setNote((prev) => {
      const next = structuredClone(prev) as any;
      const parts = path.split('.'); let o = next;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      o[parts[parts.length - 1]] = value;
      return next;
    });
  }
  function setIssue(i: number, key: keyof APIssue, value: unknown) {
    setNote((prev) => {
      const next = structuredClone(prev) as Note;
      (next.assessment_and_plan[i] as any)[key] = value;
      return next;
    });
  }
  function addIssue() {
    setNote((prev) => {
      const next = structuredClone(prev) as Note;
      next.assessment_and_plan.push({ issue: '', diagnosis: '', assessment: '', differential_diagnoses: [], investigations_planned: '', treatment_planned: '', referrals: '' });
      return next;
    });
  }
  function removeIssue(i: number) {
    setNote((prev) => { const next = structuredClone(prev) as Note; next.assessment_and_plan.splice(i, 1); return next; });
  }

  async function approve() {
    setApproving(true); setError('');
    try {
      const res = await fetch(`/api/consults/${draft.consultId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draft.draftId, finalNote: note, clinicianId: 'demo-clinician' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Approval failed');
      setApproved(body.finalId);
    } catch (e) { setError((e as Error).message); } finally { setApproving(false); }
  }

  if (approved) {
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <span className="status PASS">✓ Signed</span>
        <h2 style={{ marginTop: 16 }}>Note approved</h2>
        <p className="muted">Final <code>{approved}</code> written. The draft→final diff was captured as training signal.</p>
        <button className="btn" onClick={onReset}>New consult</button>
      </div>
    );
  }

  const su = note.subjective, pmh = note.past_medical_history, ob = note.objective;

  return (
    <div>
      <div className="review">
        <div className="card review-main">
          <div className="review-head">
            <span className={`status ${draft.status}`}>{draft.status}</span>
            <span className="meta-dim">schema v{note.schema_version} · {note.specialty.replace(/_/g, ' ')} · {note.note_type.replace(/_/g, ' ')}</span>
          </div>
          <h1 style={{ fontSize: 21 }}>Draft note — review &amp; edit</h1>

          <Section title="Subjective">
            <Area label="Reason for visit" value={su.reason_for_visit} onChange={(x) => setPath('subjective.reason_for_visit', x)} />
            <Area label="History of presenting complaint" value={su.hpi_details} onChange={(x) => setPath('subjective.hpi_details', x)} />
            <div className="field-grid2">
              <Area label="Aggravating / relieving factors" value={su.aggravating_relieving_factors} onChange={(x) => setPath('subjective.aggravating_relieving_factors', x)} />
              <Area label="Symptom progression" value={su.symptom_progression} onChange={(x) => setPath('subjective.symptom_progression', x)} />
            </div>
            <div className="field-grid2">
              <Area label="Previous episodes" value={su.previous_episodes} onChange={(x) => setPath('subjective.previous_episodes', x)} />
              <Area label="Functional impact" value={su.functional_impact} onChange={(x) => setPath('subjective.functional_impact', x)} />
            </div>
            <Area label="Associated symptoms" value={su.associated_symptoms} onChange={(x) => setPath('subjective.associated_symptoms', x)} />
          </Section>

          <Section title="Past Medical History">
            <div className="field-grid2">
              <Area label="Medical & surgical history" value={pmh.medical_surgical} onChange={(x) => setPath('past_medical_history.medical_surgical', x)} />
              <Area label="Social history" value={pmh.social} onChange={(x) => setPath('past_medical_history.social', x)} />
            </div>
            <div className="field-grid2">
              <Area label="Family history" value={pmh.family} onChange={(x) => setPath('past_medical_history.family', x)} />
              <Area label="Exposure history" value={pmh.exposure} onChange={(x) => setPath('past_medical_history.exposure', x)} />
            </div>
            <div className="field-grid2">
              <Area label="Immunisation history / status" value={pmh.immunisation} onChange={(x) => setPath('past_medical_history.immunisation', x)} />
              <Area label="Other relevant information" value={pmh.other} onChange={(x) => setPath('past_medical_history.other', x)} />
            </div>
          </Section>

          <Section title="Objective">
            <Area label="Vital signs" value={ob.vital_signs} onChange={(x) => setPath('objective.vital_signs', x)} />
            <Area label="Examination findings" value={ob.examination} onChange={(x) => setPath('objective.examination', x)} />
            <Area label="Completed investigations (results)" value={ob.completed_investigations} onChange={(x) => setPath('objective.completed_investigations', x)} />
          </Section>

          <Section title="Assessment & Plan">
            {note.assessment_and_plan.length === 0 && <p className="muted" style={{ marginTop: 8 }}>No issues identified. <button className="link-btn" onClick={addIssue}>Add one</button>.</p>}
            {note.assessment_and_plan.map((it, i) => (
              <div className="ap-block" key={i}>
                <div className="ap-head">
                  <span className="ap-num">{i + 1}</span>
                  <input className="ap-issue" value={it.issue} placeholder="Issue / request / problem name" onChange={(e) => setIssue(i, 'issue', e.target.value)} />
                  <button className="ap-remove" title="Remove issue" onClick={() => removeIssue(i)}>✕</button>
                </div>
                <Area label="Diagnosis (only if explicitly stated)" value={it.diagnosis} onChange={(x) => setIssue(i, 'diagnosis', x)} />
                <Area label="Assessment" value={it.assessment} onChange={(x) => setIssue(i, 'assessment', x)} />
                <List label="Differential diagnoses" values={it.differential_diagnoses} onChange={(x) => setIssue(i, 'differential_diagnoses', x)} />
                <div className="field-grid2">
                  <Area label="Investigations planned" value={it.investigations_planned} onChange={(x) => setIssue(i, 'investigations_planned', x)} />
                  <Area label="Treatment planned" value={it.treatment_planned} onChange={(x) => setIssue(i, 'treatment_planned', x)} />
                </div>
                <Area label="Referrals" value={it.referrals} onChange={(x) => setIssue(i, 'referrals', x)} />
              </div>
            ))}
            {note.assessment_and_plan.length > 0 && <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={addIssue}>+ Add issue</button>}
          </Section>

          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <button className="btn ok" onClick={approve} disabled={approving}>
              {approving ? <><span className="spinner" /> Signing…</> : '✓ Approve & sign'}
            </button>
            <button className="btn ghost" onClick={onReset}>Discard</button>
          </div>
          {error && <div className="flag critical" style={{ marginTop: 14 }}><span className="dot" />{error}</div>}
        </div>

        <aside className="review-side">
          <div className="card">
            <h2>Guardrail flags</h2>
            {flags.length === 0 && <p className="muted" style={{ margin: 0 }}>No flags — schema valid and every medication supported by a transcript entity.</p>}
            {flags.map((f, i) => (
              <div key={i} className={`flag ${f.severity}`}>
                <span className="dot" />
                <div><strong>{f.type.replace(/_/g, ' ')}</strong>{f.field ? ` · ${f.field}` : ''}<br /><span className="muted">{f.message}</span></div>
              </div>
            ))}
            {draft.schemaErrors?.length > 0 && (
              <div className="flag critical"><span className="dot" /><div><strong>schema errors</strong><br /><span className="muted">{draft.schemaErrors.map((e) => e.message).join('; ')}</span></div></div>
            )}
          </div>

          <div className="card">
            <h2>NER-extracted facts</h2>
            <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>Independently extracted from the transcript — grounds and cross-checks the note.</p>
            <div className="chips">
              {draft.entities?.length ? draft.entities.map((e, i) => (
                <span key={i} className={`chip ${e.negated ? 'neg' : ''}`} title={e.label}>{e.text}</span>
              )) : <span className="muted" style={{ fontSize: 13 }}>No entities returned (NER sidecar offline in this environment).</span>}
            </div>
          </div>
        </aside>
      </div>

      {/* Full-width developer logs */}
      <div style={{ marginTop: 22 }}>
        <PipelineLogsPanel logs={draft.logs} consultId={draft.consultId} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="section"><div className="section-title">{title}</div>{children}</div>;
}
function List({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = (values || []).join('\n');
  const resize = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.max(el.scrollHeight, 44)}px`; } };
  useLayoutEffect(resize, [text]);
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <textarea ref={ref} className="autogrow" value={text} placeholder="one per line" onChange={(e) => { onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)); resize(); }} />
    </div>
  );
}
function Area({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } };
  useLayoutEffect(resize, [value]);
  useEffect(() => { const on = () => resize(); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <textarea ref={ref} className="autogrow" value={value} placeholder="— (blank if not mentioned)" onChange={(e) => { onChange(e.target.value); resize(); }} />
    </div>
  );
}
