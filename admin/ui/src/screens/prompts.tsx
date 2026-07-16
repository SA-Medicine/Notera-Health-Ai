import * as React from 'react'
import { api, type PromptMeta, type PromptDetail, type AgentLogRun } from '@/lib/api'
import { cn, shortId } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/badge'
import { toast } from 'sonner'
import type { TabId } from '@/lib/nav'

const PIPELINE: { k: 'prompt' | 'js'; id?: string; label?: string }[] = [
  { k: 'prompt', id: 'encounter-classifier' }, { k: 'prompt', id: 'observation-extractor' },
  { k: 'js', label: 'Recall Analyzer' }, { k: 'prompt', id: 'fact-recovery' },
  { k: 'js', label: 'Problem Graph → Engines' }, { k: 'js', label: 'Story / Narrative' },
  { k: 'prompt', id: 'qa-validator' }, { k: 'js', label: 'FHIR Export' },
]

export function Prompts({ setTab }: { setTab: (t: TabId) => void }) {
  const [data, setData] = React.useState<{ readOnly: boolean; prompts: PromptMeta[] }>({ readOnly: false, prompts: [] })
  const [sel, setSel] = React.useState(() => localStorage.getItem('notera_sel') || '')
  const [detail, setDetail] = React.useState<PromptDetail | null>(null)
  const [edit, setEdit] = React.useState(''); const [note, setNote] = React.useState('')
  const [freeform, setFreeform] = React.useState(false); const [maxTok, setMaxTok] = React.useState(''); const [schema, setSchema] = React.useState('')
  const [panel, setPanel] = React.useState<'none' | 'history' | 'logs' | 'schema'>('none'); const [logs, setLogs] = React.useState<AgentLogRun[] | null>(null); const [openRun, setOpenRun] = React.useState('')
  const load = React.useCallback((keep?: boolean) => api.prompts().then((d) => { setData(d); if (!keep && !sel && d.prompts[0]) setSel(d.prompts[0].id) }).catch(() => {}), [sel])
  React.useEffect(() => { load() }, [])
  React.useEffect(() => { if (sel) localStorage.setItem('notera_sel', sel) }, [sel])
  const loadDetail = React.useCallback((id: string) => { if (!id) return; api.prompt(id).then((d) => { setDetail(d); setEdit(d.draft ? d.draft.systemInstruction : d.published?.systemInstruction || ''); setNote(d.draft?.note || ''); setFreeform(d.freeform === true); setMaxTok(d.maxOutputTokens ? String(d.maxOutputTokens) : ''); setSchema(d.schema || ''); setPanel('none'); setLogs(null) }).catch(() => {}) }, [])
  React.useEffect(() => { if (sel) loadDetail(sel) }, [sel])
  const pub = detail?.published?.systemInstruction || ''; const dirty = !!detail && edit !== pub; const ro = data.readOnly
  const flash = (t: string, ok = true) => toast[ok ? 'success' : 'error'](t)
  const saveDraft = async () => { await api.savePromptDraft(sel, edit, note); flash('Draft saved'); load(true); loadDetail(sel) }
  const publish = async () => { if (!confirm('Publish this prompt as a new version? It changes live pipeline behavior on the next run.')) return; if (dirty || !detail?.draft) await api.savePromptDraft(sel, edit, note); const r: any = await api.publishPrompt(sel); flash(r.ok ? 'Published v' + r.publishedVersion : r.error || 'nothing to publish', !!r.ok); load(true); loadDetail(sel) }
  const revert = async () => { if (!confirm('Discard the current draft?')) return; await api.revertPrompt(sel); flash('Draft discarded', false); load(true); loadDetail(sel) }
  const saveConfig = async (nf: boolean, nt: string) => { setFreeform(nf); setMaxTok(nt); const r: any = await api.promptConfig(sel, { freeform: nf, maxOutputTokens: nt === '' ? null : Number(nt) }); flash(r.ok ? 'Config saved' : 'Save failed — restart the server', !!r.ok); load(true) }
  const saveSchema = async () => { const r: any = await api.promptConfig(sel, { schema }); flash(r.ok ? 'Schema saved' : 'Save failed — restart the server', !!r.ok); load(true) }
  const showLogs = () => { setPanel(panel === 'logs' ? 'none' : 'logs'); if (!logs) api.promptLogs(sel).then((d) => { setLogs(d || []); const f = (d || []).find((r) => r.fixtures?.length); setOpenRun(f ? f.id : '') }).catch(() => setLogs([])) }
  const rollback = async (v: number) => { if (!confirm('Roll back to v' + v + '?')) return; const x = await api.promptVersion(sel, v); await api.savePromptDraft(sel, x.systemInstruction, 'rollback to v' + v); const r: any = await api.publishPrompt(sel); flash(r.ok ? 'Rolled back → v' + r.publishedVersion : 'error', !!r.ok); load(true); loadDetail(sel) }
  const pmap = Object.fromEntries((data.prompts || []).map((p) => [p.id, p]))
  const inactive = (data.prompts || []).filter((p) => !p.active && p.id !== 'judge-clinical'); const judge = pmap['judge-clinical']
  const gnode = (n: { k: string; id?: string; label?: string }) => {
    if (n.k === 'js') return <div key={n.label} className="shrink-0 px-3 py-2 rounded-lg border border-dashed border-border bg-surface text-muted-foreground text-xs whitespace-nowrap self-center">{n.label}</div>
    const p = pmap[n.id!]; if (!p) return null; const on = sel === p.id
    return <button key={p.id} onClick={() => setSel(p.id)} title={p.description} className={cn('shrink-0 px-3 py-2 rounded-lg border text-left whitespace-nowrap transition', on ? 'border-primary bg-raised shadow-card' : cn('bg-surface hover:bg-accent', p.active ? 'border-border' : 'border-border opacity-70'))}>
      <div className="flex items-center gap-1.5"><span className={cn('w-1.5 h-1.5 rounded-full', p.active ? 'bg-success' : 'bg-muted-foreground')} /><span className={cn('text-sm', on ? 'text-foreground' : 'text-foreground/80')}>{p.id}</span>{p.hasDraft && <span className="w-1.5 h-1.5 rounded-full bg-warning" />}</div>
      <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{p.stage} · v{p.publishedVersion || '—'}</div></button>
  }
  return (
    <div className="p-6 flex flex-col gap-4 h-[calc(100vh-56px)]">
      <div className="shrink-0 rounded-xl border border-border bg-background p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Pipeline flow — click a green node to edit its prompt</div>
        <div className="flex items-stretch gap-1 overflow-x-auto pb-1">{PIPELINE.map((n, i) => <React.Fragment key={i}>{i > 0 && <span className="self-center text-muted-foreground px-0.5">→</span>}{gnode(n)}</React.Fragment>)}</div>
        {(inactive.length > 0 || judge) && <><div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-3 mb-1.5">Not wired · judge</div>
          <div className="flex items-stretch gap-2 flex-wrap">{inactive.map((p) => gnode({ k: 'prompt', id: p.id }))}{judge && gnode({ k: 'prompt', id: 'judge-clinical' })}</div></>}
      </div>
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {!detail ? <div className="text-muted-foreground text-sm">Select a node above to edit its prompt.</div> : <>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="font-semibold text-foreground">{detail.id}</span><span className="text-xs font-mono text-muted-foreground truncate">{detail.file}</span>
            <span className="text-[11px] bg-raised text-foreground/80 rounded px-2 py-0.5">{detail.agent}</span><div className="flex-1" />
            {ro && <span className="text-[11px] text-warning border border-warning/40 rounded px-2 py-0.5">read-only</span>}
            <Button size="sm" variant="secondary" onClick={() => setTab('results')}>Results →</Button>
          </div>
          <p className="text-muted-foreground text-xs mb-2">{detail.description}</p>
          <div className="flex items-center gap-3 mb-3 flex-wrap bg-background border border-border rounded-lg px-3 py-2">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Runtime</span>
            <label className="flex items-center gap-1.5 text-xs text-foreground/80 cursor-pointer"><input type="checkbox" checked={freeform} disabled={ro} onChange={(e) => saveConfig(e.target.checked, maxTok)} /> Freeform output <span className="text-muted-foreground">(ignore fixed schema)</span></label>
            <span className="text-border">·</span>
            <label className="flex items-center gap-1.5 text-xs text-foreground/80">Max tokens<input type="number" value={maxTok} disabled={ro} placeholder="default" onChange={(e) => setMaxTok(e.target.value)} onBlur={(e) => saveConfig(freeform, e.target.value)} className="w-24 bg-surface border border-border rounded px-2 py-1 text-xs" /></label>
            {freeform && <span className="text-[11px] text-warning">⚠ output shape not guaranteed</span>}
          </div>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => setPanel(panel === 'history' ? 'none' : 'history')}>History ({detail.versions?.length || 0})</Button>
            <Button size="sm" variant="outline" onClick={showLogs}>Logs</Button>
            {sel === 'qa-validator' && <Button size="sm" variant="outline" onClick={() => setPanel(panel === 'schema' ? 'none' : 'schema')}>Output schema</Button>}
            {dirty && <span className="text-xs text-warning">● unsaved</span>}<div className="flex-1" />
            {dirty && <Button size="sm" variant="ghost" onClick={() => setEdit(pub)}>Reset</Button>}
            {detail.hasDraft && <Button size="sm" variant="ghost" onClick={revert}>Discard draft</Button>}
            <Button size="sm" variant="secondary" onClick={saveDraft} disabled={ro || !dirty}>Save draft</Button>
            <Button size="sm" onClick={publish} disabled={ro}>Publish</Button>
          </div>
          {panel === 'history' && <div className="mb-3 bg-background border border-border rounded-lg p-2 max-h-48 overflow-auto text-xs">
            {(detail.versions || []).slice().reverse().map((v) => <div key={v.version} className="flex items-center gap-2 py-1"><span className={cn('font-mono', v.version === detail.publishedVersion ? 'text-primary' : 'text-muted-foreground')}>v{v.version}{v.version === detail.publishedVersion && ' ● live'}</span><span className="text-muted-foreground truncate flex-1">{v.note} · {v.author}</span><button onClick={() => api.promptVersion(sel, v.version).then((x) => setEdit(x.systemInstruction))} className="text-info hover:underline">load</button>{v.version !== detail.publishedVersion && <button onClick={() => rollback(v.version)} className="text-warning hover:underline">rollback</button>}</div>)}
          </div>}
          {panel === 'logs' && logs && <div className="mb-3 bg-background border border-border rounded-lg p-2 max-h-72 overflow-auto text-xs">
            <div className="text-muted-foreground mb-1">{detail.agent} output in recent runs:</div>
            {logs.filter((r) => r.fixtures?.length).length === 0 ? <div className="text-muted-foreground">No output found. Run the tester, then reopen.</div>
              : logs.filter((r) => r.fixtures?.length).map((r) => <div key={r.id} className="mb-2 border border-border rounded-lg overflow-hidden"><button onClick={() => setOpenRun(openRun === r.id ? '' : r.id)} className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-accent"><StatusPill status={r.status} /><span className="font-mono text-foreground/80">{shortId(r.resultDir || r.id)}</span></button>{openRun === r.id && <div className="p-2 space-y-2 border-t border-border">{r.fixtures.map((fx, i) => <div key={i}><div className="text-primary text-[11px] font-mono mb-0.5">{fx.fixture}</div><pre className="logpane whitespace-pre-wrap text-foreground/80 bg-surface rounded p-2">{fx.lines.join('\n')}</pre></div>)}</div>}</div>)}
          </div>}
          {panel === 'schema' && sel === 'qa-validator' && <div className="mb-3 bg-background border border-primary/40 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5"><span className="text-[11px] uppercase tracking-wide text-primary">Output schema — appended to every QA call</span><div className="flex-1" /><Button size="sm" onClick={saveSchema}>Save schema</Button></div>
            <p className="text-[11px] text-muted-foreground mb-2">Add named numeric fields; they're auto-detected each run and plotted in Metrics. Turn on Freeform so this schema controls the output.</p>
            <Textarea value={schema} onChange={(e) => setSchema(e.target.value)} className="h-40 logpane" placeholder={'{\n  "status": "PASS|LOW|FAIL",\n  "clarity_score": 0\n}'} />
          </div>}
          <div className="flex-1 flex flex-col min-h-0 border border-border rounded-xl bg-surface overflow-hidden">
            <div className="px-3 py-2 border-b border-border text-sm font-semibold text-foreground flex items-center gap-2"><span className={cn('w-2 h-2 rounded-full', dirty ? 'bg-warning' : 'bg-primary')} />Editor<span className="text-xs text-muted-foreground font-mono">live: v{detail.publishedVersion || '—'}</span></div>
            <Textarea value={edit} onChange={(e) => setEdit(e.target.value)} readOnly={ro} spellCheck={false} className="flex-1 rounded-none border-0 logpane bg-background resize-none" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="change note (like a commit message)…" className="border-t border-border bg-surface px-3 py-2 text-xs text-foreground/80 outline-none" />
          </div>
        </>}
      </div>
    </div>
  )
}
