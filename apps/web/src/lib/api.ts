// Typed client for the unified backend admin/lab API (via the /backend proxy).
import { useEffect, useRef, useState } from 'react'

async function jget<T = any>(u: string): Promise<T> {
  const r = await fetch(u)
  if (r.status === 401) throw { unauth: true }
  return r.json()
}
async function jsend<T = any>(u: string, method: string, body?: any): Promise<T> {
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  if (r.status === 401 && u !== '/backend/api/login') throw { unauth: true }
  return r.json()
}
export const jpost = <T = any>(u: string, b?: any) => jsend<T>(u, 'POST', b)
export const jput = <T = any>(u: string, b?: any) => jsend<T>(u, 'PUT', b)

// ── types ─────────────────────────────────────────────────────
export interface RunRec { id: string; command: string; status: string; startedAt: string; finishedAt: string | null; resultDir: string | null }
export interface ResultRun { dir: string; id: string; summary: Record<string, number> | null }
export interface FixtureRow { file: string; fixture: string; passed: boolean | null; score: any }
export interface PromptMeta { id: string; agent: string; file: string; label: string; stage: string; description: string; kind: string; vars: string[]; active: boolean; order: number | null; freeform: boolean; maxOutputTokens: number | null; publishedVersion: number | null; hasDraft: boolean; updatedAt: string }
export interface PromptDetail extends PromptMeta { schema?: string; draft: any; published: { version: number; systemInstruction: string } | null; versions: { version: number; note: string; author: string; createdAt: string }[] }
export interface AgentLogRun { id: string; resultDir: string; status: string; command: string; fixtures: { fixture: string; lines: string[] }[] }
export interface Patient { id: number; slug: string; name: string; subtitle: string | null; heidi_session_id: string | null; source_url: string | null; transcript_len: number | null; gold_len: number | null; created_at: string; updated_at: string }
export interface ImportResult { ok: boolean; error?: string; hint?: string; note?: string; fixturesWritten?: boolean; added?: { name: string; slug: string }[]; updated?: { name: string; slug: string }[]; skipped?: { name: string; reason: string }[]; counts?: { added: number; updated: number; skipped: number } }
export interface LabRun { id: number; run_no: number; label: string; status: string; model: string | null; started_at: string; finished_at: string | null; patient_count: number }
export interface TrendPoint { run_no: number; label: string; metric_key: string; value: number }
export interface MetricRow { slug: string; name: string; metric_key: string; metric_value: number }
export interface AgentStat { agent_id: string; calls: number; errors: number; avg_latency_ms: number | null; avg_tokens_in: number | null; avg_tokens_out: number | null }
export interface HeatCell { slug: string; name: string; metric_key: string | null; metric_value: number | null; status: string | null; run_patient_id: number }
export interface AgentRunRow { id: number; agent_id: string; seq: number; status: string; latency_ms: number | null; tokens_in: number | null; tokens_out: number | null; attempt: number; rerun_of: number | null; created_at: string; output_parsed: any }
export interface RerunResult { ok: boolean; mode?: string; error?: string; hint?: string; agentRunId?: number; attempt?: number; output?: string; outputParsed?: any; metrics?: Record<string, number>; runId?: string; slug?: string }
export interface CompareDim { name: string; notera: number; gold: number; comment: string }
export interface Comparison { cached: boolean; ok?: boolean; error?: string; hint?: string; raw?: string; overall_score?: number; verdict?: string; dimensions?: CompareDim[]; notera_missing?: string[]; notera_extra?: string[]; key_differences?: string[]; summary?: string; generatedAt?: string }

