import * as React from 'react'
import { api, type ResultRun } from '@/lib/api'
import { cn, shortId, fmtPct, fmtNum, isBlocker } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { PassBadge } from '@/components/ui/badge'
import { EmptyState, Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, ArrowUpRight, Trash2 } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend, ResponsiveContainer } from 'recharts'

const METRICS: [string, string, string][] = [['avg_section_coverage', 'Coverage', 'pct'], ['avg_similarity_to_gold', 'Similarity', 'num'], ['avg_story_flow', 'Story/Flow', 'num'], ['avg_omission_rate', 'Omission', 'pct']]
const COLORS = ['#34d399', '#60a5fa', '#c084fc', '#fb7185']
const QA_PAL = ['#fbbf24', '#7dd3fc', '#f472b6', '#a3e635', '#c084fc']

export function Metrics({ openInResults }: { openInResults: (dir: string, file?: string) => void }) {
  const [runs, setRuns] = React.useState<ResultRun[] | null>(null); const [hist, setHist] = React.useState<any[]>([])
  const [expand, setExpand] = React.useState<string | null>(null); const [rows, setRows] = React.useState<Record<string, any[]>>({})
  const reload = React.useCallback(() => { api.history().then(setHist).catch(() => {}); api.resultRuns().then(setRuns).catch(() => setRuns([])) }, [])
  React.useEffect(() => { reload() }, [reload])
  const del = async (dir: string) => { if (!confirm('Delete run ' + shortId(dir) + '? This permanently removes its results, logs and history entry.')) return; try { await api.deleteRun(dir); toast.success('Run deleted') } catch { toast.error('Delete failed') } setExpand(null); setRows({}); reload() }
  const toggle = (d: string) => { if (expand === d) { setExpand(null); return } setExpand(d); if (!rows[d]) api.metricRun(d).then((x) => setRows((r) => ({ ...r, [d]: x.rows || [] }))).catch(() => {}) }
  const qaKeys = React.useMemo(() => [...new Set(hist.flatMap((h) => Object.keys(h).filter((k) => k.startsWith('avg_qa_'))))], [hist])
  const chartData = hist.map((h) => ({ name: String(h.runId).slice(5) || h.runId, ...h }))
  if (runs === null) return <div className="p-6 space-y-5"><Skeleton className="h-64" /><Skeleton className="h-48" /></div>
  if (!runs.length) return <div className="p-6"><EmptyState icon="📈" title="No metrics yet" hint="Run the tester to start tracking quality across runs." /></div>
  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <Card className="p-4">
        <div className="text-sm font-semibold text-foreground mb-3">Quality trend across runs</div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
              <YAxis domain={[0, 1]} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
              {qaKeys.length > 0 && <YAxis yAxisId="qa" orientation="right" tick={{ fill: '#fbbf24', fontSize: 11 }} />}
              <RTooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {METRICS.map(([k, label], i) => <Line key={k} type="monotone" dataKey={k} name={label} stroke={COLORS[i]} dot={{ r: 2 }} strokeWidth={2} connectNulls />)}
              {qaKeys.map((k, i) => <Line key={k} yAxisId="qa" type="monotone" dataKey={k} name={k.replace('avg_qa_', '')} stroke={QA_PAL[i % QA_PAL.length]} strokeDasharray="4 3" dot={{ r: 2 }} strokeWidth={2} connectNulls />)}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground text-xs uppercase"><tr><th className="text-left px-4 py-2.5 font-medium">Run</th><th className="px-3 font-medium">Fixtures</th>{METRICS.map(([k, l]) => <th key={k} className="px-3 font-medium">{l}</th>)}<th /></tr></thead>
          <tbody>{runs.map((r) => { const s = r.summary; return <React.Fragment key={r.dir}>
            <tr className="border-t border-border hover:bg-accent/50 cursor-pointer" onClick={() => toggle(r.dir)}>
              <td className="px-4 py-2.5 font-mono text-foreground/90">{shortId(r.dir)}</td>
              <td className="text-center text-foreground/80">{s ? s.count : '—'}</td>
              {METRICS.map(([k, , t]) => { const v = s?.[k]; return <td key={k} className="text-center font-mono tabular-nums text-foreground/80">{v == null ? '—' : t === 'pct' ? fmtPct(v) : fmtNum(v)}</td> })}
              <td className="px-3 text-right whitespace-nowrap">
                <button onClick={(e) => { e.stopPropagation(); del(r.dir) }} title="Delete run" className="text-destructive/80 hover:text-destructive p-1"><Trash2 className="w-3.5 h-3.5 inline" /></button>
                <button onClick={(e) => { e.stopPropagation(); openInResults(r.dir) }} title="Open in Results" className="text-info hover:underline p-1"><ArrowUpRight className="w-4 h-4 inline" /></button>
                {expand === r.dir ? <ChevronDown className="w-4 h-4 inline text-muted-foreground" /> : <ChevronRight className="w-4 h-4 inline text-muted-foreground" />}
              </td>
            </tr>
            {expand === r.dir && <tr><td colSpan={7} className="bg-background px-4 py-3"><Breakdown rows={rows[r.dir]} dir={r.dir} openInResults={openInResults} /></td></tr>}
          </React.Fragment> })}</tbody>
        </table>
      </Card>
    </div>
  )
}
function Breakdown({ rows, dir, openInResults }: { rows: any[] | undefined; dir: string; openInResults: (dir: string, file?: string) => void }) {
  if (!rows) return <div className="text-muted-foreground text-sm">Loading…</div>
  if (!rows.length) return <div className="text-muted-foreground text-sm">No per-fixture summary for this run.</div>
  return <table className="w-full text-xs"><thead className="text-muted-foreground"><tr><th className="text-left py-1">Fixture</th><th>Status</th><th>Coverage</th><th>Similarity</th><th>Story/Flow</th><th>Omission</th><th /></tr></thead>
    <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-border/60">
      <td className="py-1.5 text-foreground/80">{isBlocker(r.id) && <span className="text-warning mr-1">★</span>}{r.id}</td>
      <td className="text-center"><PassBadge passed={r.status !== 'FLAGGED' && r.status !== 'INVALID' && r.schema_valid !== false} /></td>
      <td className="text-center font-mono">{fmtNum(r.section_coverage, 2)}</td><td className="text-center font-mono">{fmtNum(r.similarity_to_gold)}</td>
      <td className="text-center font-mono">{fmtNum(r.story_flow)}</td><td className="text-center font-mono">{fmtNum(r.omission_rate)}</td>
      <td className="text-right"><button onClick={() => openInResults(dir, r.id + '.md')} className="text-info hover:underline">open →</button></td>
    </tr>)}</tbody></table>
}
