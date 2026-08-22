import * as React from 'react'
import { api, useRunStream, type RunRec } from '@/lib/api'
import { cn } from '@notera/ui/lib/utils'
import { Button } from '@notera/ui/components/ui/button'
import { Input } from '@notera/ui/components/ui/input'
import { Card } from '@notera/ui/components/ui/card'
import { StatusPill } from '@notera/ui/components/ui/badge'
import { EmptyState } from '@notera/ui/components/ui/skeleton'
import { toast } from 'sonner'
import { Play, Square, Download, Search, CheckSquare, X } from 'lucide-react'

// Pretty label for a fixture slug: "htn-umbilical-hernia" → "Htn Umbilical Hernia"
const pretty = (f: string) => f.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

type Pt = { slug: string; name: string; hasFixture: boolean; hasGold: boolean }

export function Run({ onStatus }: { onStatus: (s: string) => void }) {
  const [pts, setPts] = React.useState<Pt[]>([])
  const [onDiskCount, setOnDiskCount] = React.useState(0)
  const [mode, setMode] = React.useState<'all' | 'range' | 'pick'>('all')
  const [from, setFrom] = React.useState(1)
  const [to, setTo] = React.useState(10)
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [q, setQ] = React.useState('')
  const [runId, setRunId] = React.useState<string | null>(() => (typeof window !== 'undefined' ? localStorage.getItem('notera_run') : null))
  const [history, setHistory] = React.useState<RunRec[]>([])
  const [filter, setFilter] = React.useState('')
  const { lines, status, setStatus } = useRunStream(runId)
  const paneRef = React.useRef<HTMLDivElement>(null)

  const fixtures = React.useMemo(() => pts.map((p) => p.slug), [pts])
  const total = fixtures.length
  const nameOf = React.useMemo(() => { const m = new Map<string, string>(); pts.forEach((p) => m.set(p.slug, p.name || pretty(p.slug))); return m }, [pts])
  const label = React.useCallback((f: string) => nameOf.get(f) || pretty(f), [nameOf])
  const posOf = React.useMemo(() => { const m = new Map<string, number>(); fixtures.forEach((f, i) => m.set(f, i + 1)); return m }, [fixtures])

  // Range is by POSITION (1..N) in the list, so it works for any names (the imported
  // Heidi cases have no number in their name, which broke the old numeric range).
  const lo = Math.max(1, Math.min(from, to))
  const hi = Math.min(total, Math.max(from, to))
  const rangeSel = React.useMemo(() => (total ? fixtures.slice(lo - 1, hi) : []), [fixtures, lo, hi, total])

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? fixtures.filter((f) => f.toLowerCase().includes(s) || label(f).toLowerCase().includes(s)) : fixtures
  }, [fixtures, q, label])

  const loadHist = React.useCallback(() => api.runs().then(setHistory).catch(() => {}), [])
  const autoCompareLatest = React.useCallback(async () => {
    try {
      const d = await api.labRuns(); const latest = d.runs?.[0]; if (!latest) return
      const r = await api.autocompare(latest.id)
      if (r.ok && (r.generated || 0) > 0) toast.success(`Scored ${r.generated} note(s) vs gold for the Upgrader`)
    } catch { /* comparisons are optional */ }
  }, [])
  React.useEffect(() => { api.runPatients().then((d) => { setPts(d.patients || []); setOnDiskCount(d.onDiskCount || 0) }).catch(() => {}); loadHist() }, [loadHist])
  React.useEffect(() => { onStatus(status); if (status !== 'running' && runId) { loadHist(); if (status === 'passed') { toast.success('Run passed'); autoCompareLatest() } else if (status === 'failed' || status === 'error') toast.error('Run ' + status) } }, [status])
  React.useEffect(() => { const el = paneRef.current; if (el) el.scrollTop = el.scrollHeight }, [lines])
  // Live progress: poll the run registry while a scan is running so a 150-patient run shows done/total.
  const [curProg, setCurProg] = React.useState<{ done: number; total: number; current: string | null; phase: string } | null>(null)
  React.useEffect(() => {
    if (status !== 'running') { setCurProg(null); return }
    let stopped = false
    const tick = async () => { try { const rs = await api.runs(); const r = rs.find((x) => x.id === runId); if (!stopped) setCurProg((r?.progress as any) || null) } catch {} }
    tick(); const iv = setInterval(tick, 3000); return () => { stopped = true; clearInterval(iv) }
  }, [status, runId])
  const resume = async (id: string) => { try { const r = await api.resumeRun(id); if (r.ok && r.runId) { setRunId(r.runId); setStatus('running'); onStatus('running'); loadHist(); toast.success('Resumed remaining fixtures') } else toast.error(r.error || 'Cannot resume') } catch { toast.error('Resume failed') } }
  const retry = async (id: string) => { try { const r = await api.retryRun(id); if (r.ok && r.runId) { setRunId(r.runId); setStatus('running'); onStatus('running'); loadHist(); toast.success('Re-running (fresh)') } else toast.error(r.error || 'Cannot retry') } catch { toast.error('Retry failed') } }
  // Persist the active run across page refresh, and auto-reconnect to whatever is still running.
  React.useEffect(() => { if (runId) localStorage.setItem('notera_run', runId); else localStorage.removeItem('notera_run') }, [runId])
  React.useEffect(() => { if (runId) return; api.runs().then((rs) => { const r = rs.find((x) => x.status === 'running'); if (r) { setRunId(r.id); setStatus('running') } }).catch(() => {}) }, [])
  React.useEffect(() => { if (status !== 'running' && status !== 'idle' && runId) localStorage.removeItem('notera_run') }, [status, runId])

  const chosen = () => (mode === 'all' ? [] : mode === 'range' ? rangeSel : [...picked])
  const willRun = mode === 'all' ? onDiskCount : mode === 'range' ? rangeSel.length : picked.size
  // Selected slugs are passed as CLI args; Windows caps the command line (~32KB), so a
  // single explicit batch is bounded. Bigger runs → run in chunks (or use All-on-disk).
  const MAX_BATCH = 800
  const tooMany = mode !== 'all' && willRun > MAX_BATCH
  const start = async () => {
    if (tooMany || willRun === 0) return
    const sel = chosen()
    try {
      const r = await api.startRun(sel)
      if (!r?.runId) { toast.error((r as any)?.error || 'Could not start the run (no run id returned).'); return }
      setRunId(r.runId); setStatus('running'); onStatus('running'); loadHist()
    } catch (e: any) {
      toast.error('Failed to start run — ' + (e?.unauth ? 'session expired, sign in again' : (e?.message || 'backend unreachable')))
    }
  }
  const stop = async () => { if (runId) await api.killRun(runId) }
  const download = () => { const blob = new Blob([lines.map((l) => l.line).join('\n')], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (runId || 'run') + '.log'; a.click() }
  const shown = lines.filter((l) => !filter || l.line.toLowerCase().includes(filter.toLowerCase()))

  const toggle = (f: string) => setPicked((prev) => { const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n })
  const selectAllFiltered = () => setPicked((prev) => { const n = new Set(prev); filtered.forEach((f) => n.add(f)); return n })
  const clearPicked = () => setPicked(new Set())

  const Mbtn = (id: typeof mode, label: string) => <button onClick={() => setMode(id)} className={cn('px-3 py-1.5 rounded-lg text-sm border transition', mode === id ? 'border-primary/50 bg-raised text-foreground' : 'border-border bg-surface text-muted-foreground hover:text-foreground')}>{label}</button>

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {Mbtn('all', `All on disk (${onDiskCount})`)}{Mbtn('range', 'Range')}{Mbtn('pick', 'Pick')}
        {status !== 'running'
          ? <Button onClick={start} disabled={willRun === 0 || tooMany}><Play className="w-4 h-4" /> Run {willRun > 0 ? `(${willRun})` : ''}</Button>
          : <Button variant="destructive" onClick={stop}><Square className="w-4 h-4" /> Stop</Button>}
        <StatusPill status={status} />
        {curProg && curProg.total ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><div className="w-40 h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary transition-[width]" style={{ width: `${(curProg.done / curProg.total) * 100}%` }} /></div><span className="tabular-nums">{curProg.done}/{curProg.total}{curProg.current ? ` · ${curProg.current}` : ''}</span></div> : null}
        <div className="flex-1" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter logs…" className="w-48" />
        <Button variant="outline" size="sm" onClick={download}><Download className="w-3.5 h-3.5" /> Log</Button>
      </div>
      <div className="text-xs text-muted-foreground -mt-1">
        {total} patient{total === 1 ? '' : 's'} imported · {onDiskCount} with run-fixtures. Range/Pick can run any patient — fixtures are created on demand.
        {tooMany && <span className="text-warning"> · Selection over {MAX_BATCH} — run it in smaller batches.</span>}
      </div>

      {/* selection panel */}
      {mode === 'range' && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
            <span>Patients</span>
            <Input type="number" min={1} max={total} value={from} onChange={(e) => setFrom(Math.max(1, Math.min(total, +e.target.value || 1)))} className="w-20" />
            <span>to</span>
            <Input type="number" min={1} max={total} value={to} onChange={(e) => setTo(Math.max(1, Math.min(total, +e.target.value || 1)))} className="w-20" />
            <span className="text-foreground">of {total}</span>
            <button onClick={() => { setFrom(1); setTo(total) }} className="text-xs text-primary hover:underline ml-1">all</button>
            <span className="ml-auto text-foreground font-medium">{rangeSel.length} selected</span>
          </div>
          {rangeSel.length > 0 && (
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto">
              {rangeSel.slice(0, 60).map((f, i) => <span key={f} className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground"><span className="text-foreground/50 mr-1">{lo + i}</span>{label(f)}</span>)}
              {rangeSel.length > 60 && <span className="text-[11px] text-muted-foreground self-center">+{rangeSel.length - 60} more…</span>}
            </div>
          )}
        </Card>
      )}

      {mode === 'pick' && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${total} patients…`} className="pl-8" />
            </div>
            <Button size="sm" variant="secondary" onClick={selectAllFiltered}><CheckSquare className="w-3.5 h-3.5 mr-1" /> Select all{q ? ` (${filtered.length})` : ''}</Button>
            <Button size="sm" variant="ghost" onClick={clearPicked} disabled={!picked.size}><X className="w-3.5 h-3.5 mr-1" /> Clear</Button>
            <span className="text-sm text-foreground font-medium ml-auto">{picked.size} selected</span>
          </div>
          <div className="border border-border rounded-lg divide-y divide-border/60 max-h-[38vh] overflow-auto">
            {filtered.length === 0
              ? <div className="p-6 text-center text-sm text-muted-foreground">No patients match “{q}”.</div>
              : filtered.slice(0, 600).map((f) => {
                const on = picked.has(f)
                return (
                  <button key={f} onClick={() => toggle(f)} className={cn('w-full flex items-center gap-3 px-3 py-1.5 text-left text-sm transition', on ? 'bg-primary/10 text-foreground' : 'hover:bg-accent text-muted-foreground')}>
                    <span className={cn('w-4 h-4 rounded border flex items-center justify-center shrink-0', on ? 'bg-primary border-primary text-primary-foreground' : 'border-border')}>{on && <CheckSquare className="w-3 h-3" />}</span>
                    <span className="text-foreground/40 text-xs w-8 tabular-nums">{posOf.get(f)}</span>
                    <span className="truncate">{label(f)}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground font-mono truncate max-w-[40%]">{f}</span>
                  </button>
                )
              })}
            {filtered.length > 600 && <div className="p-2 text-center text-[11px] text-muted-foreground">Showing first 600 — refine your search to see the rest.</div>}
          </div>
        </Card>
      )}

      <div ref={paneRef} className="logpane bg-background border border-border rounded-xl h-[42vh] overflow-auto p-3">
        {shown.length === 0 ? <EmptyState icon="▶" title="No output yet" hint="Choose patients and hit Run — stdout streams here live." />
          : shown.map((l, i) => <div key={i} className={cn('whitespace-pre-wrap', l.stream === 'err' ? 'text-destructive' : 'text-foreground/80')}>{l.line}</div>)}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Recent runs</div>
        <div className="flex gap-2 flex-wrap">
          {history.slice(0, 8).map((h) => <div key={h.id} className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition', runId === h.id ? 'border-primary/50 bg-raised' : 'border-border bg-surface hover:bg-accent')}>
            <button onClick={() => setRunId(h.id)} className="flex items-center gap-2"><StatusPill status={h.status} /><span className="font-mono text-muted-foreground">{(h.command || '').replace('node eval/run_eval.mjs', 'eval').replace(/--resume \S+/, '↻').trim() || 'eval'}</span></button>
            {h.progress && h.progress.total ? <span className="text-muted-foreground tabular-nums">{h.progress.done}/{h.progress.total}</span> : null}
            {h.status === 'interrupted' && <button onClick={() => resume(h.id)} title="Continue the remaining fixtures" className="text-primary hover:underline">Resume</button>}
            {h.status !== 'running' && <button onClick={() => retry(h.id)} title="Re-run these fixtures from scratch" className="text-muted-foreground hover:text-foreground hover:underline">Retry</button>}
          </div>)}
          {history.length === 0 && <span className="text-muted-foreground text-sm">No runs yet.</span>}
        </div>
      </div>
    </div>
  )
}
