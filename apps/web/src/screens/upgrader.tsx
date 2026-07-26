'use client'
import * as React from 'react'
import { api, UPGRADER_AGENTS, type LabRun, type UpgradePreview, type PromptSuggestion, type SystemSuggestion, type UpgradeRunRow } from '@/lib/api'
import { cn } from '@notera/ui/lib/utils'
import { computeDiff } from '@notera/ui/lib/md'
import { Card } from '@notera/ui/components/ui/card'
import { Button } from '@notera/ui/components/ui/button'
import { Textarea } from '@notera/ui/components/ui/input'
import { Badge } from '@notera/ui/components/ui/badge'
import { EmptyState, Skeleton } from '@notera/ui/components/ui/skeleton'
import { toast } from 'sonner'
import { Sparkles, Wand2, ShieldAlert, CheckCircle2, RotateCcw, ChevronRight, AlertTriangle, Search } from 'lucide-react'

const selCls = 'h-9 bg-surface border border-border rounded-lg px-2 text-sm text-foreground'

export function Upgrader() {
  const [runs, setRuns] = React.useState<LabRun[] | null>(null)
  const [dbErr, setDbErr] = React.useState<string | null>(null)
  const [runId, setRunId] = React.useState<number | null>(null)
  const [scope, setScope] = React.useState<'agent' | 'system'>('agent')
  const [agentId, setAgentId] = React.useState(UPGRADER_AGENTS[2]) // qa-validator: cheapest to verify
  const [ratio, setRatio] = React.useState(0.5)
  const [failK, setFailK] = React.useState(4)
  const [anchorM, setAnchorM] = React.useState(2)

  const [cmp, setCmp] = React.useState<{ busy: boolean; total?: number; cached?: number; generated?: number; failed?: number } | null>(null)
  const [preview, setPreview] = React.useState<UpgradePreview | null>(null)
  const [pvLoading, setPvLoading] = React.useState(false)
  const [runAgents, setRunAgents] = React.useState<string[] | null>(null)  // agents with captured I/O in the selected run
  const [view, setView] = React.useState<'configure' | 'running' | 'review'>('configure')
  const [progress, setProgress] = React.useState<{ i: number; total: number; agent: string } | null>(null)
  const [detail, setDetail] = React.useState<{ run: any; prompt_suggestions: PromptSuggestion[]; system_suggestions: SystemSuggestion[] } | null>(null)
  const [history, setHistory] = React.useState<UpgradeRunRow[]>([])

  const loadHistory = React.useCallback(() => { api.upgrades().then((d) => setHistory(d.runs || [])).catch(() => {}) }, [])
  React.useEffect(() => {
    api.labRuns().then((d) => { setRuns(d.runs || []); setDbErr(d.error ? (d.hint || d.error) : null); if (d.runs?.length) setRunId(d.runs[0].id) }).catch(() => setRuns([]))
    loadHistory()
  }, [loadHistory])

  const loadPreview = React.useCallback(() => {
    if (!runId || scope !== 'agent') { setPreview(null); return }
    setPvLoading(true)
    api.upgradePreview({ runId, agentId, failK, anchorM, ratio }).then(setPreview).catch(() => setPreview({ ok: false, error: 'preview failed' })).finally(() => setPvLoading(false))
  }, [runId, agentId, failK, anchorM, ratio, scope])
  React.useEffect(() => { setPreview(null) }, [runId, agentId, scope])
  // Readiness: which agents actually have captured I/O in this run (upgrader needs it)
  React.useEffect(() => { if (runId == null) { setRunAgents(null); return } setRunAgents(null); api.upgradeAgents(runId).then((d) => setRunAgents(d.agents || [])).catch(() => setRunAgents([])) }, [runId])
  const eligibleInRun = (runAgents || []).filter((a) => UPGRADER_AGENTS.includes(a))

  const prepareComparisons = async () => {
    if (!runId) return
    setCmp({ busy: true })
    try { const r = await api.autocompare(runId); if (r.ok) { setCmp({ busy: false, total: r.total, cached: r.alreadyCached, generated: r.generated, failed: r.failed }); toast.success(`Comparisons ready: ${(r.alreadyCached || 0) + (r.generated || 0)}/${r.total}`) } else { setCmp(null); toast.error(r.error || 'auto-compare failed') } }
    catch { setCmp(null); toast.error('auto-compare request failed') }
  }

  const errMsg = (e: any) => (e && (e.unauth ? 'session expired — sign in again' : e.message)) || 'request failed (backend unreachable?)'

  const run = async () => {
    if (!runId) return
    setView('running'); setDetail(null); setProgress(null)
    try {
      if (scope === 'system') { await runWholeSystem(); return }
      // Per-agent: single short request.
      const r = await api.runUpgrade({ runId, scope, agentId, failK, anchorM, ratio })
      if (!r.ok || !r.upgradeRunId) { toast.error(r.error || r.hint || 'upgrade failed'); setView('configure'); return }
      const d = await api.upgrade(r.upgradeRunId)
      setDetail(d as any); setView('review'); loadHistory()
      toast.success(`${r.promptSuggestions || 0} prompt edit(s), ${r.systemSuggestions || 0} suggestion(s)`)
    } catch (e) { toast.error(`upgrade request failed — ${errMsg(e)}`); setView('configure') }
  }

  // Whole-system: process each eligible agent in its own short request so a long
  // multi-agent run can never trip the proxy/socket timeout. Shows live progress.
  const runWholeSystem = async () => {
    if (!runId) return
    const start = await api.upgradeStart({ runId, scope: 'system', failK, anchorM, ratio })
    if (!start.ok || !start.upgradeRunId || !start.agents?.length) { toast.error(start.error || start.hint || 'could not start whole-system upgrade'); setView('configure'); return }
    const agents = start.agents
    const diag: any[] = [], rawParts: string[] = []
    let prompts = 0, systems = 0, summary = '', failures = 0
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]
      setProgress({ i: i + 1, total: agents.length, agent: a })
      try {
        const r = await api.upgradeAgent({ upgradeRunId: start.upgradeRunId, runId, agentId: a, failK, anchorM, ratio })
        if (!r.ok) { failures++; diag.push({ agentId: a, status: 'llm_error', reason: r.error || 'request failed' }); continue }
        if (r.diag) diag.push(r.diag)
        if (r.raw) rawParts.push(r.raw)
        prompts += r.promptSuggestions || 0; systems += r.systemSuggestions || 0
        if (r.summary && !summary) summary = r.summary
      } catch (e) { failures++; diag.push({ agentId: a, status: 'llm_error', reason: errMsg(e) }) }
    }
    setProgress(null)
    try { await api.upgradeFinish({ upgradeRunId: start.upgradeRunId, diag, summary, raw: rawParts.join('\n\n'), opts: { failK, anchorM, ratio } }) } catch { /* non-fatal — suggestions are already persisted */ }
    try {
      const d = await api.upgrade(start.upgradeRunId)
      setDetail(d as any); setView('review'); loadHistory()
      if (failures && !prompts && !systems) toast.error(`All ${failures} agent(s) failed — see Diagnostics`)
      else toast.success(`${prompts} prompt edit(s), ${systems} suggestion(s)${failures ? ` · ${failures} agent(s) failed` : ''}`)
    } catch (e) { toast.error(`could not load results — ${errMsg(e)}`); setView('configure') }
  }

  const openUpgrade = async (id: number) => { setView('running'); const d = await api.upgrade(id); setDetail(d as any); setView('review') }

  if (runs === null) return <div className="p-4 sm:p-6 space-y-4"><Skeleton className="h-24" /><Skeleton className="h-48" /></div>
  if (dbErr) return <div className="p-6"><EmptyState icon="🗄️" title="Testing Lab database not connected" hint={dbErr} /></div>
  if (!runs.length) return <div className="p-6"><EmptyState icon="✨" title="No runs yet" hint="Run the tester first — the upgrader learns from a completed run's scores." /></div>

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary" /> System Upgrader</h1>
        {view !== 'configure' && <Button size="sm" variant="outline" onClick={() => setView('configure')}><RotateCcw className="w-3.5 h-3.5 mr-1" /> New upgrade</Button>}
      </div>

      {view === 'configure' && (
        <>
          {/* config bar */}
          <Card className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-muted-foreground flex items-center gap-2">Run
                <select value={runId ?? ''} onChange={(e) => setRunId(Number(e.target.value))} className={selCls}>{runs.map((r) => <option key={r.id} value={r.id}>#{r.run_no} · {r.label.replace(/^run_/, '')} ({r.patient_count})</option>)}</select>
              </label>
              <div className="flex items-center gap-1 text-sm">
                <button onClick={() => setScope('agent')} className={cn('px-2.5 py-1.5 rounded-lg border', scope === 'agent' ? 'bg-accent border-border text-foreground' : 'border-transparent text-muted-foreground')}>Per-agent</button>
                <button onClick={() => setScope('system')} className={cn('px-2.5 py-1.5 rounded-lg border', scope === 'system' ? 'bg-accent border-border text-foreground' : 'border-transparent text-muted-foreground')}>Whole system</button>
              </div>
              {scope === 'agent' && <label className="text-sm text-muted-foreground flex items-center gap-2">Agent
                <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={selCls}>{UPGRADER_AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}</select>
              </label>}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <label className="flex items-center gap-2">Optimize ratio <input type="range" min={0.2} max={0.9} step={0.1} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} /> <span className="tabular-nums text-foreground">{Math.round(ratio * 100)}%</span> optimize · {Math.round((1 - ratio) * 100)}% held-out</label>
              <label className="flex items-center gap-1">worst-K <input type="number" min={1} max={10} value={failK} onChange={(e) => setFailK(Number(e.target.value))} className="w-14 h-8 bg-surface border border-border rounded px-1" /></label>
              <label className="flex items-center gap-1">anchors <input type="number" min={0} max={6} value={anchorM} onChange={(e) => setAnchorM(Number(e.target.value))} className="w-14 h-8 bg-surface border border-border rounded px-1" /></label>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <Button size="sm" variant="secondary" onClick={prepareComparisons} disabled={cmp?.busy}>{cmp?.busy ? 'Preparing comparisons…' : 'Prepare comparisons'}</Button>
              {cmp && !cmp.busy && <span className="text-xs text-muted-foreground">Comparisons: {(cmp.cached || 0) + (cmp.generated || 0)}/{cmp.total} ready{cmp.failed ? `, ${cmp.failed} failed` : ''}</span>}
              {scope === 'agent' && <Button size="sm" variant="outline" onClick={loadPreview} disabled={pvLoading}>{pvLoading ? 'Loading…' : 'Preview evidence'}</Button>}
              <div className="flex-1" />
              <Button size="sm" onClick={run} disabled={!runId}><Wand2 className="w-4 h-4 mr-1.5" /> Run upgrade{scope === 'system' ? ' (all agents)' : ''}</Button>
            </div>
            <p className="text-[11px] text-muted-foreground">The optimizer reads the worst-scoring records (where to fix) and the best (what to preserve), plus each note-vs-gold comparison, and proposes targeted prompt edits. Nothing publishes automatically — you review and publish.</p>
          </Card>

          {/* run readiness — the upgrader needs captured agent I/O, not just metrics */}
          {runAgents !== null && (
            eligibleInRun.length === 0
              ? <div className="text-sm text-warning flex items-start gap-2 border border-warning/30 rounded-lg p-3 bg-warning/5">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>This run has <b>no captured agent input/output</b>, so the optimizer has nothing to analyse. Runs seeded by <code>db:reset</code> / backfill carry only metrics + comparisons. <b>Fix:</b> run a fresh batch from the <b>Run</b> tab (backend up, <code>STORE_BACKEND=postgres</code>) — you'll see <code>[lab] … stored N agent runs</code> in the log — then pick that new run here.</div>
                </div>
              : <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">Agents with captured data in this run:
                  {eligibleInRun.map((a) => <span key={a} className={cn('px-1.5 py-0.5 rounded border text-[11px]', a === agentId && scope === 'agent' ? 'border-primary/50 text-primary' : 'border-border')}>{a}</span>)}
                  {scope === 'agent' && !eligibleInRun.includes(agentId) && <span className="text-warning">· selected agent “{agentId}” has no data in this run</span>}
                </div>
          )}

          {/* preview — "what's going in" */}
          {scope === 'agent' && preview && (
            preview.ok ? (
              <Card className="p-4 space-y-3">
                <div className="text-sm font-semibold text-foreground flex items-center gap-2">Evidence for <code className="text-primary">{preview.agentId}</code>
                  <span className="text-xs text-muted-foreground font-normal">{preview.counts?.records} records · {preview.counts?.optimize} optimize / {preview.counts?.validate} held-out · base v{preview.baseVersion ?? '—'}{preview.hasRegistryRec ? '' : ' (in-code prompt)'}</span></div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-destructive mb-1">Failing samples ({preview.failures?.length || 0}) — where to fix</div>
                    <div className="space-y-2">{(preview.failures || []).map((f) => (
                      <div key={f.slug} className="text-xs border border-border rounded-lg p-2">
                        <div className="text-foreground/90 font-medium">{f.name} <span className="text-muted-foreground">· {f.compare?.overall_score != null ? `${f.compare.overall_score}/100` : `score ${f.score.toFixed(2)}`}</span></div>
                        {!!f.compare?.notera_missing?.length && <div className="text-muted-foreground mt-0.5"><b className="text-destructive/80">missing:</b> {f.compare!.notera_missing!.slice(0, 4).join(' · ')}</div>}
                        {!!f.compare?.notera_extra?.length && <div className="text-muted-foreground"><b className="text-warning/80">extra:</b> {f.compare!.notera_extra!.slice(0, 4).join(' · ')}</div>}
                      </div>))}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-success mb-1">Passing anchors ({preview.anchors?.length || 0}) — preserve</div>
                    <div className="space-y-2">{(preview.anchors || []).map((a) => (
                      <div key={a.slug} className="text-xs border border-border rounded-lg p-2 text-foreground/80">{a.name} <span className="text-muted-foreground">· {a.compare?.overall_score != null ? `${a.compare.overall_score}/100` : `score ${a.score.toFixed(2)}`}</span></div>))}
                      {!preview.anchors?.length && <div className="text-xs text-muted-foreground">none (add anchors or lower the ratio)</div>}</div>
                  </div>
                </div>
              </Card>
            ) : <div className="text-sm text-warning flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {preview.error}</div>
          )}
        </>
      )}

      {view === 'running' && (
        <Card className="p-6 space-y-3">
          <div className="text-sm text-primary flex items-center gap-2"><Sparkles className="w-4 h-4 animate-pulse" />
            {progress ? <>Optimizing <span className="font-mono text-foreground">{progress.agent}</span> — agent {progress.i} of {progress.total}…</> : 'Optimizer is analysing the run…'}
          </div>
          {progress && (
            <div className="h-1.5 w-full rounded-full bg-accent overflow-hidden">
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${Math.round((progress.i / Math.max(1, progress.total)) * 100)}%` }} />
            </div>
          )}
          <Skeleton className="h-24" /><Skeleton className="h-24" />
        </Card>
      )}

      {view === 'review' && detail && <Review detail={detail} onChanged={() => { if (detail?.run?.id) openUpgrade(detail.run.id) }} />}

      {/* history */}
      {view === 'configure' && !!history.length && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-foreground mb-2">Recent upgrades</div>
          <div className="space-y-1">{history.map((h) => (
            <button key={h.id} onClick={() => openUpgrade(h.id)} className="w-full flex items-center gap-2 text-sm px-2 py-1.5 rounded-lg hover:bg-accent text-left">
              <span className="text-muted-foreground text-xs">#{h.id}</span>
              <span className="text-foreground/90">{h.scope === 'system' ? 'whole system' : h.agent_id}</span>
              <span className="text-xs text-muted-foreground">on run #{h.source_run_no ?? '—'} · {h.prompt_count} edits · {h.system_count} ideas</span>
              <div className="flex-1" /><span className="text-xs text-muted-foreground">{h.created_at ? new Date(h.created_at).toLocaleString() : ''}</span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </button>))}</div>
        </Card>
      )}
    </div>
  )
}

function Review({ detail, onChanged }: { detail: { run: any; prompt_suggestions: PromptSuggestion[]; system_suggestions: SystemSuggestion[] }; onChanged: () => void }) {
  const prompts = detail.prompt_suggestions || []
  const systems = detail.system_suggestions || []
  const diag: any[] = detail.run?.input_summary?.diag || []
  const raw: string = detail.run?.raw_output || ''
  const [showRaw, setShowRaw] = React.useState(false)
  const stTone = (s: string) => s === 'ok' ? 'success' : s === 'no_changes' ? 'neutral' : 'warning'
  const empty = !prompts.length && !systems.length
  return (
    <div className="space-y-5">
      {detail.run?.summary && <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Optimizer summary</div><p className="text-sm text-foreground/90">{detail.run.summary}</p></Card>}

      {/* transparency: per-agent diagnostics — always shown, so 0-result runs are explainable */}
      {(diag.length > 0 || !!raw) && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2"><Search className="w-4 h-4 text-info" /> Diagnostics — what the optimizer saw for each agent</div>
          {!!diag.length && <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead className="text-muted-foreground uppercase"><tr><th className="text-left py-1">Agent</th><th>Status</th><th>Records</th><th>Failing</th><th>w/ compare</th><th>Prompt chars</th><th>Output chars</th><th>Parse</th><th>Edits</th><th className="text-left">Reason</th></tr></thead>
              <tbody>{diag.map((d, i) => (
                <tr key={i} className="border-t border-border/60">
                  <td className="py-1.5 font-mono text-foreground/90">{d.agentId}</td>
                  <td className="text-center"><Badge variant={stTone(d.status) as any}>{d.status}</Badge></td>
                  <td className="text-center tabular-nums">{d.records}</td>
                  <td className="text-center tabular-nums">{d.failures}</td>
                  <td className="text-center tabular-nums">{d.hasCompare}</td>
                  <td className="text-center tabular-nums text-muted-foreground">{d.promptChars}</td>
                  <td className="text-center tabular-nums text-muted-foreground">{d.outputChars}</td>
                  <td className="text-center text-muted-foreground">{d.parse || '—'}</td>
                  <td className="text-center tabular-nums">{(d.patches || 0) + (d.systems || 0)}</td>
                  <td className="text-muted-foreground">{d.reason || ''}</td>
                </tr>))}</tbody>
            </table>
          </div>}
          {empty && <div className="text-xs text-warning mt-2 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> No edits were produced. Common causes: the agent had no captured runs for this run (re-run a batch with the backend up so agent I/O is stored), the model's output didn't parse (see raw output), or the optimizer judged the prompt adequate.</div>}
          {raw && <button onClick={() => setShowRaw((v) => !v)} className="text-xs text-info hover:underline mt-2">{showRaw ? 'Hide' : 'Show'} raw optimizer output ({raw.length.toLocaleString()} chars)</button>}
          {showRaw && <pre className="logpane whitespace-pre-wrap text-[11px] max-h-[50vh] overflow-auto bg-background border border-border rounded-lg p-3 mt-2">{raw}</pre>}
        </Card>
      )}

      <div>
        <div className="text-sm font-semibold text-foreground mb-2">Prompt edits ({prompts.length})</div>
        <div className="space-y-4">
          {prompts.map((s) => <PromptSuggestionCard key={s.id} s={s} onChanged={onChanged} />)}
          {!prompts.length && <div className="text-sm text-muted-foreground">No prompt edits proposed — the optimizer judged the current prompt adequate for this evidence.</div>}
        </div>
      </div>

      {!!systems.length && (
        <div>
          <div className="text-sm font-semibold text-foreground mb-2">System improvement suggestions ({systems.length})</div>
          <div className="space-y-2">{systems.map((s) => (
            <Card key={s.id} className="p-3 flex items-start gap-3">
              <Badge variant={s.severity === 'high' ? 'danger' : s.severity === 'low' ? 'warning' : 'neutral'}>{s.category}</Badge>
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">{s.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.detail}</div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => api.systemSuggestionStatus(s.id, 'accepted').then(() => toast.success('Accepted'))} disabled={s.status !== 'open'}>{s.status === 'accepted' ? 'Accepted' : 'Accept'}</Button>
                <Button size="sm" variant="ghost" onClick={() => api.systemSuggestionStatus(s.id, 'dismissed').then(() => toast('Dismissed'))} disabled={s.status !== 'open'}>Dismiss</Button>
              </div>
            </Card>))}</div>
        </div>
      )}
    </div>
  )
}

function PromptSuggestionCard({ s, onChanged }: { s: PromptSuggestion; onChanged: () => void }) {
  const [editing, setEditing] = React.useState(false)
  const [text, setText] = React.useState(s.patched_prompt || s.full_prompt || '')
  const [busy, setBusy] = React.useState(false)
  const diff = React.useMemo(() => computeDiff(s.current_prompt || '', s.patched_prompt || s.full_prompt || ''), [s])
  const published = s.status === 'published'

  const publish = async (final?: string) => {
    if (!confirm(`Publish this edit to '${s.agent_id}'? It becomes the live prompt (a new version) on the next run.`)) return
    setBusy(true)
    try { const r = await api.publishSuggestion(s.id, final); if (r.ok) { toast.success(`Published ${s.agent_id} v${r.publishedVersion}`); onChanged() } else toast.error(r.error || 'publish failed') }
    catch { toast.error('publish request failed') }
    setBusy(false)
  }
  const dismiss = async () => { await api.dismissSuggestion(s.id); toast('Dismissed'); onChanged() }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-sm text-primary font-semibold">{s.agent_id}</code>
        {s.confidence != null && <span className="text-xs text-muted-foreground">confidence {Math.round(s.confidence * 100)}%</span>}
        <span className="text-xs text-muted-foreground">edits base v{s.base_version ?? '—'}</span>
        {s.base_drift && <Badge variant="warning">prompt changed since (now v{s.current_version})</Badge>}
        {s.patch_failed ? <Badge variant="warning">{s.patch_failed} patch(es) didn't anchor</Badge> : null}
        {s.protected_blocked && <Badge variant="danger"><ShieldAlert className="w-3 h-3 mr-1" /> safety-blocked</Badge>}
        {published && <Badge variant="success"><CheckCircle2 className="w-3 h-3 mr-1" /> published v{s.published_version}</Badge>}
      </div>
      {s.rationale && <p className="text-sm text-foreground/85">{s.rationale}</p>}
      {s.protected_blocked && <div className="text-xs text-destructive">Blocked: {s.protected_reason}. Review carefully; publish only via manual edit if you're certain.</div>}

      {!editing ? (
        <pre className="logpane whitespace-pre-wrap text-xs max-h-[40vh] overflow-auto bg-background border border-border rounded-lg p-3">
          {diff.length ? diff.map((d, i) => <div key={i} className={cn(d.t === '+' && 'text-success', d.t === '-' && 'text-destructive')}>{d.t} {d.line}</div>) : <span className="text-muted-foreground">(no line-level change detected — see full prompt)</span>}
        </pre>
      ) : (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-[40vh] font-mono text-xs" />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {!editing
          ? <>
              <Button size="sm" onClick={() => publish()} disabled={busy || published || s.protected_blocked}>Publish</Button>
              <Button size="sm" variant="outline" onClick={() => { setText(s.patched_prompt || s.full_prompt || ''); setEditing(true) }} disabled={published}>Edit then publish</Button>
              <Button size="sm" variant="ghost" onClick={dismiss} disabled={published}>Dismiss</Button>
            </>
          : <>
              <Button size="sm" onClick={() => publish(text)} disabled={busy}>Publish edited</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </>}
      </div>
    </Card>
  )
}
