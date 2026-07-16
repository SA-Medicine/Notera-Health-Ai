import * as React from 'react'
import { api, useRunStream, type RunRec } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { Play, Square, Download } from 'lucide-react'

export function Run({ onStatus }: { onStatus: (s: string) => void }) {
  const [presets, setPresets] = React.useState<{ id: string; label: string; fixtures: string[] }[]>([])
  const [mode, setMode] = React.useState<'all' | 'one' | 'range'>('all')
  const [sel, setSel] = React.useState(''); const [from, setFrom] = React.useState(1); const [to, setTo] = React.useState(5)
  const [runId, setRunId] = React.useState<string | null>(null)
  const [history, setHistory] = React.useState<RunRec[]>([])
  const [filter, setFilter] = React.useState('')
  const { lines, status, setStatus } = useRunStream(runId)
  const paneRef = React.useRef<HTMLDivElement>(null)
  const fixtures = presets.filter((p) => p.id !== 'all').map((p) => p.id)
  const numOf = (f: string) => { const m = String(f).match(/(\d+)/); return m ? +m[1] : null }
  const lo = Math.min(from, to), hi = Math.max(from, to)
  const rangeSel = fixtures.filter((f) => { const n = numOf(f); return n != null && n >= lo && n <= hi })
  const loadHist = React.useCallback(() => api.runs().then(setHistory).catch(() => {}), [])
  React.useEffect(() => { api.scripts().then((d) => { setPresets(d.presets || []); const f = (d.presets || []).find((x) => x.id !== 'all'); if (f) setSel(f.id) }).catch(() => {}); loadHist() }, [loadHist])
  React.useEffect(() => { onStatus(status); if (status !== 'running' && runId) { loadHist(); if (status === 'passed') toast.success('Run passed'); else if (status === 'failed' || status === 'error') toast.error('Run ' + status) } }, [status])
  React.useEffect(() => { const el = paneRef.current; if (el) el.scrollTop = el.scrollHeight }, [lines])
  const chosen = () => (mode === 'all' ? [] : mode === 'one' ? (sel ? [sel] : []) : rangeSel)
  const willRun = mode === 'all' ? fixtures.length : mode === 'one' ? (sel ? 1 : 0) : rangeSel.length
  const start = async () => { const r = await api.startRun(chosen()); setRunId(r.runId); setStatus('running'); onStatus('running'); loadHist() }
  const stop = async () => { if (runId) await api.killRun(runId) }
  const download = () => { const blob = new Blob([lines.map((l) => l.line).join('\n')], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (runId || 'run') + '.log'; a.click() }
  const shown = lines.filter((l) => !filter || l.line.toLowerCase().includes(filter.toLowerCase()))
  const Mbtn = (id: typeof mode, label: string) => <button onClick={() => setMode(id)} className={cn('px-3 py-1.5 rounded-lg text-sm border transition', mode === id ? 'border-primary/50 bg-raised text-foreground' : 'border-border bg-surface text-muted-foreground hover:text-foreground')}>{label}</button>
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">{Mbtn('all', 'All')}{Mbtn('one', 'Single')}{Mbtn('range', 'Range')}
        {mode === 'one' && <select value={sel} onChange={(e) => setSel(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-3 text-sm">{fixtures.map((f) => <option key={f} value={f}>{f}</option>)}</select>}
        {mode === 'range' && <div className="flex items-center gap-2 text-sm text-muted-foreground"><span>Patient</span><Input type="number" value={from} onChange={(e) => setFrom(+e.target.value)} className="w-16" /><span>to</span><Input type="number" value={to} onChange={(e) => setTo(+e.target.value)} className="w-16" /></div>}
        {status !== 'running' ? <Button onClick={start} disabled={willRun === 0}><Play className="w-4 h-4" /> Run {willRun > 0 ? `(${willRun})` : ''}</Button>
          : <Button variant="destructive" onClick={stop}><Square className="w-4 h-4" /> Stop</Button>}
        <StatusPill status={status} /><div className="flex-1" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter logs…" className="w-48" />
        <Button variant="outline" size="sm" onClick={download}><Download className="w-3.5 h-3.5" /> Log</Button>
      </div>
      <div ref={paneRef} className="logpane bg-background border border-border rounded-xl h-[50vh] overflow-auto p-3">
        {shown.length === 0 ? <EmptyState icon="▶" title="No output yet" hint="Choose fixtures and hit Run — stdout streams here live." />
          : shown.map((l, i) => <div key={i} className={cn('whitespace-pre-wrap', l.stream === 'err' ? 'text-destructive' : 'text-foreground/80')}>{l.line}</div>)}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Recent runs</div>
        <div className="flex gap-2 flex-wrap">
          {history.slice(0, 8).map((h) => <button key={h.id} onClick={() => setRunId(h.id)} className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition', runId === h.id ? 'border-primary/50 bg-raised' : 'border-border bg-surface hover:bg-accent')}><StatusPill status={h.status} /><span className="font-mono text-muted-foreground">{(h.command || '').replace('node eval/run_eval.mjs', 'eval').trim() || 'eval'}</span></button>)}
          {history.length === 0 && <span className="text-muted-foreground text-sm">No runs yet.</span>}
        </div>
      </div>
    </div>
  )
}
