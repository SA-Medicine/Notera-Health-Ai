#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — End-to-end eval harness (doc 03 §6, ported from auto-tester)
//
// Runs the REAL ported pipeline over every gold transcript in ../data/gold, maps
// the output into schema v1.0.0, and scores it against the gold note with the
// metrics in ./metrics.mjs. Writes per-patient results + an aggregate scorecard.
//
// Makes live Gemini calls, so it needs GEMINI_API_KEY (read from ../.env or env).
// NER grounding is optional (NER_URL); without it the med cross-check is skipped.
//
// Usage:
//   node eval/run_eval.mjs                  # all gold transcripts
//   node eval/run_eval.mjs patient1 patient2
//   node eval/run_eval.mjs --limit 3
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dns from 'node:dns';
// Prefer IPv4: fresh node processes on networks with broken IPv6 otherwise hang at
// connect (ENOTFOUND / UND_ERR_CONNECT_TIMEOUT) even when the host is reachable.
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GOLD_DIR = path.join(ROOT, 'data', 'gold');
let RUN_ID = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '').replace('T', '_');
const RESULTS_ROOT = path.join(__dirname, 'results');
let OUT_DIR = path.join(RESULTS_ROOT, `run_${RUN_ID}`);

// .env loader (no dependency)
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      // Override undefined OR empty existing values, and hard-strip any stray CR so a
      // CRLF .env can never corrupt a key (…AIza…\r ⇒ invalid ⇒ 401 UNAUTHENTICATED).
      if (m) {
        const v = m[2].replace(/^["']|["']$/g, '').replace(/[\r\n]+$/, '').trim();
        if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
      }
    }
  } catch { /* no .env */ }
})();

// The eval corpus (data/gold) is de-identified with synthetic ISO-date placeholders — neutralize
// them by default HERE (this is a separate process from the production backend, so the clinician
// path keeps real dates). Override with NORMALIZE_DEID_DATES=0.
if (process.env.NORMALIZE_DEID_DATES === undefined) process.env.NORMALIZE_DEID_DATES = '1';

const { generateNote } = await import(pathToFileURL(path.join(ROOT, 'packages', 'backend', 'src', 'orchestrator', 'generateNote.js')).href);
const { scoreNote, aggregate } = await import(pathToFileURL(path.join(__dirname, 'metrics.mjs')).href);
// Single source of truth for note structure — the "Notera — generated" pane renders this.
const { noteToMarkdown } = await import(pathToFileURL(path.join(ROOT, 'packages', 'backend', 'src', 'orchestrator', 'renderMarkdown.js')).href);

// Optional: mirror every run into the Testing Lab DB (best-effort; a broken DB
// never blocks a run — file results are still written).
let lab = null, labRun = null;
if (process.env.STORE_BACKEND === 'postgres' && process.env.DATABASE_URL) {
  try { lab = await import(pathToFileURL(path.join(ROOT, 'packages', 'backend', 'src', 'db', 'labStore.js')).href); }
  catch (e) { console.warn('[lab] disabled (labStore import failed):', e.message); }
}
const tryParseJSON = (s) => { try { return JSON.parse(String(s || '').replace(/```json/gi, '').replace(/```/g, '').trim()); } catch { return null; } };

function splitTranscriptAndGold(raw) {
  const idx = raw.search(/^\s*Subjective\s*:/im);
  return idx === -1 ? { transcript: raw.trim(), gold: '' } : { transcript: raw.slice(0, idx).trim(), gold: raw.slice(idx).trim() };
}

// The generated pane renders the SAME structure as the product pipeline. Delegate to the
// single renderer (renderMarkdown.js → noteToMarkdown) so structure lives in ONE place:
// merged Subjective narrative + Associated Symptoms sub-block, terse dissolved Objective,
// numbered Assessment & Plan. Keeps the two renderers from drifting.
function renderSchemaMarkdown(note) {
  return noteToMarkdown(note);
}

