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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GOLD_DIR = path.join(ROOT, 'data', 'gold');
const OUT_DIR = path.join(__dirname, 'results');

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

const { generateNote } = await import(path.join(ROOT, 'backend', 'src', 'orchestrator', 'generateNote.js'));
const { scoreNote, aggregate } = await import(path.join(__dirname, 'metrics.mjs'));

function splitTranscriptAndGold(raw) {
  const idx = raw.search(/^\s*Subjective\s*:/im);
  return idx === -1 ? { transcript: raw.trim(), gold: '' } : { transcript: raw.slice(0, idx).trim(), gold: raw.slice(idx).trim() };
}

function noteToText(note) {
  const s = note.subjective || {}, pmh = note.past_medical_history || {}, o = note.objective || {};
  const ap = (note.assessment_and_plan || []).map((i) =>
    [i.issue, i.diagnosis, (i.differential_diagnoses || []).join(' '), i.investigations_planned, i.treatment_planned, i.referrals].filter(Boolean).join(' ')
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
  console.log(`Results → ${path.relative(process.cwd(), OUT_DIR)}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
