#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Dataset builder (doc 02 §4, §6, §7)
//
// Turns the gold Heidi pairs (data/gold/*.txt — transcript + gold note split at
// "Subjective:") into:
//   1. schema-structured records  { consult_id, transcript, gold_note_text, structured_note }
//   2. the supervised-tuning file (messages format, doc 02 §7) as .jsonl
//   3. a stratified train/val/test split (doc 02 §6) — frozen test set
//
// The structured_note is produced by the SAME heading parser the pipeline uses as
// its structured-output fallback, so the training target matches the runtime schema.
// PHI: gold files here are treated as already-consented sample data; a real run
// de-identifies (see backend/src/deid) before writing anything that leaves the box.
//
// Usage:  node data/build_dataset.mjs            # build from data/gold → data/out
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { structureNote } from '../backend/src/orchestrator/structureNote.js';
import { validateNote } from '../schema/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLD_DIR = path.join(__dirname, 'gold');
const OUT_DIR = path.join(__dirname, 'out');
const SPLIT = { train: 0.8, val: 0.1, test: 0.1 };

const SYSTEM = 'You are a clinical documentation assistant. Produce a note that strictly matches schema v1.0.0.';

function splitTranscriptAndGold(raw) {
  // Gold note begins at the first "Subjective:" line (doc convention).
  const idx = raw.search(/^\s*Subjective\s*:/im);
  if (idx === -1) return { transcript: raw.trim(), gold: '' };
  return { transcript: raw.slice(0, idx).trim(), gold: raw.slice(idx).trim() };
}

async function main() {
  if (!fs.existsSync(GOLD_DIR)) { console.error('No data/gold directory.'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(GOLD_DIR).filter((f) => f.endsWith('.txt')).sort();
  const records = [];
  let valid = 0;

  for (const f of files) {
    const raw = fs.readFileSync(path.join(GOLD_DIR, f), 'utf8');
    const { transcript, gold } = splitTranscriptAndGold(raw);
    if (!gold) { console.warn(`skip ${f}: no "Subjective:" marker`); continue; }

    // Structure the GOLD note into schema (heading parser — no API key needed).
    const structured = await structureNote(gold, { specialty: 'general_primary_care', noteType: 'consultation', llm: null, generatedBy: 'gold-v1' });
    const { valid: ok } = validateNote(structured);
    if (ok) valid += 1;

    records.push({
      consult_id: path.basename(f, '.txt'),
      source_file: f,
      transcript,
      gold_note_text: gold,
      structured_note: structured,
      schema_valid: ok,
    });
  }

  // Deterministic stratified-ish split (small set → simple index split, frozen).
  const shuffled = [...records];
  const nTest = Math.max(1, Math.round(records.length * SPLIT.test));
  const nVal = Math.max(1, Math.round(records.length * SPLIT.val));
  const test = shuffled.slice(0, nTest);
  const val = shuffled.slice(nTest, nTest + nVal);
  const train = shuffled.slice(nTest + nVal);

  // 1. full structured dataset
  fs.writeFileSync(path.join(OUT_DIR, 'dataset.json'), JSON.stringify(records, null, 2));

  // 2. supervised-tuning JSONL (messages format, doc 02 §7)
  const toMessages = (r) => ({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${r.structured_note.specialty} ${r.structured_note.note_type}\nTranscript:\n${r.transcript}` },
      { role: 'assistant', content: JSON.stringify(r.structured_note) },
    ],
  });
  for (const [name, rows] of [['train', train], ['val', val], ['test', test]]) {
    fs.writeFileSync(path.join(OUT_DIR, `${name}.jsonl`), rows.map((r) => JSON.stringify(toMessages(r))).join('\n') + '\n');
  }

  // 3. split manifest (frozen — never train on test)
  fs.writeFileSync(path.join(OUT_DIR, 'splits.json'), JSON.stringify({
    schema_version: '1.0.0', created_at: new Date().toISOString(),
    counts: { total: records.length, train: train.length, val: val.length, test: test.length },
    test_ids: test.map((r) => r.consult_id),
  }, null, 2));

  console.log(`Built dataset: ${records.length} pairs (${valid} schema-valid).`);
  console.log(`  train=${train.length} val=${val.length} test=${test.length}`);
  console.log(`  → ${path.relative(process.cwd(), OUT_DIR)}/{dataset.json, train|val|test.jsonl, splits.json}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
