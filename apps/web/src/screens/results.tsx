import * as React from 'react'
import { api, type ResultRun, type FixtureRow, type Comparison } from '@/lib/api'
import { cn, shortId, isBlocker } from '@notera/ui/lib/utils'
import { md, splitNoteMd, computeDiff } from '@notera/ui/lib/md'
import { PassBadge } from '@notera/ui/components/ui/badge'
import { Button } from '@notera/ui/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@notera/ui/components/ui/tabs'
import { EmptyState, Skeleton } from '@notera/ui/components/ui/skeleton'
import { toast } from 'sonner'
import { Star, PanelLeftClose, PanelLeft, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import type { TabId } from '@/lib/nav'

const scoreTone = (s: number) => (s >= 80 ? 'text-success' : s >= 55 ? 'text-warning' : 'text-destructive')
const barTone = (v: number) => (v >= 4 ? 'bg-success' : v >= 2.5 ? 'bg-warning' : 'bg-destructive')

export function Results({ setTab, target, clearTarget }: { setTab: (t: TabId) => void; target: { dir: string; file: string } | null; clearTarget: () => void }) {
  const [runs, setRuns] = React.useState<ResultRun[]>([])
  const [dir, setDir] = React.useState(''); const [files, setFiles] = React.useState<FixtureRow[]>([])
  const [file, setFile] = React.useState(''); const [content, setContent] = React.useState(''); const [wantFile, setWantFile] = React.useState('')
  const [view, setView] = React.useState<'rendered' | 'raw' | 'diff'>('rendered'); const [diffB, setDiffB] = React.useState(''); const [diffData, setDiffData] = React.useState<{ a: string; b: string } | null>(null)
  const [sideOpen, setSideOpen] = React.useState(true)
  const [compare, setCompare] = React.useState<Comparison | null>(null); const [comparing, setComparing] = React.useState(false)
  const [cmpOpen, setCmpOpen] = React.useState(() => localStorage.getItem('notera_cmp') !== '0')
  const [auto, setAuto] = React.useState(() => localStorage.getItem('notera_cmp_auto') === '1')
  React.useEffect(() => { localStorage.setItem('notera_cmp', cmpOpen ? '1' : '0') }, [cmpOpen])
  React.useEffect(() => { localStorage.setItem('notera_cmp_auto', auto ? '1' : '0') }, [auto])
  React.useEffect(() => { api.resultRuns().then((r) => { setRuns(r); setDir((d) => d || (r[0]?.dir ?? '')) }).catch(() => {}) }, [])
  React.useEffect(() => { if (target?.dir) { setView('rendered'); setSideOpen(true); setWantFile(target.file || ''); setDir(target.dir); if (target.file) setFile(target.file); clearTarget() } }, [target])
  React.useEffect(() => { if (dir) api.files(dir).then((f) => { setFiles(f); const pick = wantFile && f.find((x) => x.file === wantFile) ? wantFile : f[0]?.file ?? ''; if (pick) setFile(pick); if (wantFile) setWantFile('') }).catch(() => {}) }, [dir])
  React.useEffect(() => { if (dir && file && view !== 'diff') api.file(dir, file).then((d) => setContent(d.content || '')).catch(() => {}) }, [dir, file, view])
  React.useEffect(() => { if (view === 'diff' && dir && diffB && file) api.diff(diffB, dir, file).then(setDiffData).catch(() => {}) }, [view, dir, diffB, file])
  const runCompare = React.useCallback(async () => {
    if (!dir || !file || comparing) return
    setComparing(true)
    try { const c = await api.compareRun(dir, file); setCompare(c); if (c.ok === false) toast.error('Comparison unavailable'); else toast.success('Comparison generated') }
    catch { toast.error('Comparison failed') }
    setComparing(false)
  }, [dir, file, comparing])
  // load cached comparison (and optionally auto-generate) whenever the fixture changes
  React.useEffect(() => {
    if (!dir || !file) return
    setCompare(null)
    api.compareGet(dir, file).then((c) => { if (c.cached) setCompare(c); else if (auto) runCompare() }).catch(() => {})
  }, [dir, file])
  const parsed = React.useMemo(() => splitNoteMd(content), [content])
  const diffLines = React.useMemo(() => (diffData ? computeDiff(diffData.a, diffData.b) : []), [diffData])
  if (!runs.length) return <div className="p-6"><EmptyState icon="☰" title="No results yet" hint="Run the tester first, then generated notes appear here beside the gold reference." /></div>

  const Pane = ({ title, tone, body, raw }: { title: string; tone: string; body: string; raw?: boolean }) => (
    <div className="flex-1 min-w-0 flex flex-col border border-border rounded-xl bg-surface overflow-hidden min-h-[38vh]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border"><span className={cn('w-2 h-2 rounded-full', tone)} /><span className="text-sm font-semibold text-foreground">{title}</span></div>
      <div className="flex-1 overflow-auto p-4">{raw ? <pre className="logpane whitespace-pre-wrap text-foreground/80">{body}</pre> : body.trim() ? <div className="md" dangerouslySetInnerHTML={{ __html: md.render(body) }} /> : <div className="text-muted-foreground text-sm">(empty)</div>}</div>
    </div>
  )

  return (
    <div className="p-4 sm:p-6 flex flex-col lg:flex-row gap-4 lg:h-[calc(100vh-56px)] lg:overflow-hidden">
      {sideOpen && <div className="w-full lg:w-60 shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between"><span className="text-xs uppercase tracking-wide text-muted-foreground">Run</span>
          <button onClick={() => setSideOpen(false)} className="text-muted-foreground hover:text-foreground text-xs hidden lg:flex items-center gap-1"><PanelLeftClose className="w-3.5 h-3.5" /></button></div>
        <select value={dir} onChange={(e) => setDir(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm">{runs.map((r) => <option key={r.dir} value={r.dir}>{shortId(r.dir)}</option>)}</select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={view === 'diff'} onChange={(e) => { setView(e.target.checked ? 'diff' : 'rendered'); if (e.target.checked) setDiffB(runs.find((r) => r.dir !== dir)?.dir || '') }} /> Diff vs another run</label>
        {view === 'diff' && <select value={diffB} onChange={(e) => setDiffB(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm">{runs.filter((r) => r.dir !== dir).map((r) => <option key={r.dir} value={r.dir}>{shortId(r.dir)}</option>)}</select>}
        <div className="text-xs uppercase tracking-wide text-muted-foreground mt-1">Fixtures</div>
        <div className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-y-auto lg:flex-1 pr-1">{files.map((f) => <button key={f.file} onClick={() => setFile(f.file)} className={cn('shrink-0 lg:w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-sm transition', file === f.file ? 'bg-raised text-foreground' : 'text-muted-foreground hover:bg-accent')}><span className="truncate flex items-center gap-1">{isBlocker(f.fixture) && <Star className="w-3 h-3 text-warning" />}{f.fixture}</span><PassBadge passed={f.passed} /></button>)}</div>
      </div>}

      <div className="flex-1 flex flex-col min-w-0 lg:min-h-0 lg:overflow-auto gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          {!sideOpen && <button onClick={() => setSideOpen(true)} className="text-xs border border-border rounded-lg px-2 py-1.5 text-muted-foreground hover:text-foreground flex items-center gap-1"><PanelLeft className="w-3.5 h-3.5" /> files</button>}
          <button onClick={() => setTab('prompts')} className="text-xs bg-accent border border-border rounded-lg px-2.5 py-1.5 text-muted-foreground hover:text-foreground transition">✎ Prompts</button>
          <span className="font-mono text-sm text-muted-foreground truncate">{file}</span><div className="flex-1" />
          {view !== 'diff' && <Tabs value={view} onValueChange={(v) => setView(v as any)}><TabsList><TabsTrigger value="rendered">Rendered</TabsTrigger><TabsTrigger value="raw">Raw</TabsTrigger></TabsList></Tabs>}
          {view === 'diff' && <span className="text-xs text-muted-foreground">{shortId(diffB)} → {shortId(dir)}</span>}
        </div>

        {view === 'diff'
          ? <div className="lg:flex-1 min-h-[40vh] overflow-auto bg-surface border border-border rounded-xl p-4 logpane">{diffLines.length === 0 ? <div className="text-muted-foreground text-sm">No differences.</div> : diffLines.map((d, i) => <div key={i} className={cn('whitespace-pre-wrap px-1', d.t === '+' && 'diff-add', d.t === '-' && 'diff-del')}>{d.t} {d.line}</div>)}</div>
          : <div className="flex flex-col lg:flex-row gap-4 lg:min-h-0"><Pane title="Notera — generated" tone="bg-primary" body={parsed.generated || content} raw={view === 'raw'} /><Pane title="Gold reference" tone="bg-warning" body={parsed.gold} raw={view === 'raw'} /></div>}

        {/* ── Comparison & scores (LLM) ── */}
        <div className="shrink-0 rounded-xl border border-border bg-surface">
          <div className="flex items-center gap-2 px-4 py-2.5 flex-wrap">
            <button onClick={() => setCmpOpen((o) => !o)} className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              {cmpOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}<Sparkles className="w-4 h-4 text-primary" /> Comparison &amp; scores
            </button>
            {compare?.overall_score != null && <span className={cn('text-sm font-bold tabular-nums', scoreTone(compare.overall_score))}>{compare.overall_score}<span className="text-muted-foreground font-normal">/100</span></span>}
            {compare?.verdict && <span className="text-[11px] px-2 py-0.5 rounded-md bg-accent text-muted-foreground">{compare.verdict.replace(/_/g, ' ')}</span>}
            <div className="flex-1" />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer" title="Auto-generate a comparison for every fixture you open"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto</label>
            <Button size="sm" onClick={runCompare} disabled={comparing}>{comparing ? 'Scoring…' : compare?.cached ? 'Regenerate' : 'Generate'}</Button>
          </div>
          {cmpOpen && <div className="px-4 pb-4">
            {comparing && <div className="space-y-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-24" /></div>}
            {!comparing && !compare && <p className="text-muted-foreground text-sm py-4">No comparison yet. Press <b className="text-foreground">Generate</b> to score this note against the gold reference — or turn on <b className="text-foreground">Auto</b> to do it for every note automatically. Results are cached and stay with the run.</p>}
            {!comparing && compare?.ok === false && <div className="text-warning text-sm py-3"><div className="font-semibold mb-1">Comparison unavailable</div><div className="text-muted-foreground text-xs">{compare.error}</div>{compare.hint && <div className="text-muted-foreground text-xs mt-1">{compare.hint}</div>}</div>}
            {!comparing && compare?.dimensions && <div className="space-y-4 pt-1">
              <div className="space-y-2">{compare.dimensions.map((d) => <div key={d.name} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
                <span className="text-foreground/80">{d.name}</span>
                <div className="flex items-center gap-3">
                  <div className="flex-1"><div className="flex items-center gap-2"><span className="text-[10px] w-10 text-primary">Notera</span><div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><div className={cn('h-full rounded-full', barTone(d.notera))} style={{ width: `${(d.notera / 5) * 100}%` }} /></div><span className="w-6 text-right font-mono text-xs">{d.notera}</span></div>
                    <div className="flex items-center gap-2 mt-1"><span className="text-[10px] w-10 text-warning">Gold</span><div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><div className={cn('h-full rounded-full', barTone(d.gold))} style={{ width: `${(d.gold / 5) * 100}%` }} /></div><span className="w-6 text-right font-mono text-xs">{d.gold}</span></div></div>
                </div>
                <span className="text-xs text-muted-foreground max-w-[16rem] truncate" title={d.comment}>{d.comment}</span>
              </div>)}</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <CmpList title="Notera missing" tone="text-destructive" items={compare.notera_missing} />
                <CmpList title="Notera extra (unsupported)" tone="text-warning" items={compare.notera_extra} />
                <CmpList title="Key differences" tone="text-info" items={compare.key_differences} />
              </div>
              {compare.summary && <p className="text-sm text-foreground/85 border-t border-border pt-3">{compare.summary}</p>}
              {compare.generatedAt && <p className="text-[10px] text-muted-foreground">generated {new Date(compare.generatedAt).toLocaleString()}</p>}
            </div>}
          </div>}
        </div>
      </div>
    </div>
  )
}
function CmpList({ title, tone, items }: { title: string; tone: string; items?: string[] }) {
  const list = items || []
  return (
    <div>
      <div className={cn('uppercase tracking-wide text-[10px] font-medium mb-1', tone)}>{title} ({list.length})</div>
      {list.length === 0 && <div className="text-muted-foreground/60">-</div>}
      {list.length > 0 && <ul className="space-y-0.5">{list.map((x, i) => <li key={i} className="text-muted-foreground">- {x}</li>)}</ul>}
    </div>
  )
}
