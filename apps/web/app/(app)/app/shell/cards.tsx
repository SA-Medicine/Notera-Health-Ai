'use client';

// The content of every panel in the two docks. Presentational: Scribe passes the state and handlers in, nothing here talks to the backend.
//   modules   screens of the app (Scribe, Paste transcript, Context, History)
//   sessions  recent sessions, grouped by day, with the lines still to check
//   session   patient, specialty, date, timer, language
//   note      template, saved state, Edit / Copy
//   checks    lines to check in the current note
//   tools     record, paste, theme
import type { ReactNode } from 'react';
import type { CardDef } from './Dock';

const svg = (d: ReactNode) => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
export const SI = {
  mic: svg(<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></>),
  lines: svg(<path d="M4 7h16M4 12h16M4 17h10" />),
  doc: svg(<><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></>),
  clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  user: svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></>),
  shield: svg(<><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>),
  tools: svg(<path d="M14 6a4 4 0 005 5l-9 9a2.1 2.1 0 01-3-3l9-9a4 4 0 00-2-2z" />),
  moon: svg(<path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z" />),
  copy: svg(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></>),
  edit: svg(<path d="M4 20h4L19 9l-4-4L4 16z" />),
  globe: svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>),
  cal: svg(<><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  panelLeft: svg(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>),
  panelRight: svg(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>),
  swap: svg(<path d="M7 7h13l-3-3M17 17H4l3 3" />),
  reset: svg(<path d="M4 12a8 8 0 108-8H7M7 4L4 7l3 3" />),
  close: svg(<path d="M6 6l12 12M18 6L6 18" />),
};

import { groupSessions, type SessionItem } from './sessions';
export type { SessionItem, Group } from './sessions';
const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const clock = (iso: string) => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const dayShort = (iso: string) => { try { return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }); } catch { return ''; } };

export type CardsProps = {
  panel: string; setPanel: (p: string) => void; loadHistory: () => void;
  history: SessionItem[]; activeConsult: string | null; openConsult: (id: string) => void;
  patient: string; setPatient: (v: string) => void; patientMeds: string; setPatientMeds: (v: string) => void; specialty: string; setSpecialty: (v: string) => void; specialties: string[];
  dateStr: string; timer: string; recording: boolean; phaseLabel: string;
  note: string; editing: boolean; toggleEdit: () => void; copy: () => void; saveState: 'idle' | 'saving' | 'saved' | 'error'; retrySave: () => void;
  toCheck: number; review: () => void; noSuggest?: boolean;   // an account with all suggestions off: no "to check" counts on the session cards
  toggleRecord: () => void; busy: boolean; newSession: () => void; dark: boolean; setDark: (f: (v: boolean) => boolean) => void;
  inviteHref?: string; railed: boolean;
};

export function buildCards(p: CardsProps): Partial<Record<'modules' | 'sessions' | 'session' | 'note' | 'checks' | 'tools', CardDef>> {
  const nav = (id: string, label: string, icon: ReactNode, tour?: string, onGo?: () => void) => (
    <button key={id} type="button" className={`sh-nav${p.panel === id ? ' is-active' : ''}`} data-tour={tour} onClick={() => { p.setPanel(id); onGo?.(); }} aria-current={p.panel === id ? 'page' : undefined} title={label}>{icon}<span>{label}</span></button>
  );
  const groups = groupSessions(p.history);
  return {
    sessions: {
      id: 'sessions', title: 'Sessions', icon: SI.clock,
      meta: p.history.length ? <span className="dcard-count">{p.history.length}</span> : undefined,
      body: groups.length === 0 ? <p className="sh-empty">Your sessions appear here once a note is saved.</p> : (
        <div className="sh-sessions">
          {groups.map((g) => (
            <div key={g.label} className="sh-sgroup"><div className="sh-sgroup-h">{g.label}</div>
              {g.items.map((s) => (
                <button key={s.consult_id} type="button" className={`sh-session${p.activeConsult === s.consult_id ? ' is-active' : ''}`} onClick={() => p.openConsult(s.consult_id)}>
                  <span className="sh-session-main"><span className="sh-session-title">{s.title || 'Consult'}</span><span className="sh-session-sub">{g.label === 'Today' || g.label === 'Yesterday' ? clock(s.created_at) : dayShort(s.created_at)}{s.specialty ? ` · ${s.specialty.replace(/_/g, ' ')}` : ''}</span></span>
                  {!!s.checks && !p.noSuggest && <span className="sh-check-pill" title={`${s.checks} line${s.checks === 1 ? '' : 's'} to check`}>{s.checks}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      ),
    },
    session: {
      id: 'session', title: 'Session', icon: SI.user,
      meta: <span className={`sh-state${p.recording ? ' is-live' : ''}`}>{p.phaseLabel}</span>,
      body: (
        <div className="sh-fields">
          <label className="sh-field"><span>Patient</span><input value={p.patient} onChange={(e) => p.setPatient(e.target.value)} placeholder="Name or ID" autoComplete="off" /></label>
          <label className="sh-field"><span>Medications (from the EHR)</span><textarea className="sh-meds" rows={2} value={p.patientMeds} onChange={(e) => p.setPatientMeds(e.target.value)} placeholder="Optional. Paste the patient's list, e.g. amlodipine 5 mg, Atacand 16 mg. Used to check drug names." /></label>
          <label className="sh-field"><span>Specialty</span>
            <select value={p.specialty} onChange={(e) => p.setSpecialty(e.target.value)}><option value="auto">Auto-detect</option>{p.specialties.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
          </label>
          <dl className="sh-facts"><div><dt>{SI.cal}Date</dt><dd>{p.dateStr}</dd></div><div><dt>{SI.clock}Recorded</dt><dd className="tnum">{p.timer}</dd></div><div><dt>{SI.globe}Language</dt><dd>English</dd></div></dl>
        </div>
      ),
    },
    note: {
      id: 'note', title: 'Note', icon: SI.doc,
      body: (
        <div className="sh-note">
          <div className="sh-row"><span className="sh-k">Template</span><span className="sh-v">SOAP note</span></div>
          <div className="sh-row"><span className="sh-k">History</span>
            <span className={`sh-v sh-save is-${p.saveState}`} role="status">{p.saveState === 'saving' ? 'Saving…' : p.saveState === 'saved' ? 'Saved to history ✓' : p.saveState === 'error' ? <button type="button" className="sh-link" onClick={p.retrySave}>Not saved. Retry</button> : p.note ? 'Up to date' : 'No note yet'}</span></div>
          <div className="sh-actions">
            <button type="button" className="sh-btn" onClick={p.toggleEdit} disabled={!p.note}>{SI.edit}{p.editing ? 'Done' : 'Edit'}</button>
            <button type="button" className="sh-btn is-primary" onClick={() => p.copy()} disabled={!p.note}>{SI.copy}Copy note</button>
          </div>
        </div>
      ),
    },
    checks: {
      id: 'checks', title: 'To check', icon: SI.shield,
      meta: p.toCheck > 0 ? <span className="sh-check-pill">{p.toCheck}</span> : undefined,
      body: !p.note ? <p className="sh-empty">Lines the note wants you to look at appear here.</p>
        : p.toCheck > 0 ? <div className="sh-checks"><p>{p.toCheck} line{p.toCheck === 1 ? '' : 's'} to look at before you sign. They are marked in the note.</p><button type="button" className="sh-btn is-primary" onClick={p.review}>Review now</button></div>
        : <p className="sh-ok">Nothing left to check ✓</p>,
    },
  };
}