function noteToText(note) {
  const s = note.subjective || {}, pmh = note.past_medical_history || {}, o = note.objective || {};
  const ap = (note.assessment_and_plan || []).map((i) =>
    [i.issue, i.diagnosis, i.assessment, (i.differential_diagnoses || []).join(' '), i.investigations_planned, i.treatment_planned, i.referrals].filter(Boolean).join(' ')
  ).join('\n');
  return [
    ...Object.values(s), ...Object.values(pmh), ...Object.values(o), ap,
  ].filter(Boolean).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  const li = args.indexOf('--limit');
  if (li !== -1) { limit = Number(args[li + 1]); args.splice(li, 2); }

  // --resume <run_dir>: continue an interrupted scan IN PLACE — reuse its output dir,
  // seed the already-completed rows, and skip the fixtures it already finished.
  let resumeRows = [];
  const rsi = args.indexOf('--resume');
  if (rsi !== -1) {
    const rdir = args[rsi + 1]; args.splice(rsi, 2);
    if (rdir && /^run_[\w-]+$/.test(rdir)) {
      OUT_DIR = path.join(RESULTS_ROOT, rdir); RUN_ID = rdir.replace(/^run_/, '');
      try { resumeRows = JSON.parse(fs.readFileSync(path.join(OUT_DIR, '_summary.json'), 'utf8')).rows || []; } catch {}
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Persist the full run stdout/stderr into the result dir so the admin dashboard
  // (Prompts → Logs) can show per-agent output for THIS run — works whether the
  // run is launched from the CLI or the dashboard.
  const _pipeLog = fs.createWriteStream(path.join(OUT_DIR, '_pipeline.log'), { flags: 'a' });
  for (const s of ['stdout', 'stderr']) {
    const orig = process[s].write.bind(process[s]);
    process[s].write = (chunk, ...rest) => { try { _pipeLog.write(typeof chunk === 'string' ? chunk : chunk.toString()); } catch {} return orig(chunk, ...rest); };
  }

  let files = fs.readdirSync(GOLD_DIR).filter((f) => f.endsWith('.txt')).sort();
  // Exact (case-insensitive) basename match — NOT startsWith, else "patient1" also
  // matches "patient10". Args are gold basenames like "Patient2", "done_Patient3".
  if (args.length) files = files.filter((f) => args.some((a) => path.basename(f, '.txt').toLowerCase() === a.toLowerCase()));
  files = files.slice(0, limit);
  const doneCount = resumeRows.length;
  if (doneCount) { const done = new Set(resumeRows.map((r) => String(r.id))); files = files.filter((f) => !done.has(path.basename(f, '.txt'))); console.log(`[resume] ${doneCount} already done, ${files.length} remaining in ${path.basename(OUT_DIR)}`); }

  if (lab) {
    try { labRun = await lab.createRun({ label: `run_${RUN_ID}`, status: 'running', pipelineVersion: process.env.PIPELINE_VERSION, model: process.env.GEMINI_MODEL }); }
    catch (e) { console.warn('[lab] createRun failed — DB mirror off:', e.message); lab = null; }
  }
  if (lab && labRun) console.log(`[lab] DB mirroring ON → run #${labRun.run_no} (id ${labRun.id}). Agent I/O will be captured for the System Upgrader.`);
  else console.warn(`[lab] DB mirroring OFF — STORE_BACKEND=${process.env.STORE_BACKEND || '(unset)'}, DATABASE_URL ${process.env.DATABASE_URL ? 'set' : '(unset)'}. Runs won't be usable by the System Upgrader.`);

  // Never let a broken stdout pipe (e.g. the dashboard/backend restarted while this
  // detached run keeps going) crash the scan. The run writes its own _pipeline.log too.
  process.stdout.on('error', () => {}); process.stderr.on('error', () => {});

  const rows = [...resumeRows];                 // seed prior results when resuming
  const total = files.length + resumeRows.length;
  const FIXTURE_TIMEOUT_MS = Number(process.env.RUN_FIXTURE_TIMEOUT_MS) || 300000;   // hard cap per patient
  const CONCURRENCY = Math.max(1, Number(process.env.RUN_CONCURRENCY) || 1);          // 1 = sequential (default, clean logs)
  // Persist partial results + progress after EVERY fixture so a large scan (150+) that is
  // interrupted midway keeps everything done so far, and the UI can show live progress.
  const flush = (current, phase = 'running') => {
    try { fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify({ summary: aggregate(rows), rows }, null, 2)); } catch {}
    try { fs.writeFileSync(path.join(OUT_DIR, '_progress.json'), JSON.stringify({ runId: RUN_ID, total, done: rows.length, current, phase, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2)); } catch {}
  };
  const processOne = async (f) => {
    const id = path.basename(f, '.txt');
    const raw = fs.readFileSync(path.join(GOLD_DIR, f), 'utf8');
    const { transcript, gold } = splitTranscriptAndGold(raw);
    process.stdout.write(`▶ ${id} … `);
    try {
      // Hard per-patient timeout so one stuck record can never freeze the whole scan.
      const result = await Promise.race([
        generateNote(
          { transcript, specialty: 'general_primary_care', noteType: 'consultation', clinicianId: 'eval', referenceNote: gold },
          { persist: false, recordTrace: !!lab }
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`fixture timeout > ${FIXTURE_TIMEOUT_MS}ms`)), FIXTURE_TIMEOUT_MS)),
      ]);
      const noteText = noteToText(result.note);
      const score = scoreNote({ note: result.note, noteText, goldText: gold, entities: result.entities });
      score.id = id; score.status = result.status;
      // merge QA-agent numeric metrics (qa_<name>) so aggregate() can trend them
      if (result.qa && result.qa._metrics) { for (const [k, v] of Object.entries(result.qa._metrics)) { if (typeof v === 'number' && isFinite(v)) score['qa_' + k] = v; } }
      rows.push(score);
      fs.writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify({ score, note: result.note, renderedNote: result.renderedNote, flags: result.flags }, null, 2));
      // Human/AI-readable side-by-side report for review.
      const md = [
        `# ${id}`,
        ``,
        `**Score:** schema_valid=${score.schema_valid} · section_coverage=${score.section_coverage} · similarity_to_gold=${score.similarity_to_gold} · omission_rate=${score.omission_rate} · story_flow=${score.story_flow} · unsupported_meds=${score.meds_unsupported.length} · status=${result.status}`,
        score.meds_unsupported.length ? `**Unsupported meds:** ${score.meds_unsupported.join(", ")}` : ``,
        score.omission_missed?.length ? `**Top missed gold terms:** ${score.omission_missed.join(", ")}` : ``,
        ``,
        `## ── GENERATED NOTE (Notera, schema-structured = what is scored) ──`,
        ``,
        renderSchemaMarkdown(result.note),
        ``,
        `## ── RAW PIPELINE RENDER (embedded webapp view) ──`,
        ``,
        (result.renderedNote || "(no rendered note)"),
        ``,
        `## ── GOLD NOTE ──`,
        ``,
        gold,
      ].join("\n");
      fs.writeFileSync(path.join(OUT_DIR, `${id}.md`), md);
      console.log(`schema=${score.schema_valid} cov=${score.section_coverage} sim=${score.similarity_to_gold} flow=${score.story_flow} unsupported_meds=${score.meds_unsupported.length}`);

      // ── mirror into Testing Lab DB (patient + record + agent I/O + metrics) ──
      if (lab && labRun) {
        try {
          const pat = await lab.upsertPatient({ slug: lab.slugify(id, id.toLowerCase()), name: id, transcript_clean: transcript, transcript_raw: transcript, gold_note: gold });
          const rpId = await lab.upsertRunPatient({ runId: labRun.id, patientId: pat.id, generatedNote: noteText, renderedNote: result.renderedNote, status: result.status, schemaValid: score.schema_valid });
          const trace = result.trace || [];
          for (let i = 0; i < trace.length; i++) {
            const tr = trace[i];
            await lab.insertAgentRun({
              runId: labRun.id, patientId: pat.id, runPatientId: rpId, agentId: tr.agent, seq: tr.seq ?? i,
              systemPrompt: tr.systemInstruction, input: { userPrompt: tr.userPrompt, responseSchema: tr.responseSchema || null },
              outputRaw: tr.output, outputParsed: tryParseJSON(tr.output), status: tr.status, errorMessage: tr.error,
              latencyMs: tr.latency_ms, model: tr.model,
            });
          }
          // Observability: the System Upgrader needs these agent runs. Make the count
          // visible in the Run-tab logs so it's obvious whether capture worked.
          if (trace.length) console.log(`[lab] ${id}: stored ${trace.length} agent runs (${[...new Set(trace.map((t) => t.agent))].join(', ')})`);
          else console.warn(`[lab] ${id}: 0 agent runs captured — the System Upgrader will have no data for this run.`);
          const metrics = {};
          for (const k of ['section_coverage', 'similarity_to_gold', 'story_flow', 'omission_rate']) if (typeof score[k] === 'number') metrics[k] = score[k];
          if (typeof score.schema_valid === 'boolean') metrics.schema_valid = score.schema_valid ? 1 : 0;
          for (const [k, v] of Object.entries(score)) if (k.startsWith('qa_') && typeof v === 'number') metrics[k] = v;
          await lab.upsertMetrics({ runId: labRun.id, patientId: pat.id, runPatientId: rpId, metrics });
        } catch (e) { console.warn('[lab] persist failed for', id, '—', e.message); }
      }
    } catch (e) {
      console.log('FAILED —', e.message);
      rows.push({ id, error: e.message, schema_valid: false, section_coverage: 0, similarity_to_gold: 0, meds_unsupported: [] });
    }
    flush(id);                            // checkpoint after every patient (success or fail)
    console.log(`[progress] ${rows.length}/${total} done`);
  };
  // Worker pool. Default CONCURRENCY=1 keeps per-fixture logs clean (agent-log attribution);
  // set RUN_CONCURRENCY>1 for faster large scans at the cost of interleaved logs.
  let _i = 0;
  const _worker = async () => { while (_i < files.length) { await processOne(files[_i++]); } };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => _worker()));

  const summary = aggregate(rows);
  flush(null, 'done');
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify({ summary, rows }, null, 2));
  console.log('\n=== SCORECARD ===');
  console.table([summary]);
  // Append to a cross-run history file + write a latest pointer, so runs compare easily.
  const histLine = JSON.stringify({ runId: RUN_ID, at: new Date().toISOString(), ...summary });
  fs.appendFileSync(path.join(RESULTS_ROOT, '_history.jsonl'), histLine + '\n');
  fs.writeFileSync(path.join(RESULTS_ROOT, 'latest.txt'), `run_${RUN_ID}`);
  if (lab && labRun) {
    try { await lab.finishRun(labRun.id, 'done'); const { closePool } = await import(pathToFileURL(path.join(ROOT, 'packages', 'backend', 'src', 'db', 'pool.js')).href); await closePool(); }
    catch (e) { console.warn('[lab] finishRun failed:', e.message); }
  }
  console.log(`Results  → ${path.relative(process.cwd(), OUT_DIR)}/`);
  console.log(`History  → eval/results/_history.jsonl  (one line per run — compare here)`);
  console.log(`Latest   → eval/results/latest.txt`);
}

main().catch((e) => { console.error(e); process.exit(1); });
