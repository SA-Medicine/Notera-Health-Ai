'use client';

// The review layer for a generated note. The note comes first; nothing here sits between the clinician and the note.
//   bar        one slim sticky line: Draft reminder, "N to check", Review, Checklist, Full screen (and Undo after a fix)
//   marks      lines to check are marked IN the note (amber + a short reason chip); clicking one opens a small popover right under it
//   checklist  at the END of the note ("Before you sign"): every line to check with its fixes, and what Notera removed with an Add back option
//   fixes      Looks right, Edit line, Remove line, Swap left/right, "Use <suggested drug>" or type the drug, Add back to a chosen place
// A fix rewrites the note text (the same text Copy / Copy to EMR use), as if the clinician had typed it. The marks themselves are DOM-only.
// Flag sources (backend, Style Spec v2.1): grounding agent, fidelity guards, drug-name guard, side check, plus the older guardrail flags.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { findLine, heardFix, insertLine, lineText, norm, removeQuote, replaceLine, replaceWord, shownAs, splitLine, swapSides, targets } from './noteFix';

export type NoteFlag = { type: string; field?: string; message: string; severity?: string };
// What the clinician did about a flag. The Scribe screen saves these with the note (kept for learning, never applied automatically).
export type Correction = { at: string; flagType: string; flagMessage: string; label: string; action: 'kept' | 'edited' | 'removed' | 'side_swapped' | 'drug_changed' | 'added_back' | 'left_out' | 'undone'; before: string; after: string };

type Kind = { label: string; help: string; tone: 'warn' | 'changed' };
// label = the short chip shown on the line; help = one plain sentence when the model gave no reason
const KINDS: Record<string, Kind> = {
  check_against_recording: { label: 'Not clearly said', help: 'The recording does not clearly say this. Confirm it or edit it.', tone: 'warn' },
  laterality_check: { label: 'Check left/right', help: 'The side is not named in the recording for this body part.', tone: 'warn' },
  laterality_inversion: { label: 'Check left/right', help: 'Left and right may be the wrong way round.', tone: 'warn' },
  condition_not_said: { label: 'Condition not said', help: 'The recording does not name this condition.', tone: 'warn' },
  non_patient_context: { label: 'About someone else?', help: 'Someone else talks about themselves in the recording. Make sure none of it is in the note.', tone: 'warn' },
  dropped_declined_option: { label: 'Declined option', help: 'Something was offered and declined or put off. Add it to the plan if it matters.', tone: 'warn' },
  drug_indication_unclear: { label: 'Why this drug?', help: 'The reason for this drug is not clear from the recording.', tone: 'warn' },
  drug_not_heard: { label: 'Drug not named', help: 'The recording never names this drug, so the note shows its class. Type the drug you prescribed.', tone: 'warn' },
  medication_unverified: { label: 'Check drug name', help: 'This drug name does not match what was said in the recording.', tone: 'warn' },
  ungrounded_date: { label: 'Date removed', help: 'A date the recording does not give was taken out. Add the right one if you need it.', tone: 'changed' },
  removed_unsupported: { label: 'Removed', help: 'Taken out because the recording did not support it. Add it back if you did say it.', tone: 'changed' },
};

type Item = { id: number; type: string; kind: Kind; quote: string; text: string; why: string; raw: string };

