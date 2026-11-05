// Template layout (local test, 2026-10-31): the note in the layout of the clinician's preferred note.
//   Subjective / Past Medical History / Objective: one flat list of short lines, no topic sub-headings, no "Associated Symptoms" block, no Vital Signs / Examination / Investigations group labels.
//   Assessment & Plan: "N. Problem" then plain lines (no Diagnosis:, Investigations planned:, Treatment planned:, Started:, Advice: ... labels, no "Treatment planned:" parent line,
//   no Diagnosis line that only repeats the title), several items joined with "; " become separate lines, and every Follow-up goes into one last numbered item "Follow-up".
// Pure text transform on the finished markdown. No wording is changed or added; nothing is removed except labels, group headings and a Diagnosis line equal to its title.
// Off by default: NOTE_FORMAT=template switches it on.
'use strict';

const LABELS = ['Diagnosis', 'Differential diagnoses', 'Investigations planned', 'Treatment planned', 'Referrals', 'Advice', 'Follow-up', 'Started', 'Changed', 'Stopped', 'Continued', 'Given today', 'Other'];
const LABEL_RE = new RegExp('^(' + LABELS.join('|') + '):[ ]*(.*)$', 'i');   // note: no backslash escapes inside this string
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A label that carries a decision is turned into the verb it stood for, so no meaning is lost when the label goes:
// "Stopped: aspirin" -> "Stop aspirin", "Referrals: ramp clinic" -> "Referral to ramp clinic". Labels that only named the line (Advice, Other, Treatment planned) just go.
const VERB_START = /^(arrang|order|repeat|check|book|schedul|request|proceed|obtain|do |perform|send|get|recheck|review|follow|refer|start|stop|continue|resume|increase|decrease|change|prescrib|give|take|avoid|discuss|note|letter|ask|inform|counsel|advis|bring|keep|protect|monitor|maintain|look|offer|instruct)/i;
const HAS_ACTION = /\b(order\w*|arrang\w*|schedul\w*|plann\w*|book\w*|request\w*|sent|send|repeat|too early|needed|will|provided|issued|given|faxed|done|requisition\w*|completed)\b/i;
// A verb (Start / Stop / Continue / Change) goes only in front of a drug or treatment; a diet, a test or a plain statement is left as written.
const TREATMENT_WORDS = /(\bpills?\b|\btablets?\b|\bcapsules?\b|\bcream\b|\bointment\b|\binhaler\b|\bspray\b|\bdrops\b|\binjections?\b|\binsulin\b|\bpatch\b|\bvaccine\b|\bmedications?\b|\bantibiotics?\b|\bsupplements?\b|\bgel\b|\bmuscle relaxant\b|\bpuffs?\b)/i;
const DOSE = /\d\s?(mg|mcg|g|ml|iu|units?|%)(\b|$)/i;
const DRUG_END = /(pril|sartan|statin|olol|azole|mab|cillin|mycin|cycline|prazole|gliptin|gliflozin|zepam|zolam|profen|oxetine|pram|ipine|dipine|lone|sone|formin|mide|thiazide|xaban|parin|tropin|setron)$/i;
const isTreatment = (t) => DOSE.test(t) || TREATMENT_WORDS.test(t) || /\([a-z][^)]+\)/i.test(t) || t.split(/[^A-Za-z]+/).some((w) => w.length > 5 && DRUG_END.test(w));
function phrase(label, t) {
  const low = t;   // brand names keep their capital
  if (['started', 'continued', 'changed'].includes(label) && !isTreatment(t) && t.trim().split(/ +/).length > 1) return t;   // a single word after these labels is a drug name; "Stopped" always keeps its verb
  switch (label) {
    case 'started': return /^(start|prescrib|begin|initiat)/i.test(t) ? t : 'Start ' + low;
    case 'stopped': return /^(stop|discontinu|hold)/i.test(t) ? t : 'Stop ' + low;
    case 'continued': return /^(continu|resume|refill|renew|keep)/i.test(t) ? t : 'Continue ' + low;
    case 'changed': return /^(chang|increas|decreas|adjust|switch|reduc)/i.test(t) ? t : 'Change ' + low;
    case 'given today': return /today/i.test(t) ? t : t + ' (given today)';
    case 'referrals': return (/referr/i.test(t) || VERB_START.test(t)) ? t : 'Referral to ' + low;
    case 'investigations planned': return (VERB_START.test(t) || HAS_ACTION.test(t)) ? t : 'Arrange ' + low;
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
      // Topic gaps (2026-11-05): the topic headings still go, but where one topic ends and the next begins in the Subjective a marker is left, which becomes ONE blank line below,
      // so related lines sit together as a visible group without a heading (TOPIC_GAPS=0 switches off).
      const mark = () => { if (TOPIC_GAPS && /^subjective/i.test(section) && out.length && out[out.length - 1] !== GAP && !/^###/.test(out[out.length - 1])) out.push(GAP); };
      if (/^\*\*[^*]+\*\*\s*$/.test(ln.trim())) { mark(); continue; }   // a bold topic or group line
      if (!ln.trim()) { mark(); continue; }                              // blank lines between topics
      if (/^\s*[-*]\s+[^:]{2,70}:\s*$/.test(ln)) { mark(); continue; }  // a topic heading written as a bullet ("Gastroesophageal Reflux Disease (GERD):")
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
  // one drug is one line: "Start Lexapro 10 mg" and "Lexapro (escitalopram) 10 mg" are the same line
  const dkey = (l) => norm(l.replace(/\([^)]*\)/g, '').replace(/^(start|stop|continue|resume|change|increase|reduce|prescribe)\s+/i, ''));
  for (const p of problems) { const seen = new Set(); p.lines = p.lines.filter((l) => { const k = dkey(l); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }
  // tidy each problem: no empty brackets, a short line that a longer line in the same problem already says goes, "Continue" becomes "Resume" when the problem says the patient had stopped or missed it
  const STATE = /\b(stopped (due|because)|non-?adheren\w*|not taking|did not take|didn't take|missed|ran out|stopped taking)\b/i;
  const core = (l) => norm(l.replace(/\([^)]*\)/g, '').replace(/^(start|stop|continue|resume|change|increase|reduce|prescribe|arrange|referral to)\s+/i, ''));
  for (const p of problems) {
    p.lines = p.lines.map((l) => l.replace(/\s*\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
    const keys = p.lines.map(core);
    p.lines = p.lines.filter((l, a) => !(keys[a].length >= 10 && keys.some((k, b) => b !== a && k.length > keys[a].length && k.includes(keys[a]))));
    if (p.lines.some((l) => !/^(Stop|Discontinue)[ ]/.test(l) && STATE.test(l))) p.lines = p.lines.map((l) => l.replace(/^Continue\s+/, 'Resume '));
  }
  // a problem with no line of its own whose words another problem already has is a duplicate title (e.g. "Hypercholesterolemia" after "Elevated cholesterol")
  const words = (s) => String(s).toLowerCase().match(/[a-z]{4,}/g) || [];
  const same = (m, o) => m.length >= 7 && o.length >= 7 && (m.includes(o.slice(0, 7)) || o.includes(m.slice(0, 7)));
  for (let k = problems.length - 1; k >= 0; k--) {
    const p = problems[k]; if (p.lines.length) continue;
    const mine = words(p.title);
    const other = problems.filter((q, j) => j !== k).flatMap((q) => [q.title, ...q.lines]).flatMap(words);
    if (mine.some((m) => other.some((o) => same(m, o)))) problems.splice(k, 1);
  }
  // write the problems
  const apAt = out.findIndex((l) => /^###\s+Assessment/i.test(l));
  if (apAt >= 0) {
    problems.forEach((p, k) => { out.push(`${k + 1}. **${p.title}**`); for (const l of p.lines) out.push(`   - ${l.replace(/^[-*]\s+/, '')}`); });
    if (follow.length) { out.push(`${problems.length + 1}. **Follow-up**`); for (const f of follow) out.push(`   - ${f}`); }
  }
  return resolveGaps(out).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const TOPIC_GAPS = process.env.TOPIC_GAPS !== '0';
const GAP = '\u0001GAP';
/** A topic marker becomes one blank line, unless the topic before it and the topic after it are both a single line (two lone lines in a row stay together, so the Subjective is not chopped into pieces). */
function resolveGaps(out) {
  const isBullet = (l) => /^\s*[-*]\s+\S/.test(l);
  const res = [];
  for (let k = 0; k < out.length; k++) {
    if (out[k] !== GAP) { res.push(out[k]); continue; }
    let prev = 0; for (let j = k - 1; j >= 0 && out[j] !== GAP && !/^###/.test(out[j]); j--) if (isBullet(out[j])) prev++;
    let next = 0; for (let j = k + 1; j < out.length && out[j] !== GAP && !/^###/.test(out[j]) && out[j] !== ''; j++) if (isBullet(out[j])) next++;
    if (next > 0 && !(prev <= 1 && next <= 1)) res.push('');
  }
  return res;
}
