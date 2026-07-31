// ─────────────────────────────────────────────────────────────────────────────
// noteToMarkdown — deterministic render of the schema note into the Heidi/gold layout
// as clean Markdown: section headings + one bullet per line, numbered Assessment & Plan
// with labelled sub-bullets. This GUARANTEES the on-screen structure always matches the
// fixed schema (attached spec), and markdown-it renders it as real <ul>/<li> bullets.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Split a field's value into clean bullet lines: newline-split, then sentence-split so a
// paragraph becomes crisp points (like the gold note). The sentence split only fires after
// a real word of 3+ chars, so honorifics/abbreviations ("Dr.", "e.g.", "St.") don't break.
function bullets(val) {
  const arr = Array.isArray(val) ? val : String(val || '').split('\n');
  const out = [];
  for (const raw of arr) {
    const line = String(raw).trim().replace(/^[-•*]\s*/, '');
    if (!line) continue;
    for (const part of line.split(/(?<=[a-z0-9]{3}[.!?])\s+(?=[A-Z(])/)) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  return out;
}
const section = (L, title, lines) => { if (lines.length) { L.push(`### ${title}`); for (const b of lines) L.push(`- ${b}`); L.push(''); } };

export function noteToMarkdown(note) {
  if (!note) return '';
  const L = [];

  const s = note.subjective || {};
  section(L, 'Subjective', [
    ...bullets(s.reason_for_visit), ...bullets(s.hpi_details), ...bullets(s.aggravating_relieving_factors),
    ...bullets(s.symptom_progression), ...bullets(s.previous_episodes), ...bullets(s.functional_impact),
    ...bullets(s.associated_symptoms),
  ]);

  const p = note.past_medical_history || {};
  section(L, 'Past Medical History', [
    ...bullets(p.medical_surgical), ...bullets(p.social), ...bullets(p.family),
    ...bullets(p.exposure), ...bullets(p.immunisation), ...bullets(p.other),
  ]);

  const o = note.objective || {};
  section(L, 'Objective', [
    ...bullets(o.vital_signs), ...bullets(o.examination), ...bullets(o.completed_investigations),
  ]);

  const ap = note.assessment_and_plan || [];
  const apItems = ap.filter((it) => it && (String(it.issue || '').trim() || String(it.diagnosis || '').trim() || String(it.assessment || '').trim() || String(it.treatment_planned || '').trim()));
  if (apItems.length) {
    L.push('### Assessment & Plan');
    apItems.forEach((it, i) => {
      const title = String(it.issue || it.diagnosis || `Issue ${i + 1}`).trim();
      L.push(`${i + 1}. **${title}**`);
      const sub = (label, val) => { for (const b of bullets(val)) L.push(`   - ${label}${b}`); };
      if (it.diagnosis && norm(it.diagnosis) !== norm(title)) sub('Diagnosis: ', it.diagnosis);
      sub('', it.assessment);
      if (Array.isArray(it.differential_diagnoses) && it.differential_diagnoses.length) L.push(`   - Differentials: ${it.differential_diagnoses.join(', ')}`);
      sub('Investigations: ', it.investigations_planned);
      sub('Treatment: ', it.treatment_planned);
      sub('Referrals: ', it.referrals);
    });
    L.push('');
  }

  return L.join('\n').trim();
}
