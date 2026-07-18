// ─────────────────────────────────────────────────────────────────────────────
// db/backfill_lab.mjs — seed the Testing Lab from existing files.
//
//   • data/gold/*.txt          → lab.patients   (transcript + gold note)
//   • eval/results/run_*/       → lab.runs + lab.run_patients + lab.metrics
//
// Idempotent: re-running updates in place. Safe to run any time.
//   node db/backfill_lab.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) { const v = m[2].replace(/^["']|["']$/g, '').replace(/[\r\n]+$/, '').trim();
        if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v; }
    }
  } catch {}
})();

const lab = await import(pathToFileURL(path.join(ROOT, 'packages', 'backend', 'src', 'db', 'labStore.js')).href);
const { closePool } = await import(pathToFileURL(path.join(ROOT, 'packages', 'backend', 'src', 'db', 'pool.js')).href);

const GOLD = path.join(ROOT, 'data', 'gold');
const RESULTS = path.join(ROOT, 'eval', 'results');

function splitTranscriptAndGold(raw) {
  const idx = raw.search(/^\s*Subjective\s*:/im);
  return idx === -1 ? { transcript: raw.trim(), gold: '' } : { transcript: raw.slice(0, idx).trim(), gold: raw.slice(idx).trim() };
}

const METRIC_KEYS = ['section_coverage', 'similarity_to_gold', 'story_flow', 'omission_rate'];

// 1. patients ------------------------------------------------------------------
const bySlug = {};   // slug → patientId
let np = 0;
if (fs.existsSync(GOLD)) {
  for (const f of fs.readdirSync(GOLD).filter((f) => f.endsWith('.txt')).sort()) {
    const base = path.basename(f, '.txt');
    const slug = lab.slugify(base, base.toLowerCase());
    const raw = fs.readFileSync(path.join(GOLD, f), 'utf8');
    const { transcript, gold } = splitTranscriptAndGold(raw);
    const p = await lab.upsertPatient({ slug, name: base, transcript_clean: transcript, transcript_raw: transcript, gold_note: gold });
    bySlug[slug] = p.id;
    np++;
  }
}
console.log(`• patients: ${np} from data/gold`);

// 2. runs + records + metrics --------------------------------------------------
let nr = 0, nrec = 0;
if (fs.existsSync(RESULTS)) {
  const dirs = fs.readdirSync(RESULTS).filter((d) => d.startsWith('run_') && fs.statSync(path.join(RESULTS, d)).isDirectory()).sort();
  for (const dir of dirs) {
    const summaryPath = path.join(RESULTS, dir, '_summary.json');
    if (!fs.existsSync(summaryPath)) continue;
    let payload; try { payload = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { continue; }
    const rows = payload.rows || [];
    const run = await lab.createRun({ label: dir, status: 'done', pipelineVersion: process.env.PIPELINE_VERSION });
    await lab.finishRun(run.id, 'done');
    for (const row of rows) {
      const slug = lab.slugify(row.id, String(row.id || '').toLowerCase());
      let patientId = bySlug[slug];
      if (!patientId) { const p = await lab.upsertPatient({ slug, name: row.id || slug }); patientId = p.id; bySlug[slug] = patientId; }
      // pull the generated note from <id>.json if present
      let generatedNote = null, renderedNote = null;
      try { const j = JSON.parse(fs.readFileSync(path.join(RESULTS, dir, `${row.id}.json`), 'utf8')); renderedNote = j.renderedNote || null; generatedNote = j.renderedNote || null; } catch {}
      const rpId = await lab.upsertRunPatient({
        runId: run.id, patientId, generatedNote, renderedNote,
        status: row.status || (row.error ? 'error' : null),
        schemaValid: row.schema_valid,
      });
      const metrics = {};
      for (const k of METRIC_KEYS) if (typeof row[k] === 'number') metrics[k] = row[k];
      if (typeof row.schema_valid === 'boolean') metrics.schema_valid = row.schema_valid ? 1 : 0;
      for (const [k, v] of Object.entries(row)) if (k.startsWith('qa_') && typeof v === 'number') metrics[k] = v;
      await lab.upsertMetrics({ runId: run.id, patientId, runPatientId: rpId, metrics });
      nrec++;
    }
    nr++;
  }
}
console.log(`• runs: ${nr}   records: ${nrec}`);

await closePool();
console.log('✅ backfill complete');