export const api = {
  session: () => jget<{ authed: boolean }>('/backend/api/session'),
  login: (password: string) => jpost<{ ok?: boolean; error?: string }>('/backend/api/login', { password }),
  logout: () => jpost('/backend/api/logout'),
  scripts: () => jget<{ presets: { id: string; label: string; fixtures: string[] }[] }>('/backend/api/scripts'),
  runs: () => jget<RunRec[]>('/backend/api/runs'),
  startRun: (fixtures: string[]) => jpost<{ runId: string }>('/backend/api/runs', { fixtures }),
  killRun: (id: string) => jpost(`/backend/api/runs/${id}/kill`),
  resultRuns: () => jget<ResultRun[]>('/backend/api/results/runs'),
  files: (dir: string) => jget<FixtureRow[]>(`/backend/api/results/${dir}/files`),
  file: (dir: string, name: string) => jget<{ content: string }>(`/backend/api/results/file?dir=${dir}&name=${encodeURIComponent(name)}`),
  diff: (a: string, b: string, name: string) => jget<{ a: string; b: string }>(`/backend/api/results/diff?a=${a}&b=${b}&name=${encodeURIComponent(name)}`),
  compareGet: (dir: string, name: string) => jget<Comparison>(`/backend/api/results/compare?dir=${dir}&name=${encodeURIComponent(name)}`),
  compareRun: (dir: string, name: string) => jpost<Comparison>('/backend/api/results/compare', { dir, name }),
  deleteRun: (dir: string) => fetch('/backend/api/results/' + encodeURIComponent(dir), { method: 'DELETE' }),
  patients: () => jget<{ patients: Patient[]; error?: string; hint?: string }>('/backend/api/patients'),
  importPatients: (sessions: any) => jpost<ImportResult>('/backend/api/patients/import', sessions),
  deletePatient: (id: number) => jsend<{ ok: boolean; error?: string; deleted?: { id: number; slug: string; name: string }; fixtureRemoved?: boolean }>(`/backend/api/patients/${id}`, 'DELETE'),
  // ── Testing Lab dashboard ──
  labRuns: () => jget<{ runs: LabRun[]; error?: string; hint?: string }>('/backend/api/lab/runs'),
  labTrend: () => jget<{ points: TrendPoint[] }>('/backend/api/lab/trend'),
  labRunMetrics: (id: number) => jget<{ rows: MetricRow[] }>(`/backend/api/lab/run/${id}/metrics`),
  labAgents: (id: number) => jget<{ rows: AgentStat[] }>(`/backend/api/lab/run/${id}/agents`),
  labHeatmap: (id: number) => jget<{ rows: HeatCell[] }>(`/backend/api/lab/run/${id}/heatmap`),
  labPatientAgents: (runId: number, patientId: number) => jget<{ rows: AgentRunRow[] }>(`/backend/api/lab/run/${runId}/patient/${patientId}/agents`),
  labAgentRun: (id: number) => jget<{ agentRun: any }>(`/backend/api/lab/agent-run/${id}`),
  labCompare: (a: number, b: number) => jget<{ a: MetricRow[]; b: MetricRow[] }>(`/backend/api/lab/compare?a=${a}&b=${b}`),
  rerunAgent: (body: { runId?: number; patientId: number; agentId: string; mode: string; promptOverride?: string }) => jpost<RerunResult>('/backend/api/lab/rerun-agent', body),
  rerunLatest: (agentId: string, promptOverride?: string) => jpost<{ ok: boolean; error?: string; hint?: string; run?: { run_no: number }; done?: number; failed?: number; total?: number }>('/backend/api/lab/rerun-latest', { agentId, promptOverride }),
  history: () => jget<any[]>('/backend/api/metrics/history'),
  metricRun: (dir: string) => jget<{ summary: any; rows: any[] }>(`/backend/api/metrics/run/${dir}`),
  compare: (a: string, b: string) => jget<any>(`/backend/api/metrics/compare?a=${a}&b=${b}`),
  prompts: () => jget<{ readOnly: boolean; prompts: PromptMeta[] }>('/backend/api/prompts'),
  prompt: (id: string) => jget<PromptDetail>('/backend/api/prompts/' + id),
  promptVersion: (id: string, v: number) => jget<{ systemInstruction: string }>(`/backend/api/prompts/${id}/version/${v}`),
  promptLogs: (id: string) => jget<AgentLogRun[]>(`/backend/api/prompts/${id}/logs`),
  savePromptDraft: (id: string, systemInstruction: string, note: string) => jput(`/backend/api/prompts/${id}`, { systemInstruction, note }),
  publishPrompt: (id: string) => jpost(`/backend/api/prompts/${id}/publish`),
  revertPrompt: (id: string) => jpost(`/backend/api/prompts/${id}/revert`),
  promptConfig: (id: string, cfg: { freeform?: boolean; maxOutputTokens?: number | null; schema?: string }) => jpost(`/backend/api/prompts/${id}/config`, cfg),
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

// live run log stream (SSE)
export function useRunStream(runId: string | null) {
  const [lines, setLines] = useState<{ stream: string; line: string }[]>([])
  const [status, setStatus] = useState<string>('idle')
  const esRef = useRef<EventSource | null>(null)
  useEffect(() => {
    if (!runId) return
    setLines([]); setStatus('running')
    let sseAlive = false, stopped = false

    const es = new EventSource('/backend/api/runs/' + runId + '/stream'); esRef.current = es
    es.onmessage = (e) => {
      sseAlive = true
      const d = JSON.parse(e.data)
      if (d.type === 'line') setLines((L) => [...L, { stream: d.stream, line: stripAnsi(d.line) }])
      else if (d.type === 'status') { setStatus(d.status); if (d.status !== 'running') { stopped = true; es.close() } }
    }
    es.onerror = () => es.close()

    // Fallback: if a dev proxy buffers SSE, nothing would appear until the run ends.
    // The run record carries the full captured line buffer, so poll it until the SSE
    // proves alive (or for the whole run if it never does). Logs are always live.
    const poll = setInterval(async () => {
      if (sseAlive || stopped) return
      try {
        const r: any = await jget('/backend/api/runs/' + runId)
        if (Array.isArray(r?.lines)) setLines(r.lines.map((l: any) => ({ stream: l.stream, line: stripAnsi(l.line) })))
        if (r?.status) {
          setStatus(r.status)
          if (r.status !== 'running') { stopped = true; clearInterval(poll); es.close() }
        }
      } catch { /* keep trying */ }
    }, 1000)

    return () => { clearInterval(poll); es.close() }
  }, [runId])
  return { lines, status, setStatus }
}
