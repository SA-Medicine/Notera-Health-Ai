import * as React from 'react'
import { api, type ResultRun } from '@/lib/api'
import { fmtPct, fmtNum, cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Skeleton, EmptyState } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Play, Rows3, LineChart } from 'lucide-react'
import type { TabId } from '@/lib/nav'

export function Overview({ setTab }: { setTab: (t: TabId) => void }) {
  const [runs, setRuns] = React.useState<ResultRun[] | null>(null)
  const [hist, setHist] = React.useState<any[]>([])
  React.useEffect(() => { api.resultRuns().then(setRuns).catch(() => setRuns([])); api.history().then(setHist).catch(() => {}) }, [])
  const withS = (runs || []).filter((r) => r.summary); const latest = withS[0], prev = withS[1]
  const Kpi = ({ label, k, fmt }: { label: string; k: string; fmt: (v: any) => string }) => {
    const v = latest?.summary?.[k]; const p = prev?.summary?.[k]; const d = v != null && p != null ? v - p : null; const inv = k === 'avg_omission_rate'; const good = d != null && (inv ? d < 0 : d > 0)
    return <Card className="p-4"><div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className="text-2xl font-semibold text-foreground mt-1.5 tabular-nums">{fmt(v)}</div>
      <div className={cn('inline-flex items-center gap-1 text-xs font-medium mt-2 px-1.5 py-0.5 rounded-md', d == null ? 'text-muted-foreground bg-muted' : good ? 'text-success bg-success/10' : 'text-destructive bg-destructive/10')}>{d == null ? 'first run' : (d > 0 ? '↑ ' : '↓ ') + fmt(Math.abs(d))}{d != null && <span className="text-muted-foreground">vs prev</span>}</div></Card>
  }
  const Act = ({ t, tab, Icon, tone, desc }: any) => <Card className="p-5 cursor-pointer hover:bg-accent/60 hover:border-muted-foreground/30 transition" onClick={() => setTab(tab)}>
    <div className={cn('inline-flex items-center justify-center w-9 h-9 rounded-lg mb-2.5', tone)}><Icon className="w-4 h-4" /></div>
    <div className="text-foreground font-medium text-sm mb-0.5">{t}</div><div className="text-muted-foreground text-xs leading-relaxed">{desc}</div></Card>
  if (runs === null) return <div className="p-6 space-y-5"><div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div><div className="grid grid-cols-3 gap-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div></div>
  if (!withS.length) return <div className="p-6"><EmptyState icon="▦" title="No runs yet" hint="Trigger the regression harness to generate your first scorecard." action={<Button onClick={() => setTab('run')}><Play className="w-4 h-4" /> Run the tester</Button>} /></div>
  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Section coverage" k="avg_section_coverage" fmt={fmtPct} />
        <Kpi label="Similarity to gold" k="avg_similarity_to_gold" fmt={(v) => fmtNum(v)} />
        <Kpi label="Story / Flow" k="avg_story_flow" fmt={(v) => fmtNum(v)} />
        <Kpi label="Omission rate" k="avg_omission_rate" fmt={fmtPct} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Act t="Run the tester" tab="run" Icon={Play} tone="bg-primary/12 text-primary" desc="Trigger a preset or patient range and watch logs stream live." />
        <Act t="Inspect results" tab="results" Icon={Rows3} tone="bg-info/12 text-info" desc="Generated vs Gold side-by-side, with run-vs-run diff." />
        <Act t="Track metrics" tab="metrics" Icon={LineChart} tone="bg-warning/12 text-warning" desc="Quality trend across runs and per-fixture breakdowns." />
      </div>
      <Card className="p-4 flex items-center gap-6 text-sm">
        <div><div className="text-2xl font-semibold text-foreground tabular-nums">{(runs || []).length}</div><div className="text-xs text-muted-foreground">result sets</div></div>
        <div className="w-px h-8 bg-border" />
        <div><div className="text-2xl font-semibold text-foreground tabular-nums">{hist.length}</div><div className="text-xs text-muted-foreground">scored in history</div></div>
        <div className="w-px h-8 bg-border" />
        <div className="text-muted-foreground text-xs">Release blockers <span className="text-warning">★</span> patient2, patient5</div>
      </Card>
    </div>
  )
}
