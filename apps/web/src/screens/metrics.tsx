import * as React from 'react'
import { api, type ResultRun, type RunIndexEntry, type CompareResult, type CompareRunCell } from '@/lib/api'
import { cn, shortId } from '@notera/ui/lib/utils'
import { md } from '@notera/ui/lib/md'
import { EmptyState, Skeleton } from '@notera/ui/components/ui/skeleton'
import { Button } from '@notera/ui/components/ui/button'
import { toast } from 'sonner'
import { GitCompare, TrendingUp, Info, ChevronRight, AlertTriangle, ShieldCheck, Copy, FileBarChart, Sparkles, CheckCircle2, Ghost, ListChecks } from 'lucide-react'
import type { RunSummary } from '@/lib/api'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer } from 'recharts'

const FAMILY_LABEL: Record<string, string> = { equivalence: 'Equivalence', structure: 'Structure', missing_info: 'Missing info', quality: 'Quality', story_flow: 'Story / flow' }
const num = (v: number | null | undefined, d = 3) => (v == null ? '—' : (v as number).toFixed(d))
const signed = (v: number | null | undefined, d = 3) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d))

function deltaTone(c: CompareRunCell) {
  if (c.n < 2 || c.delta == null || c.improved == null) return 'text-muted-foreground'
  const base = c.improved ? 'text-success' : 'text-destructive'
  return c.underpowered ? cn(base, 'opacity-55') : base
}
const arrow = (c: CompareRunCell) => (c.improved == null ? '·' : c.improved ? '▲' : '▼')

