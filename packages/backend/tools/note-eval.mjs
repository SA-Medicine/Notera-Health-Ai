#!/usr/bin/env node
// Re-writes the notes of one clinician's real consults with the CURRENT pipeline (nothing is saved), measures each note with code, audits each with the
// same auditor the Super run uses, and prints the means. Run it before and after a pipeline change and compare the two files it writes.
//   docker exec -w /app/packages/backend notera-lab node tools/note-eval.mjs <clinician-uuid> <label> [limit] [concurrency]
// Output: /lab-data/note-eval/<label>.json (per consult) and a summary on screen. Costs about $0.05 and 60 s per consult; audio is never touched.
import fs from 'node:fs';
import { query } from '../src/db/pool.js';
import { generateNote } from '../src/orchestrator/generateNote.js';

const [uid, label = 'run', limitArg = '0', concArg = '4'] = process.argv.slice(2);
if (!uid) { console.error('usage: note-eval.mjs <clinician-uuid> <label> [limit] [concurrency]'); process.exit(2); }
const OUT = '/lab-data/note-eval'; fs.mkdirSync(OUT, { recursive: true });
const LAB = process.env.LAB_URL || 'http://127.0.0.1:8080'; const KEY = process.env.LAB_KEY || '';

/** What code can say about a note without a model. */
export function noteMetrics(md, { meds = [] } = {}) {
  const sec = (name) => { const m = md.match(new RegExp(`### ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n### |$)`)); return m ? m[1].trim() : null; };
  const obj = sec('Objective'); const ap = sec('Assessment & Plan') || '';
  const objLines = obj ? obj.split('\n').filter((l) => /^\s*[-*]/.test(l)) : [];
  const deferred = !!obj && /deferred/i.test(obj);
  const probs = ap.split(/\n(?=\d+\.\s)/).filter((p) => /^\d+\.\s/.test(p)).map((p) => ({ title: (p.match(/\*\*(.+?)\*\*/) || [, ''])[1], lines: p.split('\n').slice(1).filter((l) => /^\s+-/.test(l)), text: p }));
  const planText = ap.toLowerCase();
  const named = meds.filter((m) => planText.includes(String(m).toLowerCase().split(' ')[0]));
  return {
    hasObjective: obj != null, objectiveLines: deferred ? 0 : objLines.length, objectiveDeferred: deferred,
    problems: probs.length, bareProblems: probs.filter((p) => !p.lines.length).length,
    problemsWithTreatment: probs.filter((p) => /Treatment planned|Started|Continue|Stopped/i.test(p.text)).length,
    treatmentSubPoints: (ap.match(/^\s{5,}-\s/gm) || []).length,
    planMedsExpected: meds.length, planMedsNamed: named.length,
    noteWords: md.split(/\s+/).length,
  };
}

