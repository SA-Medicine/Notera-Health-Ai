// Strict plan clean-up (local test, 2026-11-01). Runs after templateFormat on the finished note. Pure code, no model call, a few milliseconds.
// What it does, and only this:
//   1. Drug verbs are checked against the transcript: "Resume" when the patient had stopped the drug, "Start" when the doctor prescribed a new one,
//      otherwise the verb the note already has stays. Only lines that are a drug with a dose or a frequency are touched.
//   2. A problem named only by a drug ("Prozac") is folded into one "Medication prescriptions" problem, with the drug lines of the same visit.
//   3. A problem with no plan line is dropped when its title is already said elsewhere in the note.
//   4. Two drug lines in one problem that name the same drug are one line (the one with the stronger verb, then the longer, stays). Vaccines are never merged.
//   5. A reading the patient took at home is not an Objective line.
// Nothing is added that the note did not already say, and no number is touched. Off by default: NOTE_STRICT=1.
'use strict';

const VERB = /^(Start|Stop|Continue|Resume|Change|Increase|Reduce|Prescribe)\s+/;
const STOP_WORDS = new Set('daily twice three times once every morning night evening needed weekly monthly with from take taking tablet tablets pills pill capsule capsules cream spray drops injection dose doses hours hour days day week weeks month months before after breakfast lunch dinner bedtime orally mouth only about each also than that this then they them your have been will'.split(' '));
// words too common to find a drug by, or never the first word of a drug line
const COMMON = new Set('blood pressure sugar high borderline current patient requesting prescription prescriptions first advice medication medicine baby routine adequate keep avoid repeat arrange protect maintain watch return seek'.split(' '));
const NONDRUG_FIRST = new Set('current patient requesting prescription prescriptions first take advice medication medicine routine adequate keep avoid repeat arrange protect maintain watch return seek borderline sugar pills'.split(' '));
const DOSE_RE = /\d\s?(mg|mcg|g|ml|iu|units?|puffs?|milligrams?)\b/i;
const FREQ_RE = /\b(daily|twice|once|every|times a|prn|as needed|weekly|monthly|at bedtime|bid|tid|qid)\b/i;
const GENERIC = /^(investigations?|general|other|plan|medication refills?|treatment|referrals?|advice)$/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s || '').toLowerCase().match(/[a-z]{4,}/g) || [];

/** A line that is a drug with a dose or a frequency ("Lipitor every day", "Start Prozac 20 mg"). */
export function isDrugLine(line) {
  const body = String(line).replace(VERB, '').trim();
  const first = (body.match(/[A-Za-z]{3,}/) || [''])[0].toLowerCase();
  if (!first || NONDRUG_FIRST.has(first)) return false;
  return DOSE_RE.test(body) || FREQ_RE.test(body);
}

