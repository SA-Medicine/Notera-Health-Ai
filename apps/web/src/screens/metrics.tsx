import * as React from 'react'
import { api, type LabRun, type TrendPoint, type AgentStat, type HeatCell, type MetricRow } from '@/lib/api'
import { cn, fmtNum } from '@notera/ui/lib/utils'
import { Card } from '@notera/ui/components/ui/card'
import { EmptyState, Skeleton } from '@notera/ui/components/ui/skeleton'
import { TrendingUp, TrendingDown, Minus, Database } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend, ResponsiveContainer } from 'recharts'

const CORE: [string, string][] = [['section_coverage', 'Coverage'], ['similarity_to_gold', 'Similarity'], ['story_flow', 'Story/Flow'], ['omission_rate', 'Omission'], ['schema_valid', 'Schema']]
const COLORS = ['#34d399', '#60a5fa', '#c084fc', '#fb7185', '#fbbf24', '#7dd3fc', '#f472b6', '#a3e635']
const lower_is_better = (k: string) => /omission|missing|error|unsupported/i.test(k)
const label = (k: string) => (CORE.find(([kk]) => kk === k)?.[1]) || k.replace(/^qa_/, 'qa: ').replace(/_/g, ' ')

// color a 0..1-ish score → red..green (flip for lower-is-better)
function heat(v: number | null, k: string) {
  if (v == null) return 'transparent'
  let n = v > 1.5 ? v / 5 : v            // qa_* often 0..5; core 0..1
  n = Math.max(0, Math.min(1, n)); if (lower_is_better(k)) n = 1 - n
  const h = Math.round(n * 130)          // 0=red → 130=green
  return `hsl(${h} 65% 45% / 0.85)`
}

