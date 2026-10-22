'use client';

// "Read before you sign" for a generated note.
//   - one slim bar: draft reminder, how many lines to check, Next (jumps to the next marked line) and List (the same lines as a plain list)
//   - the lines to check are marked IN the note (amber, with a short reason), so the clinician reads the note, not a second report
//   - what Notera removed or changed on its own is listed separately (grey, collapsed)
// The marks are DOM-only (a class and a data attribute): nothing here is copied to the EMR or saved into the note text.
// Flag sources (backend, Style Spec v2.1): grounding agent, fidelity guards, drug-name guard, side check, plus the older guardrail flags.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

export type NoteFlag = { type: string; field?: string; message: string; severity?: string };

type Kind = { label: string; help: string; tone: 'warn' | 'changed' };
// label = the short chip shown on the line; help = one plain sentence for the list
const KINDS: Record<string, Kind> = {
  check_against_recording: { label: 'Not clearly said', help: 'The recording does not clearly say this. Confirm it or edit it.', tone: 'warn' },
  laterality_check: { label: 'Check left/right', help: 'The side is not named in the recording for this body part.', tone: 'warn' },
  laterality_inversion: { label: 'Check left/right', help: 'Left and right may be the wrong way round.', tone: 'warn' },
  condition_not_said: { label: 'Condition not said', help: 'The recording does not name this condition.', tone: 'warn' },
  non_patient_context: { label: 'About someone else?', help: 'Someone else talks about themselves in the recording. Make sure none of it is in the note.', tone: 'warn' },
  dropped_declined_option: { label: 'Declined option', help: 'Something was offered and declined or put off. Add it to the plan if it matters.', tone: 'warn' },
  drug_indication_unclear: { label: 'Why this drug?', help: 'The reason for this drug is not clear from the recording.', tone: 'warn' },
  drug_not_heard: { label: 'Drug not named', help: 'The recording never names this drug, so the note shows its class. Write in the drug you prescribed.', tone: 'warn' },
  medication_unverified: { label: 'Check drug name', help: 'This drug name does not match what was said in the recording.', tone: 'warn' },
  ungrounded_date: { label: 'Date removed', help: 'A date the recording does not give was taken out. Add the right one if you need it.', tone: 'changed' },
  removed_unsupported: { label: 'Removed', help: 'Taken out because the recording did not support it. Add it back if you did say it.', tone: 'changed' },
};

type Item = { id: number; kind: Kind; quote: string; text: string; why: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** `"the line" - why` -> the line and the reason; any other message is shown whole. */
function parse(f: NoteFlag, id: number): Item | null {
  const kind = KINDS[f.type];
  const sev = String(f.severity || 'info');
  if (!kind && !(sev === 'warning' || sev === 'critical')) return null;   // reference-wording notes and other info-only flags are not for the clinician
  const k: Kind = kind || { label: 'Check', help: '', tone: 'warn' };
  const m = String(f.message || '').match(/^"([^"]+)"(?:\s+-\s+([\s\S]*))?$/);
  return m ? { id, kind: k, quote: m[1].trim(), text: m[1].trim(), why: (m[2] || '').trim() } : { id, kind: k, quote: '', text: String(f.message || '').trim(), why: '' };
}

const Icon = {
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></svg>,
};

export default function NoteChecks({ flags, bodyRef, noteKey }: { flags: NoteFlag[]; bodyRef?: RefObject<HTMLElement | null>; noteKey?: string }) {
  const items = useMemo(() => (flags || []).map(parse).filter((x): x is Item => !!x), [flags]);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false);
  const cursor = useRef(-1);
  useEffect(() => { setDone(new Set()); setOpen(false); cursor.current = -1; }, [flags]);

  const warn = items.filter((i) => i.kind.tone === 'warn' && !done.has(i.id));
  const changed = items.filter((i) => i.kind.tone === 'changed');

  // mark the lines in the note. Runs after the note body has been (re)written, hence the timeout (a parent effect rewrites innerHTML after child effects).
  useEffect(() => {
    const t = setTimeout(() => {
      const root = bodyRef?.current; if (!root) return;
      root.querySelectorAll('.flagged-line').forEach((el) => { el.classList.remove('flagged-line', 'flash'); el.removeAttribute('data-flag'); el.removeAttribute('data-fid'); });
      const els = Array.from(root.querySelectorAll('li, p'));
      const texts = els.map((el) => norm(el.textContent || ''));
      for (const it of warn) {
        if (!it.quote) continue;
        const needle = norm(it.quote).slice(0, 40); if (needle.length < 3) continue;
        const idx = texts.findIndex((tx, i) => (needle.length >= 8 ? tx.includes(needle) : tx === needle) && !els[i].classList.contains('flagged-line'));   // a short quote must be the whole line
        if (idx >= 0) { els[idx].classList.add('flagged-line'); els[idx].setAttribute('data-flag', it.kind.label); els[idx].setAttribute('data-fid', String(it.id)); }
      }
    }, 0);
    return () => clearTimeout(t);
  }, [warn.map((w) => w.id).join(','), noteKey, bodyRef]);   // eslint-disable-line react-hooks/exhaustive-deps

  const jump = (fid?: number) => {
    const root = bodyRef?.current; if (!root) return;
    const marked = Array.from(root.querySelectorAll<HTMLElement>('.flagged-line'));
    if (!marked.length) return;
    let el: HTMLElement | undefined;
    if (fid !== undefined) el = marked.find((m) => m.getAttribute('data-fid') === String(fid));
    if (!el) { cursor.current = (cursor.current + 1) % marked.length; el = marked[cursor.current]; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  };

  return (
    <div className="note-checks" aria-label="Before you sign">
      <div className={`draft-bar${warn.length ? ' has-checks' : ''}`} role="note">
        <span className="draft-bar-ico">{Icon.shield}</span>
        <span className="draft-bar-text"><strong>Draft.</strong> Read every line before you sign.{warn.length > 0 && <> Lines to check are marked in the note.</>}</span>
        {warn.length > 0 ? (
          <>
            <span className="draft-bar-count" aria-label={`${warn.length} to check`}>{warn.length} to check</span>
            <button type="button" className="chk-btn" onClick={() => jump()}>Next</button>
            <button type="button" className="chk-btn ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Hide list' : 'List'}</button>
          </>
        ) : items.length > 0 ? <span className="draft-bar-ok">All checked</span> : null}
      </div>
      {open && warn.length > 0 && (
        <ul className="chk-list">
          {warn.map((it) => (
            <li key={it.id} className="chk-row">
              <span className="chk-chip">{it.kind.label}</span>
              <button type="button" className="chk-text" onClick={() => jump(it.id)} title={it.kind.help}>{it.text.length > 140 ? it.text.slice(0, 140) + '…' : it.text}</button>
              <button type="button" className="chk-done" onClick={() => setDone((d) => new Set(d).add(it.id))} aria-label="Mark as checked">Checked</button>
            </li>
          ))}
        </ul>
      )}
      {changed.length > 0 && (
        <details className="chk-changed">
          <summary>Notera removed or changed {changed.length} {changed.length === 1 ? 'line' : 'lines'} on its own</summary>
          <ul>
            {changed.map((it) => <li key={it.id}><strong>{it.text.length > 120 ? it.text.slice(0, 120) + '…' : it.text}</strong>{it.why ? <span> - {it.why}</span> : null}</li>)}
          </ul>
          <p>Add a line back if you did say it.</p>
        </details>
      )}
    </div>
  );
}
