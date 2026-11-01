// Offline check of the template layout on finished notes (no model call). Usage: node tools/audit/templatecheck.mjs notes.json [ids,comma]
// notes.json: [{ consult_id, rendered_note }]. For each note: the rubric of the clinician's preferred layout before and after layoutFinish, the removed lines, and the content words lost.
import fs from 'node:fs';
import { trimRepeats } from '../../src/orchestrator/repeatTrim.js';
import { toTemplateFormat } from '../../src/orchestrator/templateFormat.js';

const [file, ids = ''] = process.argv.slice(2);
const all = JSON.parse(fs.readFileSync(file, 'utf8')); const want = ids.split(',').filter(Boolean);
const seen = new Set(); const notes = all.filter((n) => !seen.has(n.consult_id) && seen.add(n.consult_id) && (!want.length || want.some((w) => n.consult_id.endsWith(w))));
const words = (s) => new Set((String(s).toLowerCase().replace(/\*\*/g, '').match(/[a-z0-9][a-z0-9./%-]*/g) || []));
const LABEL_WORDS = new Set('diagnosis differential diagnoses investigations planned treatment referrals advice follow-up started changed stopped continued given today other start stop continue change arrange referral to current vital signs examination'.split(' '));
const rubric = (md) => {
  const L = md.split('\n'); let sec = ''; const r = { topicHeadings: 0, planLabels: 0, longLines: 0, followUpLast: false, problems: 0 };
  for (const ln of L) {
    const h = ln.match(/^###\s+(.*)$/); if (h) { sec = h[1]; continue; }
    if (/^\*\*[^*]+\*\*\s*$/.test(ln.trim())) r.topicHeadings++;
    if (/assessment/i.test(sec)) {
      const pm = ln.match(/^\s*\d+\.\s+\*\*(.+?)\*\*/); if (pm) { r.problems++; r.followUpLast = /^follow-up/i.test(pm[1]); }
      if (/^\s+[-*]\s+(Diagnosis|Differential diagnoses|Investigations planned|Treatment planned|Referrals|Advice|Follow-up|Started|Changed|Stopped|Continued|Given today|Other):/.test(ln)) r.planLabels++;
    }
    const t = ln.replace(/^\s*[-*]\s+/, ''); if (/^\s*[-*]\s/.test(ln) && t.split(/\s+/).length > 22) r.longLines++;
  }
  return r;
};
let out = '';
for (const n of notes) {
  const before = n.rendered_note; const trimmed = trimRepeats(before); const after = toTemplateFormat(trimmed.md);
  const wb = words(before), wa = words(after); const lost = [...wb].filter((w) => !wa.has(w) && !LABEL_WORDS.has(w));
  out += `\n=== ${n.consult_id}\nrubric before ${JSON.stringify(rubric(before))}\nrubric after  ${JSON.stringify(rubric(after))}\nremoved by repeat trim (${trimmed.removed.length}): ${trimmed.removed.map((x) => `[${x.kind}] "${x.line}" (kept: "${x.keptAs}")`).join(' | ') || 'none'}\ncontent words not in the new note: ${lost.join(', ') || 'none'}\n--- AFTER ---\n${after}\n`;
}
console.log(out);