export function Metrics({ openInResults }: { openInResults: (dir: string, file?: string) => void }) {
  const [runs, setRuns] = React.useState<LabRun[] | null>(null)
  const [dbErr, setDbErr] = React.useState<string | null>(null)
  const [trend, setTrend] = React.useState<TrendPoint[]>([])
  const [sel, setSel] = React.useState<number | null>(null)
  const [cmpA, setCmpA] = React.useState<number | null>(null)
  const [cmpB, setCmpB] = React.useState<number | null>(null)
  const [heatRows, setHeatRows] = React.useState<HeatCell[]>([])
  const [agents, setAgents] = React.useState<AgentStat[]>([])
  const [cmp, setCmp] = React.useState<{ a: MetricRow[]; b: MetricRow[] } | null>(null)
  const [hidden, setHidden] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    api.labRuns().then((d) => {
      setRuns(d.runs || []); setDbErr(d.error ? (d.hint || d.error) : null)
      if (d.runs?.length) { setSel(d.runs[0].id); setCmpA(d.runs[1]?.id ?? d.runs[0].id); setCmpB(d.runs[0].id) }
    }).catch(() => setRuns([]))
    api.labTrend().then((d) => setTrend(d.points || [])).catch(() => {})
  }, [])
  React.useEffect(() => { if (sel == null) return; api.labHeatmap(sel).then((d) => setHeatRows(d.rows || [])).catch(() => {}); api.labAgents(sel).then((d) => setAgents(d.rows || [])).catch(() => {}) }, [sel])
  React.useEffect(() => { if (cmpA == null || cmpB == null) return; api.labCompare(cmpA, cmpB).then(setCmp).catch(() => {}) }, [cmpA, cmpB])

  const runLabel = (id: number | null) => runs?.find((r) => r.id === id)?.label || ''

  const metricKeys = React.useMemo(() => [...new Set(trend.map((p) => p.metric_key))].sort((a, b) => {
    const ia = CORE.findIndex(([k]) => k === a), ib = CORE.findIndex(([k]) => k === b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  }), [trend])
  const chartData = React.useMemo(() => {
    const by: Record<string, any> = {}
    for (const p of trend) { const row = by[p.run_no] || (by[p.run_no] = { run: '#' + p.run_no }); row[p.metric_key] = Number(p.value) }
    return Object.values(by)
  }, [trend])

  const kpis = React.useMemo(() => {
    const byRun: Record<number, Record<string, number[]>> = {}
    for (const p of trend) { (byRun[p.run_no] ||= {}); (byRun[p.run_no][p.metric_key] ||= []).push(Number(p.value)) }
    const nums = Object.keys(byRun).map(Number).sort((a, b) => b - a)
    const latest = nums[0], prev = nums[1]
    const avg = (rn: number, k: string) => { const a = byRun[rn]?.[k]; return a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : null }
    return CORE.slice(0, 4).map(([k, lbl]) => ({ k, lbl, val: latest != null ? avg(latest, k) : null, delta: (latest != null && prev != null) ? ((avg(latest, k) ?? 0) - (avg(prev, k) ?? 0)) : null }))
  }, [trend])

  const heatPatients = React.useMemo(() => {
    const byP: Record<string, { name: string; slug: string; cells: Record<string, number | null> }> = {}
    for (const r of heatRows) { const e = byP[r.slug] || (byP[r.slug] = { name: r.name, slug: r.slug, cells: {} }); if (r.metric_key) e.cells[r.metric_key] = r.metric_value }
    return Object.values(byP)
  }, [heatRows])
  const heatKeys = React.useMemo(() => [...new Set(heatRows.map((r) => r.metric_key).filter(Boolean) as string[])].sort((a, b) => {
    const ia = CORE.findIndex(([k]) => k === a), ib = CORE.findIndex(([k]) => k === b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  }), [heatRows])

  const cmpDeltas = React.useMemo(() => {
    if (!cmp) return []
    const avg = (rows: MetricRow[]) => { const m: Record<string, number[]> = {}; for (const r of rows) (m[r.metric_key] ||= []).push(Number(r.metric_value)); const o: Record<string, number> = {}; for (const k in m) o[k] = m[k].reduce((s, v) => s + v, 0) / m[k].length; return o }
    const A = avg(cmp.a), B = avg(cmp.b); const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])]
    return keys.map((k) => ({ k, a: A[k], b: B[k], d: (B[k] ?? 0) - (A[k] ?? 0) }))
  }, [cmp])

  if (runs === null) return <div className="p-4 sm:p-6 space-y-5"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>
  if (dbErr) return <div className="p-6"><EmptyState icon="🗄️" title="Testing Lab database not connected" hint={dbErr} /></div>
  if (!runs.length) return <div className="p-6"><EmptyState icon="📊" title="No runs yet" hint="Run the tester (or db:reset to backfill past runs) to populate the dashboard." /></div>

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2"><Database className="w-5 h-5 text-primary" /> Metrics dashboard</h1>
        <div className="text-xs text-muted-foreground">{runs.length} runs · {trend.length} metric points</div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <Card key={k.k} className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{k.lbl}</div>
            <div className="text-2xl font-bold text-foreground tabular-nums mt-1">{k.val == null ? '—' : fmtNum(k.val, 2)}</div>
            {k.delta != null && (
              <div className={cn('text-xs mt-1 flex items-center gap-1', (lower_is_better(k.k) ? -k.delta : k.delta) >= 0 ? 'text-success' : 'text-destructive')}>
                {k.delta === 0 ? <Minus className="w-3 h-3" /> : (lower_is_better(k.k) ? -k.delta : k.delta) > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {k.delta > 0 ? '+' : ''}{fmtNum(k.delta, 3)} vs prev
              </div>
            )}
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="text-sm font-semibold text-foreground flex items-center gap-2"><TrendingUp className="w-4 h-4 text-primary" /> Trend across runs</div>
          <div className="flex flex-wrap gap-1.5">
            {metricKeys.map((k, i) => (
              <button key={k} onClick={() => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n })}
                className={cn('text-[11px] px-2 py-0.5 rounded-full border transition', hidden.has(k) ? 'border-border text-muted-foreground/50 line-through' : 'border-transparent')}
                style={{ background: hidden.has(k) ? 'transparent' : COLORS[i % COLORS.length] + '22', color: hidden.has(k) ? undefined : COLORS[i % COLORS.length] }}>
                {label(k)}
              </button>
            ))}
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="run" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
              <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
              <RTooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {metricKeys.filter((k) => !hidden.has(k)).map((k) => <Line key={k} type="monotone" dataKey={k} name={label(k)} stroke={COLORS[metricKeys.indexOf(k) % COLORS.length]} dot={{ r: 2 }} strokeWidth={2} connectNulls />)}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Inspect run</span>
        <select value={sel ?? ''} onChange={(e) => setSel(Number(e.target.value))} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm">
          {runs.map((r) => <option key={r.id} value={r.id}>#{r.run_no} · {r.label.replace(/^run_/, '')} ({r.patient_count})</option>)}
        </select>
      </div>

      <Card className="p-4 overflow-x-auto">
        <div className="text-sm font-semibold text-foreground mb-3">Fixture heatmap <span className="text-muted-foreground font-normal">— click a cell to open the note vs gold</span></div>
        {!heatPatients.length ? <div className="text-sm text-muted-foreground">No per-fixture metrics for this run.</div> : (
          <table className="text-sm border-separate" style={{ borderSpacing: 2 }}>
            <thead><tr><th className="text-left px-2 text-xs text-muted-foreground font-medium">Patient</th>{heatKeys.map((k) => <th key={k} className="px-2 text-xs text-muted-foreground font-medium">{label(k)}</th>)}</tr></thead>
            <tbody>
              {heatPatients.map((p) => (
                <tr key={p.slug}>
                  <td className="px-2 py-1 text-foreground/90 whitespace-nowrap">{p.name}</td>
                  {heatKeys.map((k) => {
                    const v = p.cells[k]
                    return <td key={k} onClick={() => openInResults(runLabel(sel), p.slug + '.md')}
                      title={`${p.name} · ${label(k)}: ${v == null ? '—' : v} (click to open)`}
                      className="px-2 py-1 text-center rounded cursor-pointer font-mono text-xs text-white/95"
                      style={{ background: heat(v as number | null, k), minWidth: 62 }}>{v == null ? '—' : fmtNum(v as number, 2)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-4 overflow-x-auto">
          <div className="text-sm font-semibold text-foreground mb-3">Per-agent stats</div>
          {!agents.length ? <div className="text-sm text-muted-foreground">No agent I/O captured for this run.</div> : (
            <table className="w-full text-sm min-w-[420px]">
              <thead className="text-muted-foreground text-xs uppercase"><tr><th className="text-left py-1">Agent</th><th>Calls</th><th>Errors</th><th>Latency</th><th>Tok in/out</th></tr></thead>
              <tbody>{agents.map((a) => (
                <tr key={a.agent_id} className="border-t border-border/60">
                  <td className="py-1.5 font-mono text-xs text-foreground/90">{a.agent_id}</td>
                  <td className="text-center tabular-nums">{a.calls}</td>
                  <td className={cn('text-center tabular-nums', a.errors > 0 && 'text-destructive')}>{a.errors}</td>
                  <td className="text-center tabular-nums text-muted-foreground">{a.avg_latency_ms == null ? '—' : Math.round(a.avg_latency_ms) + 'ms'}</td>
                  <td className="text-center tabular-nums text-muted-foreground">{a.avg_tokens_in == null ? '—' : `${Math.round(a.avg_tokens_in)}/${Math.round(a.avg_tokens_out || 0)}`}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>

        <Card className="p-4 overflow-x-auto">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="text-sm font-semibold text-foreground">Compare</span>
            <select value={cmpA ?? ''} onChange={(e) => setCmpA(Number(e.target.value))} className="h-8 bg-surface border border-border rounded-lg px-2 text-xs">{runs.map((r) => <option key={r.id} value={r.id}>#{r.run_no}</option>)}</select>
            <span className="text-muted-foreground text-xs">→</span>
            <select value={cmpB ?? ''} onChange={(e) => setCmpB(Number(e.target.value))} className="h-8 bg-surface border border-border rounded-lg px-2 text-xs">{runs.map((r) => <option key={r.id} value={r.id}>#{r.run_no}</option>)}</select>
          </div>
          {!cmpDeltas.length ? <div className="text-sm text-muted-foreground">Pick two runs to compare.</div> : (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs uppercase"><tr><th className="text-left py-1">Metric</th><th>A</th><th>B</th><th>Δ</th></tr></thead>
              <tbody>{cmpDeltas.map((d) => {
                const good = (lower_is_better(d.k) ? -d.d : d.d) > 0.0005, bad = (lower_is_better(d.k) ? -d.d : d.d) < -0.0005
                return <tr key={d.k} className="border-t border-border/60">
                  <td className="py-1.5 text-foreground/90">{label(d.k)}</td>
                  <td className="text-center tabular-nums text-muted-foreground">{d.a == null ? '—' : fmtNum(d.a, 2)}</td>
                  <td className="text-center tabular-nums text-muted-foreground">{d.b == null ? '—' : fmtNum(d.b, 2)}</td>
                  <td className={cn('text-center tabular-nums font-medium', good && 'text-success', bad && 'text-destructive')}>{d.d > 0 ? '+' : ''}{fmtNum(d.d, 3)}</td>
                </tr>
              })}</tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}
