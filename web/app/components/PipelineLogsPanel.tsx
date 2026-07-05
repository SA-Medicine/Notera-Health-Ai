'use client';

import { useState } from 'react';
import type { PipelineLogs } from './types';

// Developer panel — full pipeline logs (per-agent passes, timings, coverage, QA).
// Mirrors the old auto-tester logs so you can tune SOAP quality in phase one.
export default function PipelineLogsPanel({ logs, consultId }: { logs?: PipelineLogs; consultId: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'console' | 'timings' | 'stages'>('console');
  if (!logs) return null;

  const text = (logs.textLogs || []).join('\n\n');
  const timings = Object.entries(logs.timings || {});
  const total = timings.reduce((s, [, ms]) => s + (Number(ms) || 0), 0);
  const fmt = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  function copy() { navigator.clipboard?.writeText(text); }
  function download() {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${consultId}_pipeline_logs.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const s = logs.stages || ({} as PipelineLogs['stages']);

  return (
    <div className="card logs-panel">
      <button className="logs-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="logs-toggle-l"><span className="dev-dot" /> Developer · pipeline logs</span>
        <span className="muted" style={{ fontSize: 13 }}>{open ? 'hide ▲' : 'show ▼'} · {logs.textLogs?.length || 0} entries · {fmt(total)}</span>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          {/* Stage summary chips */}
          <div className="stage-grid">
            <div className="stage"><span>Encounter</span><b>{s.encounterType || '—'}</b></div>
            <div className="stage"><span>Entities</span><b>{s.entityCount ?? '—'}</b></div>
            <div className="stage"><span>Problems</span><b>{s.activeProblems ?? '—'}</b></div>
            <div className="stage"><span>Coverage</span><b>{s.storyCoverage != null ? `${s.storyCoverage}%` : '—'}</b></div>
            <div className="stage"><span>JS validate</span><b className={s.jsValidation === 'PASS' ? 'ok' : 'warn'}>{s.jsValidation || '—'}</b></div>
            <div className="stage"><span>LLM QA</span><b>{s.qaValidation || 'skipped'}</b></div>
          </div>

          <div className="logs-tabs">
            <button className={tab === 'console' ? 'on' : ''} onClick={() => setTab('console')}>Console</button>
            <button className={tab === 'timings' ? 'on' : ''} onClick={() => setTab('timings')}>Timings</button>
            <button className={tab === 'stages' ? 'on' : ''} onClick={() => setTab('stages')}>Raw stages</button>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn ghost sm" onClick={copy}>Copy</button>
              <button className="btn ghost sm" onClick={download}>Download .txt</button>
            </span>
          </div>

          {tab === 'console' && <pre className="logs-pre">{text || 'No logs captured.'}</pre>}

          {tab === 'timings' && (
            <table className="list logs-timings">
              <thead><tr><th>Agent / stage</th><th style={{ textAlign: 'right' }}>Duration</th></tr></thead>
              <tbody>
                {timings.length === 0 && <tr><td colSpan={2} className="muted">No timings.</td></tr>}
                {timings.map(([k, ms]) => (
                  <tr key={k}><td>{k}</td><td style={{ textAlign: 'right' }}>{fmt(Number(ms))}</td></tr>
                ))}
                {timings.length > 0 && <tr><td><b>Total</b></td><td style={{ textAlign: 'right' }}><b>{fmt(total)}</b></td></tr>}
              </tbody>
            </table>
          )}

          {tab === 'stages' && <pre className="logs-pre">{JSON.stringify(s, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}
