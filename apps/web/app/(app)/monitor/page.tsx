'use client';

import { useCallback, useEffect, useState } from 'react';

const API = '/backend';

type Tab = 'errors' | 'runs' | 'accounts' | 'audio';
const RANGES = ['24h', '7d', '30d'] as const;

const fmtN = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0);
const fmt$ = (n: number) => '$' + (Number(n) || 0).toFixed(2);
const ago = (ts: string) => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};

export default function MonitorPage() {
  const [range, setRange] = useState<(typeof RANGES)[number]>('7d');
  const [tab, setTab] = useState<Tab>('errors');
  const [summary, setSummary] = useState<any>(null);
  const [data, setData] = useState<any>({});
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setDenied(false);
    try {
      const s = await fetch(`${API}/api/ops/summary?range=${range}`, { credentials: 'include' });
      if (s.status === 404 || s.status === 401) { setDenied(true); setLoading(false); return; }
      setSummary(await s.json());
      const r = await fetch(`${API}/api/ops/${tab}?range=${range}`, { credentials: 'include' });
      setData(await r.json());
    } catch { /* */ }
    setLoading(false);
  }, [range, tab]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);  // auto-refresh 30s

  if (denied) return (
    <div className="mon"><style>{CSS}</style>
      <div className="mon-denied">Admin access required. Sign in with an admin account to view the monitor.</div>
    </div>
  );

  const errRate = summary && Number(summary.runs) ? (Number(summary.errors) / Number(summary.runs) * 100) : 0;

  return (
    <div className="mon">
      <style>{CSS}</style>
      <div className="mon-head">
        <div><h1>Notera Monitor</h1><p>Pipeline health, per-account usage &amp; errors</p></div>
        <div className="mon-range">
          {RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}
          <button className="mon-refresh" onClick={load} title="Refresh">↻</button>
        </div>
      </div>

      <div className="mon-cards">
        <Card label="Notes generated" value={fmtN(Number(summary?.runs || 0))} />
        <Card label="Error rate" value={errRate.toFixed(1) + '%'} bad={errRate > 2} />
        <Card label="P50 / P95 time" value={summary ? `${Math.round((summary.p50 || 0) / 1000)}s / ${Math.round((summary.p95 || 0) / 1000)}s` : '—'} />
        <Card label="Tokens" value={fmtN(Number(summary?.tokens || 0))} />
        <Card label="Est. spend" value={fmt$(summary?.cost || 0)} />
        <Card label="Active accounts" value={String(summary?.accounts || 0)} />
        <Card label="Audio events" value={String(summary?.audio_events || 0)} />
      </div>

      <div className="mon-tabs">
        {(['errors', 'runs', 'accounts', 'audio'] as Tab[]).map((t) =>
          <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'accounts' ? 'Per-account' : t[0].toUpperCase() + t.slice(1)}
          </button>)}
      </div>

      <div className="mon-panel">
        {loading && !summary ? <div className="mon-empty">Loading…</div> : null}

        {tab === 'errors' && (
          <table><thead><tr><th>Time</th><th>Source</th><th>Code</th><th>Agent</th><th>Message</th><th>Account</th></tr></thead>
            <tbody>{(data.errors || []).map((e: any) => (
              <tr key={e.error_id}><td title={e.ts}>{ago(e.ts)}</td><td><span className={`pill s-${e.source}`}>{e.source}</span></td>
                <td className="mono">{e.code || '—'}</td><td>{e.agent || '—'}</td><td className="msg">{e.message}</td><td className="mono">{e.clinician_id || '—'}</td></tr>
            ))}{!(data.errors || []).length && <tr><td colSpan={6} className="mon-empty">No errors in this range 🎉</td></tr>}</tbody>
          </table>
        )}

        {tab === 'runs' && (
          <table><thead><tr><th>Time</th><th>Account</th><th>Model</th><th>Status</th><th>Duration</th><th>Tokens</th><th>Cost</th></tr></thead>
            <tbody>{(data.runs || []).map((r: any) => (
              <tr key={r.run_id}><td title={r.created_at}>{ago(r.created_at)}</td><td className="mono">{r.clinician_id || '—'}</td>
                <td className="mono">{r.model || '—'}</td><td><span className={`pill st-${r.status}`}>{r.status}</span></td>
                <td>{Math.round((r.duration_ms || 0) / 1000)}s</td><td>{fmtN(r.total_tokens)}</td><td>{fmt$(r.est_cost_usd)}</td></tr>
            ))}{!(data.runs || []).length && <tr><td colSpan={7} className="mon-empty">No runs in this range</td></tr>}</tbody>
          </table>
        )}

        {tab === 'accounts' && (
          <table><thead><tr><th>Account</th><th>Notes</th><th>Errors</th><th>Prompt</th><th>Output</th><th>Total tokens</th><th>Cost</th><th>Avg time</th><th>Last active</th></tr></thead>
            <tbody>{(data.accounts || []).map((a: any) => (
              <tr key={a.clinician_id}><td>{a.email}</td><td>{a.runs}</td><td className={Number(a.errors) ? 'bad' : ''}>{a.errors}</td>
                <td>{fmtN(a.prompt_tokens)}</td><td>{fmtN(a.output_tokens)}</td><td><b>{fmtN(a.total_tokens)}</b></td>
                <td><b>{fmt$(a.cost_usd)}</b></td><td>{Math.round((a.avg_ms || 0) / 1000)}s</td><td>{a.last_active ? ago(a.last_active) : '—'}</td></tr>
            ))}{!(data.accounts || []).length && <tr><td colSpan={9} className="mon-empty">No usage in this range</td></tr>}</tbody>
          </table>
        )}

        {tab === 'audio' && (
          <>
            <div className="mon-subrow">{(data.byReason || []).map((b: any) => <span key={b.reason} className="pill">{b.reason}: <b>{b.n}</b></span>)}</div>
            <table><thead><tr><th>Time</th><th>Reason</th><th>Account</th><th>Consult</th></tr></thead>
              <tbody>{(data.events || []).map((e: any, i: number) => (
                <tr key={i}><td title={e.ts}>{ago(e.ts)}</td><td><span className="pill">{e.reason}</span></td><td className="mono">{e.clinician_id || '—'}</td><td className="mono">{e.consult_id || '—'}</td></tr>
              ))}{!(data.events || []).length && <tr><td colSpan={4} className="mon-empty">No audio events in this range</td></tr>}</tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function Card({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return <div className="mon-card"><div className="mon-card-l">{label}</div><div className={`mon-card-v${bad ? ' bad' : ''}`}>{value}</div></div>;
}

const CSS = `
.mon{max-width:1280px;margin:0 auto;padding:26px 28px 80px;font-family:'Inter',-apple-system,sans-serif;color:#0f1836}
.mon-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:22px;flex-wrap:wrap;gap:14px}
.mon-head h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0}
.mon-head p{color:#5a6a82;font-size:14px;margin:4px 0 0}
.mon-range{display:flex;gap:6px}
.mon-range button{border:1px solid #e5eaf3;background:#fff;color:#5a6a82;font-weight:600;font-size:13px;padding:7px 13px;border-radius:9px;cursor:pointer}
.mon-range button.on{background:#6d5efc;color:#fff;border-color:#6d5efc}
.mon-refresh{font-size:15px}
.mon-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:22px}
.mon-card{background:#fff;border:1px solid #e5eaf3;border-radius:14px;padding:16px 18px;box-shadow:0 1px 2px rgba(16,32,64,.04)}
.mon-card-l{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#8a97ab;font-weight:700}
.mon-card-v{font-size:26px;font-weight:800;letter-spacing:-.02em;margin-top:6px}
.mon-card-v.bad{color:#e5484d}
.mon-tabs{display:flex;gap:6px;border-bottom:1px solid #e5eaf3;margin-bottom:2px}
.mon-tabs button{border:none;background:none;color:#5a6a82;font-weight:650;font-size:14px;padding:11px 16px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.mon-tabs button.on{color:#6d5efc;border-bottom-color:#6d5efc}
.mon-panel{background:#fff;border:1px solid #e5eaf3;border-top:none;border-radius:0 0 14px 14px;overflow:auto}
.mon table{width:100%;border-collapse:collapse;font-size:13.5px}
.mon th,.mon td{text-align:left;padding:11px 14px;border-bottom:1px solid #eef2f8;white-space:nowrap}
.mon th{background:#f7f9fc;color:#8a97ab;font-size:11px;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0}
.mon td.msg{white-space:normal;max-width:420px;color:#3a3f5c}
.mon td.mono,.mon .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#5a6a82}
.mon td.bad,.mon .bad{color:#e5484d;font-weight:700}
.mon-empty{padding:34px;text-align:center;color:#8a97ab}
.mon-subrow{display:flex;gap:8px;padding:12px 14px;flex-wrap:wrap;border-bottom:1px solid #eef2f8}
.pill{display:inline-block;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:100px;background:#eef2f8;color:#5a6a82}
.pill.s-pipeline{background:#efeaff;color:#5b45e0}.pill.s-asr{background:#e6f2ff;color:#1668c9}.pill.s-frontend{background:#fff2e0;color:#b9750f}
.pill.st-ok{background:#e7f6ee;color:#0f9d68}.pill.st-error{background:#fdecea;color:#c62d32}.pill.st-partial{background:#fff4e2;color:#b9750f}
.mon-denied{margin:80px auto;max-width:460px;text-align:center;color:#5a6a82;font-size:15px;background:#fff;border:1px solid #e5eaf3;border-radius:14px;padding:40px}
`;