/** `"the line" - why` -> the line and the reason; any other message is shown whole. */
function parse(f: NoteFlag, id: number): Item | null {
  const kind = KINDS[f.type];
  const sev = String(f.severity || 'info');
  if (!kind && !(sev === 'warning' || sev === 'critical')) return null;   // reference-wording notes and other info-only flags are not for the clinician
  const k: Kind = kind || { label: 'Check', help: '', tone: 'warn' };
  const raw = String(f.message || '');
  const m = raw.match(/^"([^"]+)"(?:\s+-\s+([\s\S]*))?$/);
  if (!m) return { id, type: f.type, kind: k, quote: '', text: raw.trim(), why: '', raw };
  let why = (m[2] || '').trim(); if (why.length >= 88 && !/[.!?'"]$/.test(why)) why += '…';   // the backend cuts long reasons
  return { id, type: f.type, kind: k, quote: m[1].trim(), text: m[1].trim(), why, raw };
}

const Icon = {
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></svg>,
};

type Apply = (next: string | null, label: string, action: Correction['action'], after?: string) => void;
type Keep = (action?: 'kept' | 'left_out') => void;

/** The fixes for one line. Used in the popover under a marked line and in the checklist at the end of the note. */
function Fixes({ it, note, apply, keep }: { it: Item; note: string; apply: Apply; keep: Keep }) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState('');
  const [where, setWhere] = useState(0);
  const idx = it.quote ? findLine(note, it.quote) : -1;
  const isTitle = idx >= 0 && splitLine(note.split('\n')[idx]).title;
  const shown = it.kind.tone === 'warn' ? shownAs(it.raw) : '';
  const heard = it.kind.tone === 'warn' ? heardFix(it.raw) : null;
  const canSwap = it.kind.label === 'Check left/right' && it.quote ? swapSides(note, it.quote) !== null : false;
  const places = useMemo(() => targets(note), [note]);

  if (it.kind.tone === 'changed') {   // removed or changed by Notera: add it back where it belongs
    if (!it.quote) return <div className="chk-actions"><button type="button" className="chk-btn ghost" onClick={() => keep('left_out')}>Dismiss</button></div>;
    return (
      <div className="chk-actions">
        <label className="chk-where">Add back to
          <select value={where} onChange={(e) => setWhere(Number(e.target.value))}>{places.map((p, i) => <option key={p.label + i} value={i}>{p.label}</option>)}</select>
        </label>
        <button type="button" className="chk-btn" disabled={!places.length} onClick={() => apply(insertLine(note, places[where], it.quote), 'Line added back', 'added_back', it.quote)}>Add back</button>
        <button type="button" className="chk-btn ghost" onClick={() => keep('left_out')}>Leave it out</button>
      </div>
    );
  }
  if (mode === 'edit') {
    return (
      <div className="chk-edit">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus aria-label="Edit the line" />
        <div className="chk-actions">
          <button type="button" className="chk-btn" disabled={!draft.trim()} onClick={() => apply(replaceLine(note, it.quote, draft), 'Line edited', 'edited', draft.trim())}>Save</button>
          <button type="button" className="chk-btn ghost" onClick={() => setMode('view')}>Cancel</button>
        </div>
      </div>
    );
  }
  if (shown || heard) {   // a drug name: type it, or take the suggestion in one click
    const from = shown || heard!.from; const suggest = heard?.suggest || '';
    const go = (v: string) => apply(replaceWord(note, from, v), 'Drug name changed', 'drug_changed', v.trim());
    return (
      <div className="chk-edit">
        <label className="chk-label">Drug name (replaces “{from}”)
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. pantoprazole 40 mg" onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) go(draft); }} />
        </label>
        <div className="chk-actions">
          <button type="button" className="chk-btn" disabled={!draft.trim()} onClick={() => go(draft)}>Use this drug</button>
          {suggest && <button type="button" className="chk-btn ghost" onClick={() => go(suggest)}>Use “{suggest}”</button>}
          <button type="button" className="chk-btn ghost" onClick={() => keep('kept')}>Looks right</button>
        </div>
      </div>
    );
  }
  return (
    <div className="chk-actions">
      <button type="button" className="chk-btn ok" onClick={() => keep('kept')}>Looks right</button>
      {idx >= 0 && <button type="button" className="chk-btn ghost" onClick={() => { setDraft(lineText(note, it.quote) || ''); setMode('edit'); }}>Edit line</button>}
      {canSwap && <button type="button" className="chk-btn ghost" onClick={() => apply(swapSides(note, it.quote), 'Side swapped', 'side_swapped')}>Swap left/right</button>}
      {idx >= 0 && !isTitle && <button type="button" className="chk-btn danger" onClick={() => apply(removeQuote(note, it.quote), 'Line removed', 'removed')}>Remove line</button>}
      {idx < 0 && it.quote && <span className="chk-muted">This line is no longer in the note.</span>}
    </div>
  );
}

type Props = {
  flags: NoteFlag[]; bodyRef?: RefObject<HTMLElement | null>; note: string; onChange: (md: string) => void; editing?: boolean;
  full?: boolean; onToggleFull?: () => void; endEl?: HTMLElement | null;
  onCorrection?: (e: Correction) => void; resolved?: string[];   // resolved = flag messages the clinician already dealt with (reopened note)
};

