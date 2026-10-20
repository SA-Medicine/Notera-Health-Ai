// Regression gate: runs a frozen set of transcripts through the CURRENT production pipeline and scores every note with the Style Spec v1
// conformance checks (no gold note involved). Use it before any release: if conformance drops, something changed the approved format.
'use strict';

import { conformance } from './conformance.js';

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

export async function defaultGenerate(transcript) {
  const { generateNote } = await import('../src/orchestrator/generateNote.js');
  const r = await generateNote({ transcript: transcript.slice(0, 120000), specialty: 'auto', noteType: 'consultation', clinicianId: 'studio-gate' }, { persist: false, mode: 'v2' });
  return r.renderedNote || '';
}

/** items: [{id, transcript}] -> { rows, summary } ; `generate(transcript)` is injectable for tests. */
export async function runGate({ items, concurrency = 2, generate = defaultGenerate, onProgress = () => {} }) {
  const rows = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const it = items[i++]; const t0 = Date.now();
      try { const note = await generate(it.transcript); const c = conformance(note); rows.push({ id: it.id, ok: true, ms: Date.now() - t0, score: c.score, failed: c.failed.map((f) => f.rule), words: note.split(/\s+/).length }); }
      catch (e) { rows.push({ id: it.id, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 160) }); }
      onProgress(rows.length, items.length);
    }
  }));
  const ok = rows.filter((r) => r.ok); const byRule = {};
  for (const r of ok) for (const f of new Set(r.failed)) byRule[f] = (byRule[f] || 0) + 1;
  const summary = { n: items.length, generated: ok.length, failed: rows.length - ok.length,
    mean_conformance: ok.length ? +(ok.reduce((s, r) => s + r.score, 0) / ok.length).toFixed(3) : null,
    notes_at_90: ok.length ? +(ok.filter((r) => r.score >= 0.9).length / ok.length).toFixed(3) : null,
    failures_by_rule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1])), p50_ms: pct(ok.map((r) => r.ms), 0.5), p95_ms: pct(ok.map((r) => r.ms), 0.95) };
  return { rows: rows.sort((a, b) => String(a.id).localeCompare(String(b.id))), summary };
}
