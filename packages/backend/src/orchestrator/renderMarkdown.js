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

  // ── Subjective ──────────────────────────────────────────────────────────────
  // ONE merged "presenting complaint + history" narrative (the detailed story at the
  // top): the chief complaint (reason_for_visit) is folded into the front of the HPI —
  // there is NO separate "Presenting Complaints" header. Associated Symptoms follow as
  // their own de-duplicated sub-block (pertinent negatives preserved by condenseNote).
  const s = note.subjective || {};
  const story = [
    ...bullets(s.reason_for_visit), ...bullets(s.hpi_details), ...bullets(s.aggravating_relieving_factors),
    ...bullets(s.symptom_progression), ...bullets(s.previous_episodes), ...bullets(s.functional_impact),
  ];
  const assoc = bullets(s.associated_symptoms);
  if (story.length || assoc.length) {
    L.push('### Subjective');
    for (const b of story) L.push(`- ${b}`);
    if (assoc.length) {
      L.push('');
      L.push('**Associated Symptoms**');
      for (const b of assoc) L.push(`- ${b}`);
    }
    L.push('');
  }

  const p = note.past_medical_history || {};
  section(L, 'Past Medical History', [
    ...bullets(p.medical_surgical), ...bullets(p.social), ...bullets(p.family),
    ...bullets(p.exposure), ...bullets(p.immunisation), ...bullets(p.other),
  ]);

  // ── Objective ───────────────────────────────────────────────────────────────
  // Terse: vitals labelled (compact + clinically important), then a single DISSOLVED
  // findings list (examination + completed_investigations) — there is NO separate
  // "Exam Findings"/"Key Findings" sub-section. condenseNote de-dups exam vs labs first.
  const o = note.objective || {};
  const vitals = bullets(o.vital_signs);
  const findings = [...bullets(o.examination), ...bullets(o.completed_investigations)];
  if (vitals.length || findings.length) {
    L.push('### Objective');
    if (vitals.length) { L.push('**Vital Signs**'); for (const b of vitals) L.push(`- ${b}`); }
    if (findings.length) { if (vitals.length) L.push(''); for (const b of findings) L.push(`- ${b}`); }
    L.push('');
  }

  const ap = note.assessment_and_plan || [];
  const apItems = ap.filter((it) => it && (String(it.issue || '').trim() || String(it.diagnosis || '').trim() || String(it.assessment || '').trim() || String(it.treatment_planned || '').trim()));
  if (apItems.length) {
    L.push('### Assessment & Plan');
    apItems.forEach((it, i) => {
      // Title must be the PROBLEM/DIAGNOSIS NAME, never a bare placeholder like "1"/"Issue 2".
      // If the pipeline left a numeric placeholder in `issue`, fall back to the diagnosis so
      // the heading reads "1. Diverticulitis" (like the gold note), not "1. 1".
      const isPlaceholder = (t) => !t || /^(?:issue|problem|point|dx|#)?\s*#?\d+\.?$/i.test(t);
      const issue = String(it.issue || '').trim();
      const diag = String(it.diagnosis || '').trim();
      const title = (!isPlaceholder(issue) ? issue : '') || diag || issue || `Issue ${i + 1}`;
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
