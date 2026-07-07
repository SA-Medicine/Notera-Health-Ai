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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GOLD_DIR = path.join(ROOT, 'data', 'gold');
const RUN_ID = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '').replace('T', '_');
const RESULTS_ROOT = path.join(__dirname, 'results');
const OUT_DIR = path.join(RESULTS_ROOT, `run_${RUN_ID}`);

// .env loader (no dependency)
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
})();

const { generateNote } = await import(pathToFileURL(path.join(ROOT, 'backend', 'src', 'orchestrator', 'generateNote.js')).href);
const { scoreNote, aggregate } = await import(pathToFileURL(path.join(__dirname, 'metrics.mjs')).href);

function splitTranscriptAndGold(raw) {
  const idx = raw.search(/^\s*Subjective\s*:/im);
  return idx === -1 ? { transcript: raw.trim(), gold: '' } : { transcript: raw.slice(0, idx).trim(), gold: raw.slice(idx).trim() };
}

function renderSchemaMarkdown(note) {
  const L = [];
  const s = note.subjective, pmh = note.past_medical_history, o = note.objective;
  const blk = (label, val) => { if (val && String(val).trim()) { L.push(`**${label}:**`); L.push(String(val)); L.push(''); } };
  L.push('**Subjective:**');
  blk('Presenting Complaints', s.reason_for_visit);
  blk('History of Presenting Complaint', [s.hpi_details, s.aggravating_relieving_factors, s.symptom_progression, s.previous_episodes, s.functional_impact].filter(Boolean).join('\n'));
  blk('Associated Symptoms', s.associated_symptoms);
  L.push('**Past Medical History:**');
  [pmh.medical_surgical, pmh.social && `Social history: ${pmh.social}`, pmh.family && `Family history: ${pmh.family}`, pmh.exposure, pmh.immunisation, pmh.other].filter(Boolean).forEach((x) => L.push(x));
  L.push('');
  L.push('**Objective:**');
  blk('Vital Signs', o.vital_signs);
  blk('Investigations', o.completed_investigations);
  blk('Exam Findings', o.examination);
  L.push('**Assessment & Plan:**');
  (note.assessment_and_plan || []).forEach((it, i) => {
    L.push(`${i + 1}. ${it.issue}`);
    if (it.diagnosis) L.push(`Diagnosis: ${it.diagnosis}`);
    if (it.assessment) L.push(it.assessment);
    if ((it.differential_diagnoses || []).length) L.push(`Differentials: ${it.differential_diagnoses.join(', ')}`);
    if (it.investigations_planned) L.push(`Investigations planned: ${it.investigations_planned}`);
    if (it.treatment_planned) L.push(`Treatment planned: ${it.treatment_planned}`);
    if (it.referrals) L.push(`Referrals: ${it.referrals}`);
    L.push('');
  });
  return L.join('\n');
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

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let files = fs.readdirSync(GOLD_DIR).filter((f) => f.endsWith('.txt')).sort();
  if (args.length) files = files.filter((f) => args.some((a) => f.toLowerCase().startsWith(a.toLowerCase())));
  files = files.slice(0, limit);

  const rows = [];
  for (const f of files) {
    const id = path.basename(f, '.txt');
    const raw = fs.readFileSync(path.join(GOLD_DIR, f), 'utf8');
    const { transcript, gold } = splitTranscriptAndGold(raw);
    process.stdout.write(`▶ ${id} … `);
    try {
      const result = await generateNote(
        { transcript, specialty: 'general_primary_care', noteType: 'consultation', clinicianId: 'eval' },
        { persist: false }
      );
      const noteText = noteToText(result.note);
      const score = scoreNote({ note: result.note, noteText, goldText: gold, entities: result.entities });
      score.id = id; score.status = result.status;
      rows.push(score);
      fs.writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify({ score, note: result.note, renderedNote: result.renderedNote, flags: result.flags }, null, 2));
      // Human/AI-readable side-by-side report for review.
      const md = [
        `# ${id}`,
        ``,
        `**Score:** schema_valid=${score.schema_valid} · section_coverage=${score.section_coverage} · similarity_to_gold=${score.similarity_to_gold} · omission_rate=${score.omission_rate} · unsupported_meds=${score.meds_unsupported.length} · status=${result.status}`,
        score.meds_unsupported.length ? `**Unsupported meds:** ${score.meds_unsupported.join(", ")}` : ``,
        ``,
        `## ── GENERATED NOTE (Notera, schema-structured = what is scored) ──`,
        ``,
        renderSchemaMarkdown(result.note),
        ``,
        `## ── RAW PIPELINE RENDER (embedded webapp view) ──`,
        ``,
        (result.renderedNote || "(no rendered note)"),
        ``,
        `## ── GOLD NOTE (Heidi) ──`,
        ``,
        gold,
      ].join("\n");
      fs.writeFileSync(path.join(OUT_DIR, `${id}.md`), md);
      console.log(`schema=${score.schema_valid} cov=${score.section_coverage} sim=${score.similarity_to_gold} unsupported_meds=${score.meds_unsupported.length}`);
    } catch (e) {
      console.log('FAILED —', e.message);
      rows.push({ id, error: e.message, schema_valid: false, section_coverage: 0, similarity_to_gold: 0, meds_unsupported: [] });
    }
  }

  const summary = aggregate(rows);
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify({ summary, rows }, null, 2));
  console.log('\n=== SCORECARD ===');
  console.table([summary]);
  // Append to a cross-run history file + write a latest pointer, so runs compare easily.
  const histLine = JSON.stringify({ runId: RUN_ID, at: new Date().toISOString(), ...summary });
  fs.appendFileSync(path.join(RESULTS_ROOT, '_history.jsonl'), histLine + '\n');
  fs.writeFileSync(path.join(RESULTS_ROOT, 'latest.txt'), `run_${RUN_ID}`);
  console.log(`Results  → ${path.relative(process.cwd(), OUT_DIR)}/`);
  console.log(`History  → eval/results/_history.jsonl  (one line per run — compare here)`);
  console.log(`Latest   → eval/results/latest.txt`);
}

main().catch((e) => { console.error(e); process.exit(1); });
