// Runs the note pipeline on stored transcripts, on this computer, nothing saved. Usage (from packages/backend):
//   node --env-file=../../.env tools/audit/localrun.mjs transcripts.json out.json [idSuffix,idSuffix]
// transcripts.json: [{ consult_id, text }]. Switch the layout with env: STORY_STYLE=flat REPEAT_TRIM=1 NOTE_FORMAT=template
import fs from 'node:fs';
import { generateNote } from '../../src/orchestrator/generateNote.js';

const [inFile, outFile, ids = ''] = process.argv.slice(2); const want = ids.split(',').filter(Boolean);
const items = JSON.parse(fs.readFileSync(inFile, 'utf8')).filter((x) => !want.length || want.some((w) => x.consult_id.endsWith(w)));
const results = [];
for (const it of items) {
  const t0 = Date.now(); const trace = {}; const logs = [];
  try {
    const r = await generateNote({ transcript: it.text, specialty: 'auto', noteType: 'consultation', clinicianId: 'local-template-test' }, { persist: false, mode: 'v2', trace, log: (m) => logs.push(String(m)) });
    results.push({ consult_id: it.consult_id, seconds: Math.round((Date.now() - t0) / 1000), note: r.renderedNote, flags: (r.flags || []).length, logs: logs.filter((l) => /repeatTrim|template|story/i.test(l)).slice(0, 12) });
  } catch (e) { results.push({ consult_id: it.consult_id, error: String(e.message).slice(0, 300) }); }
  console.error(`${results.length}/${items.length} ${it.consult_id} ${results.at(-1).error || results.at(-1).seconds + ' s'}`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
}
process.exit(0);
