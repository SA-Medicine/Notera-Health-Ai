'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '../components/Protected';

type Row = { consultId: string; specialty: string; noteType: string; status: string; createdAt: string };

export default function ConsultsPage() {
  return (
    <Protected>
      <History />
    </Protected>
  );
}

function History() {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'offline'>('loading');

  useEffect(() => {
    fetch('/api/consults?limit=50')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => { setRows(b.consults || []); setState('ok'); })
      .catch(() => setState('offline'));
  }, []);

  return (
    <div className="container">
      <div className="pageintro">
        <h1>History</h1>
        <p className="sub">Past consults and their status. Approved notes + transcripts become new gold pairs — the flywheel.</p>
      </div>
      <div className="card">
        {state === 'loading' && <p className="muted"><span className="spinner" style={{ borderColor: 'rgba(31,111,235,.3)', borderTopColor: 'var(--brand)' }} /> Loading…</p>}
        {state === 'offline' && <p className="muted">Backend unreachable — start the backend service to see consults.</p>}
        {state === 'ok' && rows.length === 0 && <p className="muted">No consults yet. <Link href="/app">Create one →</Link></p>}
        {state === 'ok' && rows.length > 0 && (
          <table className="list">
            <thead><tr><th>Consult</th><th>Specialty</th><th>Type</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.consultId}>
                  <td><code>{c.consultId}</code></td>
                  <td>{c.specialty?.replace(/_/g, ' ')}</td>
                  <td>{c.noteType?.replace(/_/g, ' ')}</td>
                  <td><span className={`status ${c.status === 'signed' ? 'PASS' : 'FLAGGED'}`}>{c.status}</span></td>
                  <td className="muted">{new Date(c.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