export default function NoteChecks({ flags, bodyRef, note, onChange, editing = false, full = false, onToggleFull, endEl, onCorrection, resolved }: Props) {
  const items = useMemo(() => (flags || []).map(parse).filter((x): x is Item => !!x), [flags]);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [cur, setCur] = useState(0);
  const [pop, setPop] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ md: string; id: number; label: string; it: Item } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const resolvedKey = (resolved || []).join('');
  useEffect(() => { const r = new Set(resolved || []); setDone(new Set(items.filter((i) => r.has(i.raw)).map((i) => i.id))); setReviewing(false); setCur(0); setUndo(null); }, [flags, resolvedKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 9000); return () => clearTimeout(t); }, [undo]);

  const warn = items.filter((i) => i.kind.tone === 'warn' && !done.has(i.id));
  const changed = items.filter((i) => i.kind.tone === 'changed' && !done.has(i.id));
  const pos = Math.min(cur, Math.max(warn.length - 1, 0));
  const item = warn[pos];
  const live = useRef({ warn, editing }); live.current = { warn, editing };

  // mark the lines in the note. Runs after the note body has been (re)written, hence the timeout (a parent effect rewrites innerHTML after child effects).
  useEffect(() => {
    const t = setTimeout(() => {
      const root = bodyRef?.current; if (!root) return;
      root.querySelectorAll('.flagged-line').forEach((el) => { el.classList.remove('flagged-line', 'flash', 'current'); el.removeAttribute('data-flag'); el.removeAttribute('data-fid'); });
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
  }, [warn.map((w) => w.id).join(','), note, bodyRef]);   // eslint-disable-line react-hooks/exhaustive-deps

  // clicking a marked line opens its popover
  useEffect(() => {
    const root = bodyRef?.current; if (!root) return;
    const onClick = (e: Event) => {
      if (live.current.editing) return;
      const el = (e.target as HTMLElement | null)?.closest?.('.flagged-line'); if (!el) return;
      const i = live.current.warn.findIndex((w) => String(w.id) === el.getAttribute('data-fid'));
      if (i >= 0) { setCur(i); setReviewing(true); }
    };
    root.addEventListener('click', onClick); return () => root.removeEventListener('click', onClick);
  }, [bodyRef]);

  // the popover sits right under the current line (inside the scrolling note, so it moves with it)
  useEffect(() => {
    const root = bodyRef?.current; const box = root?.parentElement;
    if (!reviewing || !item || !root || !box) { setPop(null); return; }
    root.querySelectorAll('.flagged-line.current').forEach((el) => el.classList.remove('current'));
    const t = setTimeout(() => {
      const el = Array.from(root.querySelectorAll<HTMLElement>('.flagged-line')).find((m) => m.getAttribute('data-fid') === String(item.id));
      if (el) {
        el.classList.add('current'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        const r = el.getBoundingClientRect(); const b = box.getBoundingClientRect();
        setPop(r.bottom - b.top + box.scrollTop + 8);
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else setPop(box.scrollTop + 64);   // a line that is not in the note (a drug flag): the popover opens at the top of what you are reading
      setTimeout(() => popRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 120);
    }, 40);
    return () => clearTimeout(t);
  }, [reviewing, item?.id, note, bodyRef]);   // eslint-disable-line react-hooks/exhaustive-deps

  const report = (it: Item, action: Correction['action'], before: string, after = '') => onCorrection?.({ at: new Date().toISOString(), flagType: it.type, flagMessage: it.raw, label: it.kind.label, action, before, after });
  const finish = (it: Item, action: 'kept' | 'left_out' = 'kept') => { report(it, action, it.quote || it.text); setDone((d) => new Set(d).add(it.id)); if (reviewing && warn.length <= 1) setReviewing(false); };
  const applyFor = (it: Item): Apply => (next, label, action, after) => {
    if (next === null) return;
    report(it, action, (it.quote && lineText(note, it.quote)) || it.quote || it.text, after);
    setUndo({ md: note, id: it.id, label, it }); onChange(next); setDone((d) => new Set(d).add(it.id)); if (reviewing && warn.length <= 1) setReviewing(false);
  };
  const undoFix = () => { if (!undo) return; report(undo.it, 'undone', undo.it.quote || undo.it.text); onChange(undo.md); setDone((d) => { const n = new Set(d); n.delete(undo.id); return n; }); setUndo(null); };
  const step = (d: number) => { if (warn.length) setCur((pos + d + warn.length) % warn.length); };
  const toEnd = () => { setReviewing(false); endEl?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };

  const checklist = (items.length > 0) && (
    <section className="chk-end" aria-label="Before you sign">
      <h4>Before you sign{warn.length > 0 ? <span className="chk-end-n">{warn.length} to check</span> : <span className="chk-end-ok">All checked ✓</span>}</h4>
      {warn.map((it) => (
        <div className="chk-item" key={it.id}>
          <div className="chk-item-head"><span className="chk-chip">{it.kind.label}</span><span className="chk-item-text">{it.text}</span></div>
          <p className="chk-muted">{it.why || it.kind.help}</p>
          {editing ? <p className="chk-muted">Press Done in the toolbar first, then use these fixes.</p> : <Fixes key={it.id + ':' + (it.quote ? findLine(note, it.quote) : -1)} it={it} note={note} apply={applyFor(it)} keep={(a) => finish(it, a)} />}
        </div>
      ))}
      {changed.length > 0 && <h5>Notera removed or changed these on its own</h5>}
      {changed.map((it) => (
        <div className="chk-item changed" key={it.id}>
          <div className="chk-item-head"><span className="chk-chip quiet">{it.kind.label}</span><span className="chk-item-text">{it.text}</span></div>
          <p className="chk-muted">{it.why || it.kind.help}</p>
          {editing ? null : <Fixes it={it} note={note} apply={applyFor(it)} keep={(a) => finish(it, a)} />}
        </div>
      ))}
    </section>
  );

  return (
    <>
    <div className="note-checks" aria-label="Before you sign">
      <div className={`draft-bar${warn.length ? ' has-checks' : ''}`} role="note">
        <span className="draft-bar-ico">{Icon.shield}</span>
        {undo ? <span className="draft-bar-text">{undo.label}. <button type="button" className="chk-link" onClick={undoFix}>Undo</button></span>
          : <span className="draft-bar-text"><strong>Draft.</strong> Read every line before you sign.</span>}
        {warn.length > 0 ? (
          <>
            <span className="draft-bar-count" aria-label={`${warn.length} to check`}>{warn.length} to check</span>
            <button type="button" className="chk-btn" onClick={() => setReviewing(true)} disabled={editing} title={editing ? 'Press Done first' : undefined}>Review</button>
          </>
        ) : items.length > 0 ? <span className="draft-bar-ok">All checked ✓</span> : null}
        {items.length > 0 && endEl && <button type="button" className="chk-btn ghost" onClick={toEnd}>Checklist ↓</button>}
        {onToggleFull && <button type="button" className="chk-btn ghost" onClick={onToggleFull} aria-pressed={full}>{full ? 'Exit full screen' : 'Full screen'}</button>}
      </div>
    </div>

      {reviewing && item && pop !== null && !editing && (
        <div className="chk-pop" ref={popRef} style={{ top: pop }} role="region" aria-live="polite" aria-label="Line to check">
          <div className="chk-pop-top">
            <span className="chk-chip">{item.kind.label}</span>
            <span className="chk-pos">{pos + 1} of {warn.length}</span>
            <span className="chk-spacer" />
            {warn.length > 1 && <><button type="button" className="chk-icon" onClick={() => step(-1)} aria-label="Previous line">‹</button><button type="button" className="chk-icon" onClick={() => step(1)} aria-label="Next line">›</button></>}
            <button type="button" className="chk-icon" onClick={() => setReviewing(false)} aria-label="Close">✕</button>
          </div>
          <p className="chk-muted">{item.why || item.kind.help}</p>
          <Fixes key={item.id + ':' + (item.quote ? findLine(note, item.quote) : -1)} it={item} note={note} apply={applyFor(item)} keep={(a) => finish(item, a)} />
        </div>
      )}

      {endEl ? createPortal(checklist, endEl) : null}
    </>
  );
}
