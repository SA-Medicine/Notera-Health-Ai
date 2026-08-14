import * as React from 'react'
import { api, type ResultRun, type FixtureRow, type Critique } from '@/lib/api'
import { cn, shortId, isBlocker } from '@notera/ui/lib/utils'
import { md, splitNoteMd } from '@notera/ui/lib/md'
import { PassBadge } from '@notera/ui/components/ui/badge'
import { Button } from '@notera/ui/components/ui/button'
import { EmptyState, Skeleton } from '@notera/ui/components/ui/skeleton'
import { toast } from 'sonner'
import { Star, Stethoscope, ShieldAlert, Ghost, CircleAlert, CheckCircle2, ListChecks, Sparkles, PanelLeftClose, PanelLeft, FileText } from 'lucide-react'

const scoreTone = (s: number) => (s >= 80 ? 'text-success' : s >= 55 ? 'text-warning' : 'text-destructive')
const ringTone = (s: number) => (s >= 80 ? 'stroke-success' : s >= 55 ? 'stroke-warning' : 'stroke-destructive')
const barTone = (v: number) => (v >= 4 ? 'bg-success' : v >= 2.5 ? 'bg-warning' : 'bg-destructive')
const VERDICT: Record<string, { label: string; cls: string }> = {
  excellent: { label: 'Excellent', cls: 'bg-success/15 text-success ring-1 ring-success/30' },
  good: { label: 'Good', cls: 'bg-primary/15 text-primary ring-1 ring-primary/30' },
  needs_work: { label: 'Needs work', cls: 'bg-warning/15 text-warning ring-1 ring-warning/30' },
  unsafe: { label: 'Unsafe', cls: 'bg-destructive/15 text-destructive ring-1 ring-destructive/30' },
}

function Ring({ score }: { score: number }) {
  const r = 34, c = 2 * Math.PI * r
  const [off, setOff] = React.useState(c)
  React.useEffect(() => { const t = setTimeout(() => setOff(c * (1 - Math.max(0, Math.min(100, score)) / 100)), 60); return () => clearTimeout(t) }, [score, c])
  return (
    <div className="relative w-28 h-28 shrink-0">
      <svg viewBox="0 0 80 80" className="w-28 h-28 -rotate-90">
        <circle cx="40" cy="40" r={r} className="stroke-muted" strokeWidth="7" fill="none" />
        <circle cx="40" cy="40" r={r} className={cn(ringTone(score), 'transition-[stroke-dashoffset] duration-700 ease-out')} strokeWidth="7" fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} />
      </svg>
      <div className={cn('absolute inset-0 flex flex-col items-center justify-center', scoreTone(score))}>
        <span className="text-3xl font-bold tabular-nums leading-none">{score}</span>
        <span className="text-[10px] text-muted-foreground mt-0.5">/ 100</span>
      </div>
    </div>
  )
}

function Findings({ title, items, tone, Icon }: { title: string; items?: string[]; tone: string; Icon: any }) {
  const list = items || []
  const empty = list.length === 0
  return (
    <div className={cn('rounded-xl border bg-surface p-3.5 transition-colors', empty ? 'border-border' : 'border-border hover:border-foreground/20')}>
      <div className={cn('flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-2', empty ? 'text-muted-foreground' : tone)}>
        <Icon className="w-3.5 h-3.5" />{title}<span className="text-muted-foreground font-normal">({list.length})</span>
      </div>
      {empty ? <div className="text-muted-foreground/50 text-sm">— none noted</div>
        : <ul className="space-y-1.5">{list.map((x, i) => <li key={i} className="text-sm text-foreground/85 flex gap-2"><span className={cn('mt-[7px] w-1.5 h-1.5 rounded-full shrink-0', tone.replace('text-', 'bg-'))} />{x}</li>)}</ul>}
    </div>
  )
}

