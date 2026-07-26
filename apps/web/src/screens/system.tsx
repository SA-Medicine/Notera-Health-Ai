'use client'
import * as React from 'react'
import { api, type SystemSuggestionRow } from '@/lib/api'
import { cn } from '@notera/ui/lib/utils'
import { Card } from '@notera/ui/components/ui/card'
import { Button } from '@notera/ui/components/ui/button'
import { Badge } from '@notera/ui/components/ui/badge'
import { EmptyState, Skeleton } from '@notera/ui/components/ui/skeleton'
import { toast } from 'sonner'
import { Lightbulb, Check, X, RotateCcw, FileText, FileDown } from 'lucide-react'

type StatusFilter = 'all' | 'open' | 'accepted' | 'dismissed'

const SEV_VARIANT: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = { high: 'danger', low: 'warning', info: 'info' }
const STATUS_VARIANT: Record<string, 'success' | 'danger' | 'neutral'> = { accepted: 'success', dismissed: 'danger', open: 'neutral' }

function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function toMarkdown(rows: SystemSuggestionRow[]) {
  const date = new Date().toISOString().slice(0, 10)
  const lines: string[] = [
    `# Notera — System Upgrader: System-Level Suggestions`,
    ``,
    `_Exported ${date} · ${rows.length} suggestion${rows.length === 1 ? '' : 's'}_`,
    ``,
    `These are non-prompt, system-level improvement ideas (pipeline, metric, guardrail, data) proposed by the System Upgrader. Prompt edits live in the Upgrader tab; this document collects the higher-level architectural suggestions.`,
    ``,
  ]
  const byCat = new Map<string, SystemSuggestionRow[]>()
  for (const r of rows) { const k = r.category || 'other'; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k)!.push(r) }
  for (const [cat, items] of byCat) {
    lines.push(`## ${cat[0].toUpperCase() + cat.slice(1)}`, ``)
    for (const r of items) {
      lines.push(`### ${r.title}`)
      lines.push(``)
      lines.push(`- **Severity:** ${r.severity} · **Status:** ${r.status}`)
      const src = r.source_run_no != null ? `run #${r.source_run_no}${r.source_label ? ` (${r.source_label})` : ''}` : 'unknown run'
      lines.push(`- **From:** ${src} · upgrade #${r.upgrade_run_id}${r.upgrade_agent ? ` · agent ${r.upgrade_agent}` : ''}`)
      lines.push(``)
      lines.push(r.detail || '')
      lines.push(``)
    }
  }
  return lines.join('\n')
}

function toText(rows: SystemSuggestionRow[]) {
  const date = new Date().toISOString().slice(0, 10)
  const out: string[] = [
    `NOTERA — SYSTEM UPGRADER: SYSTEM-LEVEL SUGGESTIONS`,
    `Exported ${date} · ${rows.length} suggestion(s)`,
    `${'='.repeat(60)}`,
    ``,
  ]
  rows.forEach((r, i) => {
    const src = r.source_run_no != null ? `run #${r.source_run_no}${r.source_label ? ` (${r.source_label})` : ''}` : 'unknown run'
    out.push(`${i + 1}. [${(r.category || 'other').toUpperCase()}] ${r.title}`)
    out.push(`   severity: ${r.severity} | status: ${r.status} | from: ${src} | upgrade #${r.upgrade_run_id}`)
    out.push(``)
    for (const ln of (r.detail || '').split('\n')) out.push(`   ${ln}`)
    out.push(``)
    out.push(`   ${'-'.repeat(56)}`)
    out.push(``)
  })
  return out.join('\n')
}

