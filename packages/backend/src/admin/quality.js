// Production quality, for the admin console's Quality page (owner, 2026-10-24: "measure production continuously ... make it easy for me").
// Every note the pipeline writes stores note.metadata.quality (fact ledger, medicines checked, time per stage). This reads the last N days of
// drafts and returns per-day numbers plus the latest notes that need a look, so one page answers "is it getting better or worse?".
//   GET /api/console/quality?days=14
'use strict';

import { query } from '../db/pool.js';

const num = (v) => (v == null || v === '' ? null : Number(v));

export function summarise(rows) {
  const days = new Map(); const recent = [];
  for (const r of rows) {
    const q = r.q || {}; const L = q.ledger || {}; const D = q.drugs || {}; const flags = Array.isArray(r.flags) ? r.flags : [];
    const toCheck = flags.filter((f) => f && (f.severity === 'warning' || f.severity === 'critical')).length;
    const seconds = q.timings?.total ? Math.round(q.timings.total / 1000) : null;
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    const d = days.get(day) || { day, notes: 0, seconds: [], toCheck: 0, drugIssues: 0, factsRequired: 0, factsAdded: 0, factsMissing: 0, withLedger: 0 };
    d.notes++; if (seconds != null) d.seconds.push(seconds); d.toCheck += toCheck; if ((D.unknown || 0) + (D.doseChecks || 0) > 0) d.drugIssues++;
    if (L.required) { d.withLedger++; d.factsRequired += L.required; d.factsAdded += (L.placed || 0) + (L.forced || 0); d.factsMissing += L.stillMissing || 0; }
    days.set(day, d);
    if (recent.length < 25) recent.push({ consultId: r.consult_id, title: r.title || r.specialty || 'Consult', clinician: r.clinician || '', at: r.created_at, seconds, toCheck, drugs: D, ledger: L.required ? { required: L.required, added: (L.placed || 0) + (L.forced || 0), missing: L.stillMissing || 0 } : null, mode: q.mode || 'older pipeline' });
  }
  const list = [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).map((d) => ({ day: d.day, notes: d.notes, avgSeconds: d.seconds.length ? Math.round(d.seconds.reduce((a, b) => a + b, 0) / d.seconds.length) : null, toCheckPerNote: +(d.toCheck / d.notes).toFixed(1), notesWithDrugIssues: d.drugIssues, factsRequired: d.factsRequired, factsAdded: d.factsAdded, factsMissing: d.factsMissing, notesWithLedger: d.withLedger }));
  const all = rows.length; const secs = rows.map((r) => num(r.q?.timings?.total)).filter((x) => x != null);
  return { days: list, recent, totals: { notes: all, avgSeconds: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length / 1000) : null, toCheckPerNote: all ? +(list.reduce((s, d) => s + d.toCheckPerNote * d.notes, 0) / all).toFixed(1) : null, notesWithDrugIssues: list.reduce((s, d) => s + d.notesWithDrugIssues, 0), factsMissing: list.reduce((s, d) => s + d.factsMissing, 0) } };
}

export function mountQuality(R, { r }) {
  R.get('/quality', r(async (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const rows = await query(`SELECT d.consult_id, d.created_at, d.flags, d.note->'metadata'->'quality' AS q, c.title, c.specialty, u.full_name AS clinician
      FROM clinical.drafts d JOIN clinical.consults c ON c.consult_id = d.consult_id LEFT JOIN auth.users u ON u.id::text = c.clinician_id
      WHERE d.created_at > now() - ($1 || ' days')::interval ORDER BY d.created_at DESC LIMIT 2000`, [String(days)]);
    res.json({ days, ...summarise(rows) });
  }));
}