export function Critique() {
  const [runs, setRuns] = React.useState<ResultRun[]>([])
  const [dir, setDir] = React.useState(''); const [files, setFiles] = React.useState<FixtureRow[]>([])
  const [file, setFile] = React.useState(''); const [content, setContent] = React.useState('')
  const [crit, setCrit] = React.useState<Critique | null>(null); const [busy, setBusy] = React.useState(false)
  const [noteOpen, setNoteOpen] = React.useState(true)

  React.useEffect(() => { api.resultRuns().then((r) => { setRuns(r); setDir((d) => d || (r[0]?.dir ?? '')) }).catch(() => {}) }, [])
  React.useEffect(() => { if (dir) api.files(dir).then((f) => { setFiles(f); setFile((cur) => (cur && f.find((x) => x.file === cur) ? cur : f[0]?.file ?? '')) }).catch(() => {}) }, [dir])
  React.useEffect(() => { if (dir && file) api.file(dir, file).then((d) => setContent(d.content || '')).catch(() => {}) }, [dir, file])
  React.useEffect(() => { setCrit(null); if (dir && file) api.critiqueGet(dir, file).then((c) => { if (c.cached) setCrit(c) }).catch(() => {}) }, [dir, file])

  const note = React.useMemo(() => { const p = splitNoteMd(content); return p.generated || content }, [content])
  const fx = files.find((f) => f.file === file)

  const run = React.useCallback(async () => {
    if (!dir || !file || busy) return
    setBusy(true)
    try { const c = await api.critiqueRun(dir, file); setCrit(c); if (c.ok === false) toast.error(c.error || 'Second Opinion unavailable'); else toast.success('Second Opinion ready') }
    catch { toast.error('Second Opinion failed') }
    setBusy(false)
  }, [dir, file, busy])

  if (!runs.length) return <div className="p-6"><EmptyState icon="🩺" title="No results yet" hint="Run the tester first, then get an independent Second Opinion on any generated note." /></div>

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-4">
      {/* ── selector bar (sticky) ── */}
      <div className="sticky top-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-background/80 backdrop-blur border-b border-border flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><Stethoscope className="w-4 h-4 text-primary" /> Second Opinion</div>
        <span className="text-xs text-muted-foreground hidden sm:inline">independent DeepSeek review · no gold reference</span>
        <div className="flex-1" />
        <button onClick={() => setNoteOpen((o) => !o)} title={noteOpen ? 'Hide the note (full-width report)' : 'Show the note'} className="text-xs border border-border rounded-lg px-2 py-1.5 text-muted-foreground hover:text-foreground flex items-center gap-1">
          {noteOpen ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeft className="w-3.5 h-3.5" />}<span className="hidden sm:inline">{noteOpen ? 'Hide note' : 'Show note'}</span>
        </button>
        <select value={dir} onChange={(e) => setDir(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm">{runs.map((r) => <option key={r.dir} value={r.dir}>{shortId(r.dir)}</option>)}</select>
        <select value={file} onChange={(e) => setFile(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm max-w-[15rem]">{files.map((f) => <option key={f.file} value={f.file}>{f.fixture}</option>)}</select>
        <Button size="sm" onClick={run} disabled={busy || !file}>{busy ? 'Reviewing…' : crit?.cached ? 'Re-review' : 'Get Second Opinion'}</Button>
      </div>

      {/* ── main grid: note (collapsible, sticky) | report ── */}
      <div className={cn('grid gap-4 items-start', noteOpen ? 'grid-cols-1 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]' : 'grid-cols-1')}>
        {noteOpen && (
          <div className="flex flex-col border border-border rounded-xl bg-surface overflow-hidden lg:sticky lg:top-16 lg:max-h-[calc(100vh-6rem)]">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <FileText className="w-3.5 h-3.5 text-primary" />
              <span className="text-sm font-semibold text-foreground truncate flex items-center gap-1">{isBlocker(fx?.fixture || '') && <Star className="w-3 h-3 text-warning" />}{fx?.fixture || file}</span>
              <div className="flex-1" /><PassBadge passed={fx?.passed ?? null} />
            </div>
            <div className="overflow-auto p-4">{note.trim() ? <div className="md text-sm" dangerouslySetInnerHTML={{ __html: md.render(note) }} /> : <div className="text-muted-foreground text-sm">(no note)</div>}</div>
          </div>
        )}

        {/* report column */}
        <div className="min-w-0">
          {busy && <div className="space-y-3"><Skeleton className="h-28 w-full" /><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div><Skeleton className="h-40 w-full" /></div>}

          {!busy && !crit && (
            <div className="min-h-[50vh] flex items-center justify-center rounded-xl border border-dashed border-border bg-surface/40">
              <div className="text-center max-w-md px-8 py-10">
                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4"><Stethoscope className="w-7 h-7 text-primary" /></div>
                <div className="text-foreground font-semibold text-lg mb-1.5">Get an independent expert opinion</div>
                <p className="text-sm text-muted-foreground leading-relaxed">A senior-clinician–style reviewer reads the transcript and this note, then returns a blunt, honest verdict — accuracy, completeness, safety, hallucinations and concrete fixes. No gold note involved.</p>
                <Button size="sm" className="mt-5" onClick={run} disabled={!file}>Get Second Opinion</Button>
              </div>
            </div>
          )}

          {!busy && crit?.ok === false && (
            <div className="rounded-xl border border-warning/40 bg-warning/5 p-4">
              <div className="font-semibold text-warning mb-1 flex items-center gap-1.5"><CircleAlert className="w-4 h-4" /> Second Opinion unavailable</div>
              <div className="text-sm text-muted-foreground">{crit.error}</div>{crit.hint && <div className="text-xs text-muted-foreground mt-1 break-words">{crit.hint}</div>}
            </div>
          )}

          {!busy && crit && crit.ok !== false && (
            <div className="space-y-4">
              {/* verdict header */}
              <div className="rounded-xl border border-border bg-gradient-to-br from-surface to-surface/40 p-5 flex items-center gap-5">
                <Ring score={crit.overall_score ?? 0} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    {crit.verdict && <span className={cn('text-xs font-semibold px-2.5 py-1 rounded-md', VERDICT[crit.verdict]?.cls || 'bg-accent text-muted-foreground')}>{VERDICT[crit.verdict]?.label || crit.verdict.replace(/_/g, ' ')}</span>}
                    {crit.model && <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Sparkles className="w-3 h-3" />{crit.model}</span>}
                  </div>
                  {crit.one_liner && <p className="text-base text-foreground/90 font-medium leading-snug">{crit.one_liner}</p>}
                  {crit.generatedAt && <p className="text-[10px] text-muted-foreground mt-1.5">reviewed {new Date(crit.generatedAt).toLocaleString()}</p>}
                </div>
              </div>

              {/* dimension bars */}
              {!!(crit.dimensions || []).length && (
                <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                  {(crit.dimensions || []).map((d) => (
                    <div key={d.name} className="grid grid-cols-[9rem_1fr] lg:grid-cols-[10rem_9rem_1fr] items-center gap-3 text-sm">
                      <span className="text-foreground/80 font-medium">{d.name}</span>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden"><div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', barTone(d.score))} style={{ width: `${(Math.max(0, Math.min(5, d.score)) / 5) * 100}%` }} /></div>
                        <span className="w-8 text-right font-mono text-xs tabular-nums">{d.score}<span className="text-muted-foreground">/5</span></span>
                      </div>
                      <span className="col-span-2 lg:col-span-1 text-xs text-muted-foreground leading-snug">{d.comment}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* findings grid */}
              <div className={cn('grid gap-3 grid-cols-1 md:grid-cols-2', noteOpen ? '' : 'xl:grid-cols-3')}>
                <Findings title="Strengths" items={crit.strengths} tone="text-success" Icon={CheckCircle2} />
                <Findings title="Weaknesses" items={crit.weaknesses} tone="text-warning" Icon={CircleAlert} />
                <Findings title="Safety issues" items={crit.safety_issues} tone="text-destructive" Icon={ShieldAlert} />
                <Findings title="Hallucinations" items={crit.hallucinations} tone="text-destructive" Icon={Ghost} />
                <Findings title="Omissions" items={crit.omissions} tone="text-warning" Icon={CircleAlert} />
                <Findings title="Recommendations" items={crit.recommendations} tone="text-info" Icon={ListChecks} />
              </div>

              {/* brutal summary */}
              {crit.brutal_summary && (
                <div className="rounded-xl border border-border bg-surface p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><Stethoscope className="w-3.5 h-3.5 text-primary" /> Honest assessment</div>
                  <div className="md text-sm text-foreground/90 leading-relaxed" dangerouslySetInnerHTML={{ __html: md.render(crit.brutal_summary) }} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