const rows = await query(`select consult_id, title, transcript->>'text' as tx from clinical.consults where clinician_id = $1 and length(coalesce(transcript->>'text','')) > 0 order by created_at`, [uid]);
const list = Number(limitArg) > 0 ? rows.slice(0, Number(limitArg)) : rows; const results = []; let next = 0;
const worker = async () => {
  while (next < list.length) {
    const c = list[next++]; const t0 = Date.now(); const trace = {}; const logs = [];
    try {
      const r = await generateNote({ transcript: c.tx.slice(0, 120000), specialty: 'auto', noteType: 'consultation', clinicianId: 'note-eval' }, { persist: false, mode: 'v2', trace, onLog: (m) => { const s = String(m); if (/dropped|removed|rejected|cleared|✂|folded|moved|replaced|unsupported|unheard/i.test(s) && !/tokens\]|Timing/.test(s)) logs.push(s.slice(0, 400)); } });
      const md = r.renderedNote || ''; const seconds = Math.round((Date.now() - t0) / 1000);
      const meds = (trace.checklist?.medications || []).filter((m) => ['new', 'changed', 'stopped'].includes(m.status)).map((m) => m.name).filter(Boolean);
      let audit = null;
      try { const a = await fetch(`${LAB}/audit-adhoc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Key': KEY }, body: JSON.stringify({ transcript: c.tx.slice(0, 100000), note: md }) }); audit = await a.json(); } catch (e) { audit = { error: String(e.message) }; }
      results.push({ id: c.consult_id, title: c.title, words: c.tx.split(/\s+/).length, seconds, metrics: noteMetrics(md, { meds }), audit, note: md, timings: trace.timings, removals: logs });
    } catch (e) { results.push({ id: c.consult_id, error: String(e.message).slice(0, 200) }); }
    process.stderr.write(`\r${results.length}/${list.length}`);
  }
};
await Promise.all(Array.from({ length: Math.max(1, Number(concArg) || 4) }, worker));
fs.writeFileSync(`${OUT}/${label}.json`, JSON.stringify(results));
const ok = results.filter((x) => x.metrics); const A = ok.filter((x) => typeof x.audit?.score === 'number');
const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null); const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '-');
console.log(`\n${label}: ${ok.length} notes (${results.length - ok.length} failed), ${A.length} audited`);
console.log('audit score', mean(A.map((x) => x.audit.score)), '| wrong', mean(A.map((x) => (x.audit.wrong || []).length)), '| missing', mean(A.map((x) => (x.audit.missing || []).length)), '| extra', mean(A.map((x) => (x.audit.extra || []).length)), '| plan gaps', mean(A.map((x) => (x.audit.ap_gaps || []).length)));
console.log('presentation flow/readability/organisation', mean(A.map((x) => x.audit.presentation?.flow).filter(Number.isFinite)), mean(A.map((x) => x.audit.presentation?.readability).filter(Number.isFinite)), mean(A.map((x) => x.audit.presentation?.organization).filter(Number.isFinite)));
console.log('objective present', pct(ok.filter((x) => x.metrics.hasObjective).length, ok.length), '| objective deferred', pct(ok.filter((x) => x.metrics.objectiveDeferred).length, ok.length), '| bare problems', ok.reduce((s, x) => s + x.metrics.bareProblems, 0), '| plan drugs named', pct(ok.reduce((s, x) => s + x.metrics.planMedsNamed, 0), ok.reduce((s, x) => s + x.metrics.planMedsExpected, 0)), '| treatment sub-points per note', mean(ok.map((x) => x.metrics.treatmentSubPoints)));
// where does data go? a fact the audit calls missing is matched to a line a guard took out (quoted text in the guard's log)
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length > 3));
const byStage = {}; let missTotal = 0; let missLost = 0; let removalLines = 0;
for (const x of A) { for (const l of x.removals || []) { const tag = (l.match(/^\[([^\]]+)\]/) || [, 'other'])[1]; byStage[tag] = (byStage[tag] || 0) + 1; removalLines++; }
  for (const m of x.audit.missing || []) { missTotal++; const mw = words(m.fact); const hit = (x.removals || []).find((l) => { const q = (l.match(/"([^"]{8,})"/) || [, ''])[1]; const qw = words(q); if (!qw.size || !mw.size) return false; let n = 0; for (const w of mw) if (qw.has(w)) n++; return n / Math.min(mw.size, qw.size) >= 0.5; }); if (hit) { missLost++; const tag = (hit.match(/^\[([^\]]+)\]/) || [, 'other'])[1]; byStage['LOST:' + tag] = (byStage['LOST:' + tag] || 0) + 1; } } }
console.log('guard removals per note', mean([removalLines / Math.max(1, A.length)]), '| audit-missing facts that a guard had removed', missLost + '/' + missTotal, JSON.stringify(byStage));
console.log('seconds per note mean', mean(ok.map((x) => x.seconds)), 'max', Math.max(...ok.map((x) => x.seconds)));
process.exit(0);
