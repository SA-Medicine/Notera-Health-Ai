'use client'

// Medicines box under the note: every drug the note names, checked against RxNorm (the NIH drug database) for its name and its dose.
// One click takes the suggested name; or type the right drug. The change is made in the note text and saved with the corrections, like every other fix.
import { useEffect, useMemo, useState } from 'react'
import type { NoteFlag, Correction } from './NoteChecks'
import { replaceWord } from './noteFix'

type Row = { name: string; line: string; verified: boolean; suggestion: string; dose: string; strengths: string[]; doseOk: boolean; source: string }

export default function DrugBox({ flags, note, onChange, onCorrection }: { flags: NoteFlag[]; note: string; onChange: (md: string) => void; onCorrection?: (c: Correction) => void }) {
  const rows = useMemo(() => (flags || []).filter((f) => f.type === 'drug_review').map((f) => { try { return JSON.parse(f.message) as Row } catch { return null } }).filter((r): r is Row => !!r), [flags])
  const [edit, setEdit] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [done, setDone] = useState<Record<string, string>>({})
  // the clinician can switch the drug suggestions off (and on again); the choice is remembered in this browser
  const [on, setOn] = useState(true)
  useEffect(() => { try { setOn(localStorage.getItem('notera.drugSuggest') !== 'off') } catch { /* private window */ } }, [])
  const toggle = () => setOn((v) => { const n = !v; try { localStorage.setItem('notera.drugSuggest', n ? 'on' : 'off') } catch { /* */ } return n })
  if (!rows.length) return null

  const first = (r: Row) => r.name.split(' ')[0]
  const inNote = (r: Row) => new RegExp('(?<![A-Za-z])' + first(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i').test(note)
  const swap = (r: Row, to: string) => {
    const next = replaceWord(note, first(r), to); if (!next) return
    onChange(next); setDone((d) => ({ ...d, [r.name]: to })); setEdit(null); setDraft('')
    onCorrection?.({ at: new Date().toISOString(), flagType: 'drug_review', flagMessage: `drug name ${first(r)}`, label: 'Drug name', action: 'drug_changed', before: first(r), after: to })
  }
  const status = (r: Row) => done[r.name] ? { cls: 'ok', text: `Changed to ${done[r.name]}` }
    : !r.verified ? { cls: 'warn', text: r.suggestion ? `Not a known drug. Did you mean ${r.suggestion}?` : 'Not a known drug name' }
    : !r.doseOk ? { cls: 'warn', text: `${r.dose} is not a strength it comes in (${r.strengths.join(', ')})` }
    : { cls: 'ok', text: r.dose ? `Known drug, ${r.dose} is a real strength` : 'Known drug' }

  return (
    <section className={`drug-box${on ? '' : ' is-off'}`} aria-label="Medicines in this note">
      <h4>Medicines in this note <small>{on ? 'checked against RxNorm' : 'suggestions off'}</small>
        <label className="drug-toggle"><input type="checkbox" checked={on} onChange={toggle} />Drug suggestions</label></h4>
      <ul>
        {rows.filter(inNote).concat(rows.filter((r) => !inNote(r) && done[r.name])).map((r) => {
          const s = status(r)
          return (
            <li key={r.name} className={`drug-row is-${s.cls}`}>
              <div className="drug-main"><b>{done[r.name] || r.name}</b>{r.dose && <span className="drug-dose">{r.dose}</span>}<span className={`drug-status is-${s.cls}`}>{s.text}</span></div>
              {edit === r.name ? (
                <div className="drug-edit">
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type the drug, e.g. candesartan" onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) swap(r, draft.trim()); if (e.key === 'Escape') setEdit(null) }} aria-label={`Correct ${r.name}`} />
                  <button type="button" className="chk-btn" disabled={!draft.trim()} onClick={() => swap(r, draft.trim())}>Change</button>
                  <button type="button" className="chk-btn ghost" onClick={() => setEdit(null)}>Cancel</button>
                </div>
              ) : !done[r.name] && (
                <div className="drug-actions">
                  {r.suggestion && <button type="button" className="chk-btn" onClick={() => swap(r, r.suggestion)}>Use {r.suggestion}</button>}
                  <button type="button" className="chk-btn ghost" onClick={() => { setEdit(r.name); setDraft('') }}>Edit</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
