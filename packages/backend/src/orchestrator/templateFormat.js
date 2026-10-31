// Template layout (local test, 2026-10-31): the note in the layout of the clinician's preferred note.
//   Subjective / Past Medical History / Objective: one flat list of short lines, no topic sub-headings, no "Associated Symptoms" block, no Vital Signs / Examination / Investigations group labels.
//   Assessment & Plan: "N. Problem" then plain lines (no Diagnosis:, Investigations planned:, Treatment planned:, Started:, Advice: ... labels, no "Treatment planned:" parent line,
//   no Diagnosis line that only repeats the title), several items joined with "; " become separate lines, and every Follow-up goes into one last numbered item "Follow-up".
// Pure text transform on the finished markdown. No wording is changed or added; nothing is removed except labels, group headings and a Diagnosis line equal to its title.
// Off by default: NOTE_FORMAT=template switches it on.
'use strict';

const LABELS = ['Diagnosis', 'Differential diagnoses', 'Investigations planned', 'Treatment planned', 'Referrals', 'Advice', 'Follow-up', 'Started', 'Changed', 'Stopped', 'Continued', 'Given today', 'Other'];
const LABEL_RE = new RegExp('^(' + LABELS.join('|') + '):\s*(.*)$', 'i');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A label that carries a decision is turned into the verb it stood for, so no meaning is lost when the label goes:
// "Stopped: aspirin" -> "Stop aspirin", "Referrals: ramp clinic" -> "Referral to ramp clinic". Labels that only named the line (Advice, Other, Treatment planned) just go.
const VERB_START = /^(arrang|order|repeat|check|book|schedul|request|proceed|obtain|do |perform|send|get|recheck|review|follow|refer|start|stop|continue|resume|increase|decrease|change|prescrib|give|take|avoid|discuss)/i;
function phrase(label, t) {
  const low = t;   // brand names keep their capital
  switch (label) {
    case 'started': return /^(start|prescrib|begin|initiat)/i.test(t) ? t : 'Start ' + low;
    case 'stopped': return /^(stop|discontinu|hold)/i.test(t) ? t : 'Stop ' + low;
    case 'continued': return /^(continu|resume|refill|renew|keep)/i.test(t) ? t : 'Continue ' + low;
    case 'changed': return /^(chang|increas|decreas|adjust|switch|reduc)/i.test(t) ? t : 'Change ' + low;
    case 'given today': return /today/i.test(t) ? t : t + ' (given today)';
    case 'referrals': return /referr/i.test(t) ? t : 'Referral to ' + low;
    case 'investigations planned': return VERB_START.test(t) ? t : 'Arrange ' + low;
    case 'differential diagnoses': return 'Differential diagnoses: ' + t;
    case 'diagnosis': return 'Diagnosis: ' + t;
    default: return t;
  }
}

function splitTop(text) {
  const out = []; let depth = 0, cur = '';
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function toTemplateFormat(md) {
  if (!md) return md;
  const out = []; const lines = String(md).split('\n');
  let section = ''; let i = 0;
  const problems = []; let cur = null; const follow = [];
  const flush = () => { if (!problems.length) return; };
  for (; i < lines.length; i++) {
    const ln = lines[i];
    const h = ln.match(/^###\s+(.*)$/);
    if (h) { section = h[1].trim(); if (!/assessment/i.test(section)) { if (out.length && out[out.length - 1] !== '') out.push(''); out.push(ln); } else { if (out.length && out[out.length - 1] !== '') out.push(''); out.push(ln); } continue; }
    if (!/assessment/i.test(section)) {
      if (/^\*\*[^*]+\*\*\s*$/.test(ln.trim())) continue;   // a bold topic or group line
      if (!ln.trim()) continue;                              // blank lines between topics
      out.push(ln); continue;
    }
    // Assessment & Plan
    const pm = ln.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/);
    if (pm) { cur = { title: pm[2].trim(), lines: [] }; problems.push(cur); continue; }
    const bm = ln.match(/^\s*[-*]\s+(.*)$/);
    if (!bm || !cur) { if (ln.trim() && cur) cur.lines.push(ln.trim()); continue; }
    let body = bm[1].trim(); const lm = body.match(LABEL_RE); let label = '';
    if (lm) { label = lm[1].toLowerCase(); body = lm[2].trim(); }
    if (!body) continue;                                      // "Treatment planned:" with its items on the next lines
    if (label === 'diagnosis' && norm(body) === norm(cur.title)) continue;
    const items = splitTop(body);
    for (const it of items) { if (label === 'follow-up') follow.push(it); else cur.lines.push(phrase(label, it)); }
  }
  // write the problems
  const apAt = out.findIndex((l) => /^###\s+Assessment/i.test(l));
  if (apAt >= 0) {
    problems.forEach((p, k) => { out.push(`${k + 1}. **${p.title}**`); for (const l of p.lines) out.push(`   - ${l.replace(/^[-*]\s+/, '')}`); });
    if (follow.length) { out.push(`${problems.length + 1}. **Follow-up**`); for (const f of follow) out.push(`   - ${f}`); }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
