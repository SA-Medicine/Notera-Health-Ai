// Typed client for the existing admin/server.mjs API. No endpoint changes.
import { useEffect, useRef, useState } from 'react'

async function jget<T = any>(u: string): Promise<T> {
  const r = await fetch(u)
  if (r.status === 401) throw { unauth: true }
  return r.json()
}
async function jsend<T = any>(u: string, method: string, body?: any): Promise<T> {
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  if (r.status === 401 && u !== '/api/login') throw { unauth: true }
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

export const api = {
  session: () => jget<{ authed: boolean }>('/api/session'),
  login: (password: string) => jpost<{ ok?: boolean; error?: string }>('/api/login', { password }),
  logout: () => jpost('/api/logout'),
  scripts: () => jget<{ presets: { id: string; label: string; fixtures: string[] }[] }>('/api/scripts'),
  runs: () => jget<RunRec[]>('/api/runs'),
  startRun: (fixtures: string[]) => jpost<{ runId: string }>('/api/runs', { fixtures }),
  killRun: (id: string) => jpost(`/api/runs/${id}/kill`),
  resultRuns: () => jget<ResultRun[]>('/api/results/runs'),
  files: (dir: string) => jget<FixtureRow[]>(`/api/results/${dir}/files`),
  file: (dir: string, name: string) => jget<{ content: string }>(`/api/results/file?dir=${dir}&name=${encodeURIComponent(name)}`),
  diff: (a: string, b: string, name: string) => jget<{ a: string; b: string }>(`/api/results/diff?a=${a}&b=${b}&name=${encodeURIComponent(name)}`),
  deleteRun: (dir: string) => fetch('/api/results/' + encodeURIComponent(dir), { method: 'DELETE' }),
  history: () => jget<any[]>('/api/metrics/history'),
  metricRun: (dir: string) => jget<{ summary: any; rows: any[] }>(`/api/metrics/run/${dir}`),
  compare: (a: string, b: string) => jget<any>(`/api/metrics/compare?a=${a}&b=${b}`),
  prompts: () => jget<{ readOnly: boolean; prompts: PromptMeta[] }>('/api/prompts'),
  prompt: (id: string) => jget<PromptDetail>('/api/prompts/' + id),
  promptVersion: (id: string, v: number) => jget<{ systemInstruction: string }>(`/api/prompts/${id}/version/${v}`),
  promptLogs: (id: string) => jget<AgentLogRun[]>(`/api/prompts/${id}/logs`),
  savePromptDraft: (id: string, systemInstruction: string, note: string) => jput(`/api/prompts/${id}`, { systemInstruction, note }),
  publishPrompt: (id: string) => jpost(`/api/prompts/${id}/publish`),
  revertPrompt: (id: string) => jpost(`/api/prompts/${id}/revert`),
  promptConfig: (id: string, cfg: { freeform?: boolean; maxOutputTokens?: number | null; schema?: string }) => jpost(`/api/prompts/${id}/config`, cfg),
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

// live run log stream (SSE)
export function useRunStream(runId: string | null) {
  const [lines, setLines] = useState<{ stream: string; line: string }[]>([])
  const [status, setStatus] = useState<string>('idle')
  const esRef = useRef<EventSource | null>(null)
  useEffect(() => {
    if (!runId) return
    setLines([])
    const es = new EventSource('/api/runs/' + runId + '/stream'); esRef.current = es
    es.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.type === 'line') setLines((L) => [...L, { stream: d.stream, line: stripAnsi(d.line) }])
      else if (d.type === 'status') { setStatus(d.status); if (d.status !== 'running') es.close() }
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [runId])
  return { lines, status, setStatus }
}
