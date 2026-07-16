import * as React from 'react'
import { api, type ResultRun, type FixtureRow } from '@/lib/api'
import { cn, shortId, isBlocker } from '@/lib/utils'
import { md, splitNoteMd, computeDiff } from '@/lib/md'
import { PassBadge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState, Skeleton } from '@/components/ui/skeleton'
import { Star, PanelLeftClose, PanelLeft } from 'lucide-react'
import type { TabId } from '@/lib/nav'

export function Results({ setTab, target, clearTarget }: { setTab: (t: TabId) => void; target: { dir: string; file: string } | null; clearTarget: () => void }) {
  const [runs, setRuns] = React.useState<ResultRun[]>([])
  const [dir, setDir] = React.useState(''); const [files, setFiles] = React.useState<FixtureRow[]>([])
  const [file, setFile] = React.useState(''); const [content, setContent] = React.useState(''); const [wantFile, setWantFile] = React.useState('')
  const [view, setView] = React.useState<'rendered' | 'raw' | 'diff'>('rendered'); const [diffB, setDiffB] = React.useState(''); const [diffData, setDiffData] = React.useState<{ a: string; b: string } | null>(null)
  const [sideOpen, setSideOpen] = React.useState(true)
  React.useEffect(() => { api.resultRuns().then((r) => { setRuns(r); setDir((d) => d || (r[0]?.dir ?? '')) }).catch(() => {}) }, [])
  React.useEffect(() => { if (target?.dir) { setView('rendered'); setSideOpen(true); setWantFile(target.file || ''); setDir(target.dir); if (target.file) setFile(target.file); clearTarget() } }, [target])
  React.useEffect(() => { if (dir) api.files(dir).then((f) => { setFiles(f); const pick = wantFile && f.find((x) => x.file === wantFile) ? wantFile : f[0]?.file ?? ''; if (pick) setFile(pick); if (wantFile) setWantFile('') }).catch(() => {}) }, [dir])
  React.useEffect(() => { if (dir && file && view !== 'diff') api.file(dir, file).then((d) => setContent(d.content || '')).catch(() => {}) }, [dir, file, view])
  React.useEffect(() => { if (view === 'diff' && dir && diffB && file) api.diff(diffB, dir, file).then(setDiffData).catch(() => {}) }, [view, dir, diffB, file])
  const parsed = React.useMemo(() => splitNoteMd(content), [content])
  const diffLines = React.useMemo(() => (diffData ? computeDiff(diffData.a, diffData.b) : []), [diffData])
  if (!runs.length) return <div className="p-6"><EmptyState icon="☰" title="No results yet" hint="Run the tester first, then generated notes appear here beside the gold reference." /></div>
  const Pane = ({ title, tone, body, raw }: { title: string; tone: string; body: string; raw?: boolean }) => (
    <div className="flex-1 min-w-0 flex flex-col border border-border rounded-xl bg-surface overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border"><span className={cn('w-2 h-2 rounded-full', tone)} /><span className="text-sm font-semibold text-foreground">{title}</span></div>
      <div className="flex-1 overflow-auto p-4">{raw ? <pre className="logpane whitespace-pre-wrap text-foreground/80">{body}</pre> : body.trim() ? <div className="md" dangerouslySetInnerHTML={{ __html: md.render(body) }} /> : <div className="text-muted-foreground text-sm">(empty)</div>}</div>
    </div>
  )
  return (
    <div className="p-6 flex gap-4 h-[calc(100vh-56px)]">
      {sideOpen && <div className="w-60 shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between"><span className="text-xs uppercase tracking-wide text-muted-foreground">Run</span>
          <button onClick={() => setSideOpen(false)} className="text-muted-foreground hover:text-foreground text-xs flex items-center gap-1"><PanelLeftClose className="w-3.5 h-3.5" /></button></div>
        <select value={dir} onChange={(e) => setDir(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm">{runs.map((r) => <option key={r.dir} value={r.dir}>{shortId(r.dir)}</option>)}</select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={view === 'diff'} onChange={(e) => { setView(e.target.checked ? 'diff' : 'rendered'); if (e.target.checked) setDiffB(runs.find((r) => r.dir !== dir)?.dir || '') }} /> Diff vs another run</label>
        {view === 'diff' && <select value={diffB} onChange={(e) => setDiffB(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm">{runs.filter((r) => r.dir !== dir).map((r) => <option key={r.dir} value={r.dir}>{shortId(r.dir)}</option>)}</select>}
        <div className="text-xs uppercase tracking-wide text-muted-foreground mt-1">Fixtures</div>
        <div className="flex-1 overflow-auto space-y-1 pr-1">{files.map((f) => <button key={f.file} onClick={() => setFile(f.file)} className={cn('w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-sm transition', file === f.file ? 'bg-raised text-foreground' : 'text-muted-foreground hover:bg-accent')}><span className="truncate flex items-center gap-1">{isBlocker(f.fixture) && <Star className="w-3 h-3 text-warning" />}{f.fixture}</span><PassBadge passed={f.passed} /></button>)}</div>
      </div>}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {!sideOpen && <button onClick={() => setSideOpen(true)} className="text-xs border border-border rounded-lg px-2 py-1.5 text-muted-foreground hover:text-foreground flex items-center gap-1"><PanelLeft className="w-3.5 h-3.5" /> files</button>}
          <button onClick={() => setTab('prompts')} className="text-xs bg-accent border border-border rounded-lg px-2.5 py-1.5 text-muted-foreground hover:text-foreground transition">✎ Prompts</button>
          <span className="font-mono text-sm text-muted-foreground truncate">{file}</span><div className="flex-1" />
          {view !== 'diff' && <Tabs value={view} onValueChange={(v) => setView(v as any)}><TabsList><TabsTrigger value="rendered">Rendered</TabsTrigger><TabsTrigger value="raw">Raw</TabsTrigger></TabsList></Tabs>}
          {view === 'diff' && <span className="text-xs text-muted-foreground">{shortId(diffB)} → {shortId(dir)}</span>}
        </div>
        {view === 'diff'
          ? <div className="flex-1 overflow-auto bg-surface border border-border rounded-xl p-4 logpane">{diffLines.length === 0 ? <div className="text-muted-foreground text-sm">No differences.</div> : diffLines.map((d, i) => <div key={i} className={cn('whitespace-pre-wrap px-1', d.t === '+' && 'diff-add', d.t === '-' && 'diff-del')}>{d.t} {d.line}</div>)}</div>
          : <div className="flex-1 flex gap-4 min-h-0"><Pane title="Notera — generated" tone="bg-primary" body={parsed.generated || content} raw={view === 'raw'} /><Pane title="Heidi — gold" tone="bg-warning" body={parsed.gold} raw={view === 'raw'} /></div>}
      </div>
    </div>
  )
}