export function Metrics({ openInResults }: { openInResults: (dir: string, file?: string) => void }) {
  const [runs, setRuns] = React.useState<ResultRun[] | null>(null)
  const [idx, setIdx] = React.useState<RunIndexEntry[]>([])
  const [tab, setTab] = React.useState<'summary' | 'compare' | 'trend'>('summary')
  const [baseDir, setBaseDir] = React.useState('')
  const [against, setAgainst] = React.useState<string[]>([])
  const [system, setSystem] = React.useState<'both' | 'notera' | 'heidi'>('both')
  const [famFilter, setFamFilter] = React.useState<string | null>(null)
  const [regressOnly, setRegressOnly] = React.useState(false)
  const [focusKey, setFocusKey] = React.useState<string | undefined>(undefined)
  const [cmp, setCmp] = React.useState<CompareResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [hist, setHist] = React.useState<any[]>([])

  const idxMap = React.useMemo(() => Object.fromEntries(idx.map((e) => [e.dir, e])), [idx])
  const fixturesOf = React.useCallback((dir: string) => new Set(idxMap[dir]?.fixtures || []), [idxMap])
  const shared = React.useCallback((a: string, b: string) => { const A = fixturesOf(a); let n = 0; for (const f of fixturesOf(b)) if (A.has(f)) n++; return n }, [fixturesOf])
  const bestMatch = React.useCallback((base: string, list: RunIndexEntry[]) => {
    const cands = list.filter((e) => e.dir !== base && e.hasData)
    if (!cands.length) return ''
    return cands.map((e) => ({ dir: e.dir, s: shared(base, e.dir) })).sort((a, b) => b.s - a.s)[0].dir
  }, [shared])

  React.useEffect(() => {
    Promise.all([api.resultRuns().catch(() => [] as ResultRun[]), api.runIndex().catch(() => [] as RunIndexEntry[])]).then(([r, ix]) => {
      setRuns(r); setIdx(ix)
      const withData = ix.filter((e) => e.hasData)
      const base = (withData[0]?.dir) || r[1]?.dir || r[0]?.dir || ''
      setBaseDir((b) => b || base)
      setAgainst((a) => a.length ? a : (base ? [bestMatch(base, ix)].filter(Boolean) : []))
    })
    api.history().then(setHist).catch(() => {})
  }, [])

  const runCompare = React.useCallback(async () => {
    if (!baseDir || !against.length) { setCmp(null); return }
    setLoading(true)
    try { const c = await api.compareRuns(baseDir, against.filter((d) => d !== baseDir), { focusKey, system: system === 'both' ? null : system }); setCmp(c.ok === false ? null : c) }
    catch { setCmp(null) }
    setLoading(false)
  }, [baseDir, against, focusKey, system])
  React.useEffect(() => { runCompare() }, [baseDir, against, focusKey, system])

  if (runs === null) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>
  if (!runs.length) return <div className="p-6"><EmptyState icon="📊" title="No runs yet" hint="Run the tester; metrics and comparisons appear here." /></div>

  const toggleAgainst = (dir: string) => setAgainst((a) => a.includes(dir) ? a.filter((x) => x !== dir) : [...a, dir])
  const metricsShown = (cmp?.metrics || [])
    .filter((m) => !famFilter || m.meta.family === famFilter)
    .filter((m) => !regressOnly || m.runs.some((r) => r.improved === false && !r.underpowered))
  const families = [...new Set((cmp?.metrics || []).map((m) => m.meta.family))]
  const primaryShared = against[0] ? shared(baseDir, against[0]) : 0
  const noOverlap = against.length > 0 && against.every((d) => shared(baseDir, d) === 0)
  const baseSummary = idxMap[baseDir]?.summary || null

  const copyMarkdown = () => {
    if (!cmp) return
    const head = ['Metric', 'Family', 'n', 'Base', ...cmp.runs.map((r) => shortId(r.dir) + ' Δ')]
    const rows = metricsShown.map((m) => [m.meta.label, FAMILY_LABEL[m.meta.family] || m.meta.family, String(m.runs[0]?.n ?? 0), num(m.base, 3), ...m.runs.map((r) => (r.n >= 2 ? `${signed(r.delta, 3)} (${r.verdict})` : 'unpaired'))])
    const md = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n')
    navigator.clipboard.writeText(md).then(() => toast.success('Copied table as markdown')).catch(() => {})
  }

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><GitCompare className="w-4 h-4 text-primary" /> Metrics</div>
        <div className="flex rounded-lg border border-border overflow-hidden text-xs">
          {([['summary', 'Run report'], ['compare', 'Compare'], ['trend', 'Trend']] as const).map(([t, lbl]) => <button key={t} onClick={() => setTab(t)} className={cn('px-3 py-1.5', tab === t ? 'bg-raised text-foreground' : 'text-muted-foreground hover:bg-accent')}>{lbl}</button>)}
        </div>
        <div className="flex-1" />
        <span className="text-[11px] text-muted-foreground">{idx.filter((e) => e.hasData).length}/{runs.length} runs with data</span>
      </div>

      {tab === 'compare' && <>
        <div className="rounded-xl border border-border bg-surface p-3 flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="text-muted-foreground text-xs uppercase tracking-wide w-16">Baseline</span>
            <select value={baseDir} onChange={(e) => { setBaseDir(e.target.value); setAgainst([bestMatch(e.target.value, idx)].filter(Boolean)) }} className="h-8 bg-background border border-border rounded-lg px-2 text-sm">
              {runs.map((r) => { const e = idxMap[r.dir]; return <option key={r.dir} value={r.dir}>{shortId(r.dir)} · {e ? (e.hasData ? e.n + ' fx' : 'no data') : '?'}</option> })}
            </select>
            <span className="text-[10px] text-muted-foreground">📌 pinned</span>
          </div>
          <div className="flex items-start gap-2 flex-wrap text-sm">
            <span className="text-muted-foreground text-xs uppercase tracking-wide w-16 pt-1.5">Against</span>
            <div className="flex-1 flex items-center gap-1.5 flex-wrap max-h-24 overflow-auto">
              {runs.filter((r) => r.dir !== baseDir).map((r) => {
                const on = against.includes(r.dir); const e = idxMap[r.dir]; const sh = e?.hasData ? shared(baseDir, r.dir) : -1
                return <button key={r.dir} onClick={() => toggleAgainst(r.dir)} title={sh < 0 ? 'no results' : `${sh} shared fixtures`}
                  className={cn('px-2 py-1 rounded-md border text-xs transition flex items-center gap-1', on ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-accent', sh < 0 && 'opacity-40')}>
                  {shortId(r.dir)}{sh < 0 ? <span className="text-[9px] text-destructive/70">∅</span> : sh > 0 ? <span className="text-[9px] text-success/80">{sh}∩</span> : <span className="text-[9px] text-warning/70">0∩</span>}
                </button>
              })}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap text-xs border-t border-border pt-2.5">
            <span className="text-muted-foreground">system</span>
            {(['both', 'notera', 'heidi'] as const).map((s) => <label key={s} className="flex items-center gap-1 cursor-pointer"><input type="radio" checked={system === s} onChange={() => setSystem(s)} className="accent-primary" /> {s}</label>)}
            <span className="text-border">·</span>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={regressOnly} onChange={(e) => setRegressOnly(e.target.checked)} className="accent-primary" /> regressions only</label>
            <div className="flex-1" />
            {cmp?.power && <span className="text-muted-foreground">{primaryShared} shared · smallest detectable Δ on {cmp.power.focusLabel} ≈ <b className="text-foreground/80">{num(cmp.power.mde, 2)}</b></span>}
          </div>
        </div>

        {/* gates strip for the baseline */}
        {baseSummary && <div className="flex items-center gap-2 flex-wrap text-xs">
          <ShieldCheck className="w-3.5 h-3.5 text-primary" /><span className="text-muted-foreground">Baseline gates:</span>
          {[
            { label: 'Coverage ≥ 0.80', ok: (baseSummary.avg_section_coverage ?? 0) >= 0.8, val: num(baseSummary.avg_section_coverage, 2) },
            { label: 'Schema valid = 1', ok: (baseSummary.schema_validity ?? 0) >= 1, val: num(baseSummary.schema_validity, 2) },
            { label: 'Unsupported meds = 0', ok: (baseSummary.total_unsupported_meds ?? 0) === 0, val: String(baseSummary.total_unsupported_meds ?? '—') },
          ].map((g) => <span key={g.label} className={cn('px-2 py-0.5 rounded-md border', g.ok ? 'border-success/40 text-success bg-success/5' : 'border-destructive/40 text-destructive bg-destructive/5')}>{g.ok ? '✓' : '✕'} {g.label} <span className="opacity-60">({g.val})</span></span>)}
        </div>}

        {/* no-overlap guidance */}
        {noOverlap && <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-warning font-medium">No shared fixtures with the baseline</div>
            <div className="text-muted-foreground text-xs mt-0.5">A paired comparison needs the two runs to have run the same fixtures. The selected run{against.length > 1 ? 's' : ''} share 0. Deltas below are <b>unpaired</b> (each run's own mean, not comparable per-fixture).</div>
          </div>
          {bestMatch(baseDir, idx) && shared(baseDir, bestMatch(baseDir, idx)) > 0 && <button onClick={() => setAgainst([bestMatch(baseDir, idx)])} className="text-xs px-2 py-1 rounded-md border border-primary text-primary hover:bg-primary/10 shrink-0">Use best match ({shared(baseDir, bestMatch(baseDir, idx))}∩)</button>}
        </div>}

        {families.length > 1 && <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setFamFilter(null)} className={cn('px-2 py-0.5 rounded-md text-[11px] border', !famFilter ? 'border-primary text-foreground bg-primary/10' : 'border-border text-muted-foreground')}>all</button>
          {families.map((f) => <button key={f} onClick={() => setFamFilter(f)} className={cn('px-2 py-0.5 rounded-md text-[11px] border', famFilter === f ? 'border-primary text-foreground bg-primary/10' : 'border-border text-muted-foreground')}>{FAMILY_LABEL[f] || f}</button>)}
          <div className="flex-1" />
          <button onClick={copyMarkdown} className="text-[11px] px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-foreground flex items-center gap-1"><Copy className="w-3 h-3" /> copy md</button>
        </div>}

        {loading && <Skeleton className="h-64 w-full" />}
        {!loading && !cmp && <EmptyState icon="⚖️" title="Pick a baseline and at least one run with data" hint="Comparison is paired over shared fixtures." />}
        {!loading && cmp && <>
          <div className="rounded-xl border border-border bg-surface overflow-x-auto">
            <table className="w-full text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Metric</th>
                  <th className="text-left font-medium px-2 py-2 hidden sm:table-cell">Family</th>
                  <th className="text-right font-medium px-2 py-2">n</th>
                  <th className="text-right font-medium px-2 py-2">Base</th>
                  {cmp.runs.map((r) => <th key={r.dir} className="text-right font-medium px-3 py-2">{shortId(r.dir)}</th>)}
                </tr>
              </thead>
              <tbody>
                {metricsShown.map((m) => (
                  <tr key={m.key} onClick={() => setFocusKey(m.key)} className={cn('border-b border-border/50 cursor-pointer hover:bg-accent/40', focusKey === m.key && 'bg-accent/60', m.meta.severity === 'critical' && 'border-l-2 border-l-destructive/60')}>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-foreground/90">{m.meta.label}</span>
                        {m.meta.isGate && <span className="text-[9px] px-1 rounded bg-warning/15 text-warning">gate</span>}
                        <span className="text-[9px] text-muted-foreground">{m.meta.polarity === 'lower_better' ? '↓ better' : m.meta.polarity === 'higher_better' ? '↑ better' : ''}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground text-xs hidden sm:table-cell">{FAMILY_LABEL[m.meta.family] || m.meta.family}</td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">{m.runs[0]?.n ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right text-foreground/70">{num(m.base, m.meta.unit === 'count' ? 1 : 3)}</td>
                    {m.runs.map((r) => (
                      <td key={r.dir} className="px-3 py-1.5 text-right">
                        {r.n >= 2 ? <>
                          <div className={cn('font-medium', deltaTone(r))}>{arrow(r)} {signed(r.delta, m.meta.unit === 'count' ? 1 : 3)}</div>
                          {r.ciLow != null && <div className="text-[9px] text-muted-foreground">[{num(r.ciLow, 2)},{num(r.ciHigh, 2)}]{r.underpowered ? ' · indic.' : r.significant ? ' · sig' : ''}</div>}
                        </> : <div className="text-muted-foreground">{r.mean != null ? <span title="unpaired — no shared fixtures">{num(r.mean, m.meta.unit === 'count' ? 1 : 3)} <span className="text-[9px] opacity-60">unpaired</span></span> : 'no data'}</div>}
                      </td>
                    ))}
                  </tr>
                ))}
                {metricsShown.length === 0 && <tr><td colSpan={4 + cmp.runs.length} className="px-3 py-6 text-center text-muted-foreground text-sm">No metrics match the filter.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Info className="w-3 h-3" /> Paired over shared fixtures. Grey = underpowered (n&lt;8 or CI crosses 0). "unpaired" = the run's own mean when it shares no fixtures with the baseline. Click a metric to drill in.</p>

          {cmp.perFixture.focusKey && cmp.perFixture.rows.some((f) => f.delta != null) && <div className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground flex items-center gap-1.5">
              <ChevronRight className="w-3.5 h-3.5" /> Per-fixture · <b className="text-foreground/80">{(cmp.metrics.find((m) => m.key === cmp.perFixture.focusKey)?.meta.label) || cmp.perFixture.focusKey}</b> · Δ vs baseline · contribution = share of the aggregate move
            </div>
            <div className="max-h-[46vh] overflow-auto">
              <table className="w-full text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border sticky top-0 bg-surface">
                  <tr><th className="text-left font-medium px-3 py-2">Fixture</th><th className="text-right font-medium px-2 py-2">Base</th>{cmp.runs.map((r) => <th key={r.dir} className="text-right font-medium px-2 py-2">{shortId(r.dir)}</th>)}<th className="text-right font-medium px-2 py-2">Δ</th><th className="text-left font-medium px-3 py-2 w-40">contribution</th></tr>
                </thead>
                <tbody>
                  {cmp.perFixture.rows.filter((f) => f.base != null || f.runs.some((v) => v != null)).map((f) => (
                    <tr key={f.fixture} onClick={() => openInResults(cmp.runs[0]?.dir || cmp.baseDir, f.fixture + '.md')} className={cn('border-b border-border/40 cursor-pointer hover:bg-accent/40', f.delta != null && f.delta !== 0 && 'border-l-2', f.delta != null && f.delta < 0 && 'border-l-destructive/50', f.delta != null && f.delta > 0 && 'border-l-success/50')}>
                      <td className="px-3 py-1.5 text-foreground/85 font-mono text-xs truncate max-w-[16rem]">{f.fixture}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground">{num(f.base, 2)}</td>
                      {f.runs.map((v, i) => <td key={i} className="px-2 py-1.5 text-right text-foreground/80">{num(v, 2)}</td>)}
                      <td className={cn('px-2 py-1.5 text-right font-medium', f.delta == null || f.delta === 0 ? 'text-muted-foreground' : f.delta > 0 ? 'text-success' : 'text-destructive')}>{f.delta == null ? '—' : signed(f.delta, 2)}</td>
                      <td className="px-3 py-1.5">
                        {f.contributionPct != null && f.contributionPct > 0 && <div className="flex items-center gap-1.5"><div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, f.contributionPct)}%` }} /></div><span className="text-[10px] text-muted-foreground w-9 text-right">{f.contributionPct}%</span></div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>}
        </>}
      </>}

      {tab === 'summary' && <SummaryPanel runs={runs} idx={idx} defaultDir={baseDir} openInResults={openInResults} />}
      {tab === 'trend' && <TrendPanel hist={hist} />}
    </div>
  )
}

// ── Run report: the "Eval Analyst" — aggregate all comparison scores + LLM synthesis ──
function VBar({ label, notera, gold }: { label: string; notera: number | null; gold: number | null }) {
  const pct = (v: number | null) => (v == null ? 0 : Math.max(0, Math.min(100, (v / 5) * 100)))
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <span className="text-foreground/80">{label}</span>
      <div className="space-y-1">
        <div className="flex items-center gap-2"><span className="text-[10px] w-10 text-primary">Notera</span><div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${pct(notera)}%` }} /></div><span className="w-8 text-right font-mono text-xs">{notera ?? '—'}</span></div>
        <div className="flex items-center gap-2"><span className="text-[10px] w-10 text-warning">Gold</span><div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-warning" style={{ width: `${pct(gold)}%` }} /></div><span className="w-8 text-right font-mono text-xs">{gold ?? '—'}</span></div>
      </div>
    </div>
  )
}
function List({ title, items, tone, Icon }: { title: string; items?: string[]; tone: string; Icon: any }) {
  const list = items || []
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className={cn('flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-2', list.length ? tone : 'text-muted-foreground')}><Icon className="w-3.5 h-3.5" />{title} <span className="text-muted-foreground font-normal">({list.length})</span></div>
      {list.length === 0 ? <div className="text-muted-foreground/50 text-sm">—</div> : <ul className="space-y-1.5">{list.map((x, i) => <li key={i} className="text-sm text-foreground/85 flex gap-2"><span className={cn('mt-[7px] w-1.5 h-1.5 rounded-full shrink-0', tone.replace('text-', 'bg-'))} />{x}</li>)}</ul>}
    </div>
  )
}

function SummaryPanel({ runs, idx, defaultDir, openInResults }: { runs: ResultRun[]; idx: RunIndexEntry[]; defaultDir: string; openInResults: (dir: string, file?: string) => void }) {
  const [dir, setDir] = React.useState(defaultDir)
  const [rep, setRep] = React.useState<RunSummary | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { if (!dir && defaultDir) setDir(defaultDir) }, [defaultDir])
  React.useEffect(() => { setRep(null); if (dir) api.runSummaryGet(dir).then((r) => { if (r.cached) setRep(r) }).catch(() => {}) }, [dir])
  const gen = async () => { if (!dir || busy) return; setBusy(true); try { const r = await api.runSummaryRun(dir); setRep(r); if (r.ok === false) toast.error(r.error || 'Run report unavailable'); else toast.success('Run report ready') } catch { toast.error('Run report failed') } setBusy(false) }
  const idxMap = Object.fromEntries(idx.map((e) => [e.dir, e]))
  const vc = rep?.verdict_counts || {}
  const total = (vc.notera_better || 0) + (vc.gold_better || 0) + (vc.equivalent || 0) || 1

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border bg-surface p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><FileBarChart className="w-4 h-4 text-primary" /> Run report</div>
        <span className="text-xs text-muted-foreground">Eval-Analyst summary of every comparison + score in a run</span>
        <div className="flex-1" />
        <select value={dir} onChange={(e) => setDir(e.target.value)} className="h-8 bg-background border border-border rounded-lg px-2 text-sm">
          {runs.map((r) => { const e = idxMap[r.dir]; return <option key={r.dir} value={r.dir}>{shortId(r.dir)} · {e ? (e.hasData ? e.n + ' fx' : 'no data') : '?'}</option> })}
        </select>
        <Button size="sm" onClick={gen} disabled={busy || !dir}>{busy ? 'Analyzing…' : rep?.generatedAt ? 'Regenerate' : 'Generate report'}</Button>
      </div>

      {busy && <div className="space-y-3"><Skeleton className="h-28 w-full" /><div className="grid grid-cols-1 md:grid-cols-2 gap-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div></div>}
      {!busy && !rep && <div className="min-h-[40vh] flex items-center justify-center rounded-xl border border-dashed border-border bg-surface/40"><div className="text-center max-w-md px-8 py-10"><div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4"><FileBarChart className="w-7 h-7 text-primary" /></div><div className="text-foreground font-semibold text-lg mb-1.5">Generate a run report</div><p className="text-sm text-muted-foreground leading-relaxed">Aggregates every per-fixture comparison score in this run, then an LLM synthesizes the recurring gaps vs gold, failure themes, and prioritized fixes. Needs comparisons generated in Results (or Auto on).</p><Button size="sm" className="mt-5" onClick={gen} disabled={!dir}>Generate report</Button></div></div>}
      {!busy && rep?.ok === false && <div className="rounded-xl border border-warning/40 bg-warning/5 p-4"><div className="font-semibold text-warning mb-1 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Run report unavailable</div><div className="text-sm text-muted-foreground">{rep.error}</div>{rep.hint && <div className="text-xs text-muted-foreground mt-1">{rep.hint}</div>}</div>}

      {!busy && rep && rep.ok !== false && <>
        {/* headline + score + verdict split */}
        <div className="rounded-xl border border-border bg-gradient-to-br from-surface to-surface/40 p-5 flex items-center gap-5 flex-wrap">
          <div className="text-center">
            <div className={cn('text-4xl font-bold tabular-nums', (rep.avg_overall ?? 0) >= 80 ? 'text-success' : (rep.avg_overall ?? 0) >= 55 ? 'text-warning' : 'text-destructive')}>{rep.avg_overall ?? '—'}</div>
            <div className="text-[10px] text-muted-foreground">avg / 100 · {rep.n_scored} scored</div>
          </div>
          <div className="min-w-0 flex-1">
            {rep.headline ? <p className="text-base text-foreground/90 font-medium leading-snug mb-2">{rep.headline}</p> : <p className="text-sm text-muted-foreground mb-2">Aggregate report (LLM synthesis {rep.synthError ? 'unavailable: ' + rep.synthError : 'off'}).</p>}
            <div className="flex items-center gap-0.5 h-2.5 rounded-full overflow-hidden max-w-md">
              <div className="h-full bg-success" style={{ width: `${(vc.notera_better || 0) / total * 100}%` }} title={`Notera better: ${vc.notera_better || 0}`} />
              <div className="h-full bg-muted-foreground/50" style={{ width: `${(vc.equivalent || 0) / total * 100}%` }} title={`Equivalent: ${vc.equivalent || 0}`} />
              <div className="h-full bg-destructive" style={{ width: `${(vc.gold_better || 0) / total * 100}%` }} title={`Gold better: ${vc.gold_better || 0}`} />
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success" /> Notera {vc.notera_better || 0}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/50" /> tie {vc.equivalent || 0}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-destructive" /> gold {vc.gold_better || 0}</span>
              {rep.model && <span className="flex items-center gap-1 ml-2"><Sparkles className="w-3 h-3" />{rep.model}</span>}
            </div>
          </div>
        </div>

        {/* dimension averages + metric strip */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-surface p-4 space-y-2.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Dimension averages · Notera vs Gold</div>
            {rep.dimension_averages.map((d) => <VBar key={d.name} label={d.name} notera={d.notera} gold={d.gold} />)}
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Run metrics</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {rep.metrics ? Object.entries(rep.metrics).map(([k, v]) => <div key={k} className="flex items-center justify-between"><span className="text-muted-foreground text-xs">{k.replace(/^avg_|^total_/, '').replace(/_/g, ' ')}</span><span className="font-mono tabular-nums">{typeof v === 'number' ? v.toFixed(k.includes('meds') ? 0 : 3) : String(v)}</span></div>) : <span className="text-muted-foreground text-sm">no metric summary</span>}
            </div>
          </div>
        </div>

        {/* themes + lists */}
        {rep.failure_themes?.length > 0 && <div className="rounded-xl border border-border bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Failure themes across the run</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {rep.failure_themes.map((t, i) => <div key={i} className="border border-border rounded-lg p-2.5"><div className="flex items-center justify-between mb-1"><span className="text-sm font-medium text-foreground/90">{t.theme}</span><span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive">{t.count}×</span></div>{(t.examples || []).length > 0 && <ul className="text-xs text-muted-foreground space-y-0.5">{t.examples.slice(0, 4).map((e, j) => <li key={j}>· {e}</li>)}</ul>}</div>)}
          </div>
        </div>}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <List title="Recurring gaps vs gold" items={rep.recurring_missing} tone="text-warning" Icon={CheckCircle2} />
          <List title="Recurring fabrications" items={rep.recurring_fabrications} tone="text-destructive" Icon={Ghost} />
          <List title="Recommendations" items={rep.recommendations} tone="text-info" Icon={ListChecks} />
        </div>

        {/* worst / best fixtures */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-surface p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-destructive mb-2">Weakest fixtures</div>
            <div className="space-y-1">{rep.worst_fixtures.map((f) => <button key={f.fixture} onClick={() => openInResults(dir, f.fixture + '.md')} className="w-full flex items-center gap-2 text-left text-sm px-2 py-1 rounded hover:bg-accent/40"><span className="font-mono text-xs text-destructive w-8">{f.score}</span><span className="font-mono text-xs text-foreground/85 truncate flex-1">{f.fixture}</span><span className="text-[10px] text-muted-foreground">{String(f.verdict || '').replace(/_/g, ' ')}</span></button>)}</div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-success mb-2">Strongest fixtures</div>
            <div className="space-y-1">{rep.best_fixtures.map((f) => <button key={f.fixture} onClick={() => openInResults(dir, f.fixture + '.md')} className="w-full flex items-center gap-2 text-left text-sm px-2 py-1 rounded hover:bg-accent/40"><span className="font-mono text-xs text-success w-8">{f.score}</span><span className="font-mono text-xs text-foreground/85 truncate flex-1">{f.fixture}</span><span className="text-[10px] text-muted-foreground">{String(f.verdict || '').replace(/_/g, ' ')}</span></button>)}</div>
          </div>
        </div>

        {rep.narrative && <div className="rounded-xl border border-border bg-surface p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><FileBarChart className="w-3.5 h-3.5 text-primary" /> Analyst narrative</div><div className="md text-sm text-foreground/90 leading-relaxed" dangerouslySetInnerHTML={{ __html: md.render(rep.narrative) }} /></div>}
        {rep.generatedAt && <p className="text-[10px] text-muted-foreground">generated {new Date(rep.generatedAt).toLocaleString()} · {rep.n_fixtures} fixtures{rep.synthesized ? '' : ' · aggregate only (LLM synthesis off)'}</p>}
      </>}
    </div>
  )
}

const TREND_FAMILIES: { family: string; series: { key: string; label: string; color: string }[] }[] = [
  { family: 'equivalence', series: [{ key: 'avg_section_coverage', label: 'Coverage', color: '#34d399' }, { key: 'avg_similarity_to_gold', label: 'Similarity', color: '#60a5fa' }] },
  { family: 'missing_info', series: [{ key: 'avg_omission_rate', label: 'Omission (↓)', color: '#fb7185' }] },
  { family: 'story_flow', series: [{ key: 'avg_story_flow', label: 'Story flow', color: '#c084fc' }] },
  { family: 'structure', series: [{ key: 'schema_validity', label: 'Schema valid', color: '#fbbf24' }] },
]

function TrendPanel({ hist }: { hist: any[] }) {
  const [n, setN] = React.useState(20)
  const [fail, setFail] = React.useState<{ themes: { theme: string; total: number; runs: number }[] } | null>(null)
  React.useEffect(() => { api.failureTrend().then(setFail).catch(() => {}) }, [])
  const maxFail = Math.max(1, ...(fail?.themes || []).map((t) => t.total))
  if (!hist.length) return <EmptyState icon="📈" title="No trend history yet" hint="Each completed run appends a point." />
  const data = hist.slice(-n).map((h) => ({ ...h, name: shortId(String(h.runId || '')).slice(-8) }))
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs">
        <TrendingUp className="w-3.5 h-3.5 text-primary" /><span className="text-muted-foreground">last</span>
        {[10, 20, 30, 999].map((k) => <button key={k} onClick={() => setN(k)} className={cn('px-2 py-0.5 rounded border text-[11px]', n === k ? 'border-primary text-foreground' : 'border-border text-muted-foreground')}>{k === 999 ? 'all' : k}</button>)}
        <span className="text-muted-foreground ml-2">score metrics only · one chart per family · uniform 0–1 axis</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {TREND_FAMILIES.map((fam) => (
          <div key={fam.family} className="rounded-xl border border-border bg-surface p-3">
            <div className="text-xs font-semibold text-foreground/80 mb-2">{FAMILY_LABEL[fam.family] || fam.family}</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="currentColor" className="text-muted-foreground" />
                <YAxis domain={[0, 1]} tick={{ fontSize: 9 }} stroke="currentColor" className="text-muted-foreground" />
                <RTooltip contentStyle={{ background: '#111', border: '1px solid #333', borderRadius: 8, fontSize: 12 }} />
                {fam.series.map((s) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} dot={false} strokeWidth={2} connectNulls />)}
              </LineChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-3 mt-1">{fam.series.map((s) => <span key={s.key} className="flex items-center gap-1 text-[10px] text-muted-foreground"><span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label}</span>)}</div>
          </div>
        ))}
      </div>
      {!!(fail?.themes || []).length && <div className="rounded-xl border border-border bg-surface p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Failure modes across recent runs <span className="font-normal">(from run reports)</span></div>
        <div className="space-y-1.5">{(fail?.themes || []).map((t) => <div key={t.theme} className="grid grid-cols-[1fr_9rem] items-center gap-3 text-sm"><span className="text-foreground/85 truncate">{t.theme}</span><div className="flex items-center gap-2"><div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-destructive/70" style={{ width: `${(t.total / maxFail) * 100}%` }} /></div><span className="w-14 text-right text-[11px] text-muted-foreground tabular-nums">{t.total}× · {t.runs}r</span></div></div>)}</div>
        <p className="text-[10px] text-muted-foreground mt-2">Total occurrences × across the runs that have a run report. Generate run reports (Run report tab) to populate this.</p>
      </div>}
    </div>
  )
}