function candidates(line) {
  const t = line.replace(VERB, '');
  return [...new Set((t.match(/[A-Za-z]{4,}/g) || []).map((w) => w.toLowerCase()).filter((w) => !STOP_WORDS.has(w) && !COMMON.has(w)))].slice(0, 3);
}
function windowAround(tr, cands) {
  const low = tr.toLowerCase(); let out = '';
  for (const c of cands) {
    const key = c.slice(0, Math.min(c.length, 6)); let i = -1;
    while ((i = low.indexOf(key, i + 1)) !== -1) {   // the sentence with the drug in it, and the one before
      const end = low.slice(i).search(/[.?!]/); const e = end < 0 ? Math.min(low.length, i + 160) : i + end + 1;
      const s1 = Math.max(low.lastIndexOf('.', i), low.lastIndexOf('?', i), low.lastIndexOf('!', i));
      const s0 = s1 < 1 ? 0 : Math.max(low.lastIndexOf('.', s1 - 1), low.lastIndexOf('?', s1 - 1), low.lastIndexOf('!', s1 - 1));
      out += ' ' + low.slice(Math.max(0, s0), e); if (out.length > 4000) break;
    }
  }
  return out;
}
const STOPPED = /\b(stopped (taking|it|them|the)|stopped due|stopped because|haven'?t been taking|not taking|didn'?t take it for|ran out|quit)\b/;
const NOGO = /\b(stay off|don'?t (take|restart|start)|do not (take|restart|start)|stop (it|taking|the))\b/;
const NEWRX = /\b(prescription for|give you a prescription|going to (give|start|put|prescribe)|let'?s start|start you|new (pill|medication|prescription))\b/;
const CONT = /\b(refill|renew|same|usual|still|currently|continue|keep taking|already|been on|been taking|you('| a)re taking|you take|regular)\b/;

export function fixVerb(line, transcript) {
  if (/^(Stop|Change|Increase|Reduce)\s/.test(line) || !isDrugLine(line)) return line;
  const m = line.match(VERB); const verb = m ? m[1] : '';
  if (verb === 'Resume') return line;
  const w = windowAround(transcript, candidates(line)); if (!w) return line;
  const body = line.replace(VERB, '');
  if (STOPPED.test(w) && !NOGO.test(w) && !/last night|yesterday|missed/.test(w)) return 'Resume ' + body;
  if (NEWRX.test(w) && !CONT.test(w) && !STOPPED.test(w) && verb !== 'Start') return 'Start ' + body;
  return line;
}

const lead = (l) => words(l.replace(VERB, '').replace(/\([^)]*\)/g, '')).filter((w) => !STOP_WORDS.has(w) || w === 'blood' || w === 'pressure').slice(0, 2);
function sameDrugLine(a, b) {
  const x = lead(a), y = lead(b); if (!x.length || !y.length) return false;
  const n = Math.min(x.length, y.length);
  return x.slice(0, n).join(' ') === y.slice(0, n).join(' ') && !/(administer|given today|vaccine|shot)/i.test(a + b);
}
// "Start" only outranks the others when the transcript shows the doctor prescribing it as new
let _tr = '';
const rank = (s) => {
  if (/^Resume/.test(s)) return 3;
  if (/^Start/.test(s)) { const w = windowAround(_tr, candidates(s)); return NEWRX.test(w) && !CONT.test(w) ? 2 : 0.5; }
  return /^Continue/.test(s) ? 1 : 0;
};
const PROBLEM_STATE = /\b(off (treatment|medication|therapy)|stopped (due|because|taking)|non-?adheren\w*|not taking)\b/i;

export function strictPlan(md, transcript = '', log = () => {}) {
  if (!md) return md;
  _tr = String(transcript || '');
  const lines = String(md).split('\n');
  const apAt = lines.findIndex((l) => /^###\s+Assessment/i.test(l));
  if (apAt < 0) return md;
  const changes = []; const note = (s) => changes.push(s);
  // 5. objective: a reading the patient took at home is not an exam finding
  const head = lines.slice(0, apAt).filter((l) => { const drop = /^\s*-\s.*(patient'?s home reading|home reading|self-measured)/i.test(l); if (drop) note(`home reading out of Objective: "${l.slice(0, 40)}"`); return !drop; });
  const problems = []; let cur = null;
  for (const ln of lines.slice(apAt + 1)) {
    const pm = ln.match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/);
    if (pm) { cur = { title: pm[1].trim(), lines: [] }; problems.push(cur); continue; }
    const bm = ln.match(/^\s*[-*]\s+(.*)$/);
    if (bm && cur) cur.lines.push(bm[1].trim());
  }
  let follow = null; if (problems.length && /^follow-?up$/i.test(problems[problems.length - 1].title)) follow = problems.pop();

  // 1. verbs checked against the transcript (and against the problem's own "off treatment" line)
  for (const p of problems) {
    const stateLine = p.lines.some((l) => !/^Stop/.test(l) && PROBLEM_STATE.test(l));
    const drugLines = p.lines.filter((l) => isDrugLine(l) && !/^(Stop|Change|Increase|Reduce)\s/.test(l));
    p.lines = p.lines.map((l) => {
      let n = fixVerb(l, transcript);
      if (n === l && stateLine && drugLines.length === 1 && l === drugLines[0] && !/^(Resume|Start)\s/.test(l)) n = 'Resume ' + l.replace(VERB, '');
      if (n !== l) note(`verb: "${l.slice(0, 40)}" -> "${n.slice(0, 20)}"`);
      return n;
    });
  }

  // 4. one drug, one line, inside a problem
  for (const p of problems) {
    const keep = [];
    for (const l of p.lines) {
      const k = keep.findIndex((x) => isDrugLine(x) && isDrugLine(l) && sameDrugLine(x, l));
      if (k < 0) { keep.push(l); continue; }
      const best = rank(l) > rank(keep[k]) || (rank(l) === rank(keep[k]) && l.length > keep[k].length) ? l : keep[k];
      note(`same drug merged: "${(best === l ? keep[k] : l).slice(0, 40)}"`); keep[k] = best;
    }
    p.lines = keep;
  }

  // 4b. the same vaccine written twice in one problem ("Shingrix dose 1 administered today" and "Shingles vaccination (Shingrix) first dose administered (given today)") is one line
  const GIVEN = /(administered|given today)/i; const VAC_COMMON = new Set('administered vaccine vaccination immunisation immunization given today dose first second left right arm shot'.split(' '));
  for (const p of problems) {
    const keep = [];
    for (const l of p.lines) {
      const key = GIVEN.test(l) ? words(l).filter((w) => w.length >= 6 && !VAC_COMMON.has(w)) : [];
      const k = key.length ? keep.findIndex((x) => GIVEN.test(x) && words(x).some((w) => key.includes(w))) : -1;
      if (k < 0) { keep.push(l); continue; }
      note(`same vaccine merged: "${keep[k].length >= l.length ? l.slice(0, 40) : keep[k].slice(0, 40)}"`); if (l.length > keep[k].length) keep[k] = l;
    }
    p.lines = keep;
  }

  // 2. a problem named only by a drug becomes one "Medication prescriptions" problem
  const allDrugLines = problems.flatMap((p) => p.lines.filter(isDrugLine));
  const isDrugTitle = (p) => {
    const w = p.title.replace(/\([^)]*\)/g, '').trim().split(/\s+/);
    if (w.length > 2 || p.title.length < 4) return false;
    const stem = norm(w[0]).slice(0, 6);
    return stem.length >= 4 && allDrugLines.some((l) => norm(l.replace(VERB, '')).startsWith(stem));
  };
  const drugProblems = problems.filter(isDrugTitle);
  if (drugProblems.length) {
    const moved = []; const stems = drugProblems.map((p) => norm(p.title.replace(/\([^)]*\)/g, '')).slice(0, 6));
    for (const p of problems) {
      if (drugProblems.includes(p)) continue;
      const mine = p.lines.filter((l) => isDrugLine(l) && stems.some((s) => norm(l.replace(VERB, '')).startsWith(s)));
      if (!mine.length) continue;
      const sib = p.lines.filter((l) => !mine.includes(l) && /^Start\s/.test(l) && isDrugLine(l));   // other new prescriptions written in the same visit
      for (const l of [...mine, ...sib]) { moved.push(l); p.lines = p.lines.filter((x) => x !== l); note(`to Medication prescriptions: "${l.slice(0, 40)}"`); }
    }
    const first = drugProblems[0];
    for (const p of drugProblems.slice(1)) { first.lines.push(...p.lines); problems.splice(problems.indexOf(p), 1); }
    first.lines.push(...moved); first.title = 'Medication prescriptions'; first.lines = [...new Set(first.lines)];
  }

  // 3. a problem with no plan line goes when its title is already said somewhere else in the note
  for (let k = problems.length - 1; k >= 0; k--) {
    const p = problems[k]; if (p.lines.length) continue;
    const mine = words(p.title); if (!mine.length) continue;
    const other = new Set(problems.filter((q) => q !== p).flatMap((q) => [q.title, ...q.lines]).concat(head).flatMap(words));
    const hit = mine.filter((m) => other.has(m) || [...other].some((o) => m.length >= 7 && o.length >= 7 && (m.includes(o.slice(0, 7)) || o.includes(m.slice(0, 7))))).length;
    if (GENERIC.test(p.title.trim()) || hit / mine.length >= 0.5) { note(`empty problem dropped: "${p.title}"`); problems.splice(k, 1); }
  }
  if (!changes.length) return md;
  const out = head.slice(); out.push(lines[apAt]);
  problems.forEach((p, k) => { out.push(`${k + 1}. **${p.title}**`); for (const l of p.lines) out.push(`   - ${l}`); });
  if (follow && follow.lines.length) { out.push(`${problems.length + 1}. **Follow-up**`); for (const l of follow.lines) out.push(`   - ${l}`); }
  log(`[v2:strict] ${changes.length} change(s): ` + changes.join(' | '));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