export function SystemIdeas() {
  const [rows, setRows] = React.useState<SystemSuggestionRow[] | null>(null)
  const [dbErr, setDbErr] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<StatusFilter>('all')
  const [category, setCategory] = React.useState<string>('all')
  const [busy, setBusy] = React.useState<number | null>(null)

  const load = React.useCallback(() => {
    api.systemSuggestions().then((d) => { setRows(d.suggestions || []); setDbErr(d.error ? (d.hint || d.error) : null) }).catch(() => setRows([]))
  }, [])
  React.useEffect(() => { load() }, [load])

  const categories = React.useMemo(() => Array.from(new Set((rows || []).map((r) => r.category || 'other'))).sort(), [rows])
  const filtered = React.useMemo(() => (rows || []).filter((r) =>
    (status === 'all' || r.status === status) && (category === 'all' || (r.category || 'other') === category)
  ), [rows, status, category])

  const counts = React.useMemo(() => {
    const c = { total: (rows || []).length, open: 0, accepted: 0, dismissed: 0 }
    for (const r of rows || []) { if (r.status === 'accepted') c.accepted++; else if (r.status === 'dismissed') c.dismissed++; else c.open++ }
    return c
  }, [rows])

  const setRowStatus = async (id: number, next: string) => {
    setBusy(id)
    try {
      const r = await api.systemSuggestionStatus(id, next)
      if (r.ok) { setRows((prev) => (prev || []).map((x) => (x.id === id ? { ...x, status: next } : x))); toast.success(next === 'open' ? 'Reopened' : next === 'accepted' ? 'Marked accepted' : 'Dismissed') }
      else toast.error(r.error || 'update failed')
    } catch { toast.error('request failed') } finally { setBusy(null) }
  }

  const exportAs = (kind: 'md' | 'txt') => {
    if (!filtered.length) { toast.error('Nothing to export with the current filters'); return }
    const date = new Date().toISOString().slice(0, 10)
    if (kind === 'md') download(`notera-system-ideas-${date}.md`, toMarkdown(filtered), 'text/markdown')
    else download(`notera-system-ideas-${date}.txt`, toText(filtered), 'text/plain')
    toast.success(`Exported ${filtered.length} as .${kind}`)
  }

  const pill = (v: StatusFilter, label: string, n?: number) => (
    <button onClick={() => setStatus(v)} className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition', status === v ? 'bg-raised text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
      {label}{n != null && <span className="ml-1.5 text-muted-foreground">{n}</span>}
    </button>
  )

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <Lightbulb className="w-6 h-6 text-primary mt-0.5 shrink-0" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">System Ideas</h1>
          <p className="text-sm text-muted-foreground mt-1">System-level improvement suggestions from the Upgrader — pipeline, metric, guardrail and data ideas that sit <em>above</em> individual prompt edits. Stored separately, reviewed here, exportable as Markdown or text.</p>
        </div>
      </div>

      {dbErr && (
        <Card className="p-4 border-warning/30 bg-warning/5">
          <div className="text-sm text-warning font-medium">Testing Lab database unavailable</div>
          <div className="text-xs text-muted-foreground mt-1">{dbErr}</div>
        </Card>
      )}

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 bg-surface border border-border rounded-lg p-1">
          {pill('all', 'All', counts.total)}
          {pill('open', 'Open', counts.open)}
          {pill('accepted', 'Accepted', counts.accepted)}
          {pill('dismissed', 'Dismissed', counts.dismissed)}
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 bg-surface border border-border rounded-lg px-2 text-sm text-foreground">
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => exportAs('md')}><FileDown className="w-4 h-4 mr-1.5" />Export .md</Button>
        <Button variant="outline" size="sm" onClick={() => exportAs('txt')}><FileText className="w-4 h-4 mr-1.5" />Export .txt</Button>
        <Button variant="ghost" size="sm" onClick={load} title="Refresh"><RotateCcw className="w-4 h-4" /></Button>
      </div>

      {/* list */}
      {rows === null ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Lightbulb className="w-8 h-8" />}
          title={counts.total === 0 ? 'No system suggestions yet' : 'Nothing matches these filters'}
          hint={counts.total === 0 ? 'Run the System Upgrader (Upgrader tab) on a run with captured agent data. Any non-prompt, system-level ideas it proposes will collect here.' : 'Try a different status or category.'}
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <Card key={r.id} className={cn('p-4', r.status === 'dismissed' && 'opacity-60')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="neutral">{r.category || 'other'}</Badge>
                    <Badge variant={SEV_VARIANT[r.severity] || 'neutral'}>{r.severity}</Badge>
                    <Badge variant={STATUS_VARIANT[r.status] || 'neutral'}>{r.status}</Badge>
                    <h3 className="text-sm font-semibold text-foreground">{r.title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">{r.detail}</p>
                  <div className="text-[11px] text-muted-foreground mt-2.5">
                    {r.source_run_no != null ? <>from run #{r.source_run_no}{r.source_label ? ` · ${r.source_label}` : ''}</> : 'unknown run'} · upgrade #{r.upgrade_run_id}
                    {r.upgrade_agent ? ` · ${r.upgrade_agent}` : ''} · {new Date(r.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {r.status !== 'accepted' && <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => setRowStatus(r.id, 'accepted')} title="Mark accepted"><Check className="w-4 h-4" /></Button>}
                  {r.status !== 'dismissed' && <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => setRowStatus(r.id, 'dismissed')} title="Dismiss"><X className="w-4 h-4" /></Button>}
                  {r.status !== 'open' && <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => setRowStatus(r.id, 'open')} title="Reopen"><RotateCcw className="w-4 h-4" /></Button>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
