// Format-fidelity metrics for a SOAP note versus the clinician's gold note — FORMAT ONLY (structure, flow, how facts are laid out), never the content.
// Learned the way "reverse prompt engineering" works: induce the rules from many real outputs (410 topic-headed gold notes, see
// docs/reports/FORMAT_ANALYSIS_2026-10-22.md), then validate on held-out transcripts by scoring the regenerated notes with these measurements.
// Pure functions, no I/O. Read-only analysis: nothing here changes how production writes a note (Style Spec v1 stays locked).
'use strict';

const SEC = /^(Subjective|Past Medical History|Objective|Assessment\s*&\s*Plan|Assessment and Plan):\s*$/;
const HEAD = /^\s*([A-Z][A-Za-z &/,'()-]{2,45}):\s*$/;
const LABELS = [
  ['Diagnosis', /^diagnos/], ['Investigations planned', /^investigation/], ['Treatment planned', /^treatment/], ['Referrals', /^referral/],
  ['Counselling', /^(counsel|advi[cs]|discussed|explained|educat|safety|red flag|reassur)/], ['Follow-up', /^(follow|rtc|return|recheck|review in)/],
];
// problem titles that are buckets instead of the issue the doctor addressed ("Administrative" is a Style Spec v1 bucket for forms and permits, so it is allowed)
const GENERIC_TITLE = /^(lab (abnormalit|review|result|finding)|results? review|investigations?|other|miscellaneous|general|health maintenance review|medication(s| review)?|plan)\b/i;

/** Plain-text view of a note written as markdown (### headings, **bold**, indented bullets) or as the gold plain format. */
export function plain(note) {
  return String(note || '').replace(/^#{1,4}\s*(Subjective|Past Medical History|Objective|Assessment\s*&\s*Plan)\s*$/gm, '$1:').replace(/\*\*/g, '').replace(/^\s{2,}-/gm, '-');
}
export function sections(note) {
  const out = {}; let cur = null;
  for (const line of plain(note).split('\n')) { const m = line.match(SEC); if (m) { cur = /^Assessment/.test(m[1]) ? 'AP' : m[1] === 'Past Medical History' ? 'PMH' : m[1]; out[cur] = []; } else if (cur) out[cur].push(line); }
  return out;
}
export function problems(lines) {
  const out = []; let cur = null;
  for (const l of lines || []) {
    const m = l.match(/^\s*(\d+)\.\s+(.*)$/);
    if (m) { cur = { title: m[2].trim(), bullets: [] }; out.push(cur); } else if (/^\s*-\s/.test(l) && cur) cur.bullets.push(l.replace(/^\s*-\s*/, '').trim());
  }
  return out;
}
export function topicCount(lines) { return (lines || []).filter((l) => HEAD.test(l) && !/^\s*-/.test(l)).length; }
export function labelOf(bullet) {
  const m = String(bullet).match(/^([A-Za-z][A-Za-z /&()-]{2,40}?)\s*(?::|\s-\s)/); const head = (m ? m[1] : String(bullet).split(/\s+/).slice(0, 2).join(' ')).trim().toLowerCase();
  for (const [name, re] of LABELS) if (re.test(head)) return name; return null;
}
const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'due', 'post', 'rule', 'likely', 'mild', 'mildly', 'query', 'suspected', 'probable']);
const stem = (w) => w.replace(/ae/g, 'e').replace(/oe/g, 'e').replace(/(osis|itis|emia|ia|ing|ion|ed|es|s|y)$/, '').slice(0, 7);   // haemorrhoids = hemorrhoids, vitamin b12 = b12
const toks = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w) && w !== 'vitamin').map(stem));
export function overlap(a, b) { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); }

/** Layout statistics of one note. */
export function layout(note) {
  const s = sections(note); const ps = problems(s.AP); const bullets = ps.flatMap((p) => p.bullets);
  let repeatedLabels = 0, echoDx = 0, genericTitles = 0;
  for (const p of ps) {
    const seen = {}; for (const b of p.bullets) { const k = /^[A-Za-z][A-Za-z /&()-]{2,40}:/.test(b) ? labelOf(b) : null; if (k && k !== 'Counselling' && k !== 'Follow-up') seen[k] = (seen[k] || 0) + 1; }   // only an explicit "Label:" counts; a sentence that happens to start with the word Referral is not a label
    repeatedLabels += Object.values(seen).filter((v) => v > 1).reduce((a, v) => a + v - 1, 0);
    if (p.bullets.some((b) => /^Diagnosis:/i.test(b) && overlap(b.replace(/^Diagnosis:/i, ''), p.title) >= 0.99 && toks(p.title).size === toks(b.replace(/^Diagnosis:/i, '')).size)) echoDx++;
    if (GENERIC_TITLE.test(p.title.replace(/[^A-Za-z ]/g, ''))) genericTitles++;
  }
  const subj = s.Subjective || [];
  return {
    problems: ps.length, apBullets: bullets.length, bulletsPerProblem: ps.length ? +(bullets.length / ps.length).toFixed(2) : 0,
    repeatedLabels, runOnBullets: bullets.filter((b) => b.length > 170).length, counsellingLines: bullets.filter((b) => labelOf(b) === 'Counselling').length,
    adviceInsideTreatment: bullets.filter((b) => labelOf(b) === 'Treatment planned' && /\b(advis|counsel|discuss|explain)/i.test(b)).length,
    followUpLines: bullets.filter((b) => labelOf(b) === 'Follow-up').length, echoedDiagnosis: echoDx, genericTitles,
    emptyLabels: (plain(note).match(/^\s*-\s+[A-Z][A-Za-z ]+:\s*$/gm) || []).length,
    subjectiveTopics: topicCount(subj), subjectiveBullets: subj.filter((l) => /^\s*-/.test(l)).length,
    titles: ps.map((p) => p.title),
  };
}

/** Our note against the gold note: layout of both, which gold problems are missing, and plain-language flags the auditor and the report can quote. */
export function formatReport(note, gold) {
  const o = layout(note), g = layout(gold);
  const missing = g.titles.filter((t) => !o.titles.some((u) => overlap(u, t) >= 0.5));
  const extra = o.titles.filter((t) => !g.titles.some((u) => overlap(u, t) >= 0.5));
  const flags = [];
  if (g.problems && o.problems < g.problems) flags.push(`fewer A&P problems than the gold note (${o.problems} vs ${g.problems})`);
  if (missing.length) flags.push(`gold problems with no matching problem in the note: ${missing.slice(0, 6).join(' | ')}`);
  if (o.repeatedLabels > 0) flags.push(`${o.repeatedLabels} repeated label line(s) under one problem (a label such as "Treatment planned:" should appear once per problem, items joined with commas or semicolons)`);
  if (o.runOnBullets > 0) flags.push(`${o.runOnBullets} A&P line(s) longer than 170 characters (run-on lines hurt readability)`);
  if (g.counsellingLines > 0 && o.counsellingLines === 0) flags.push(`the gold note has ${g.counsellingLines} separate advice/counselling line(s); the note has none${o.adviceInsideTreatment ? ' (advice is mixed into "Treatment planned:")' : ''}`);
  if (g.followUpLines > 0 && o.followUpLines === 0) flags.push('the gold note records follow-up timing as its own line; the note has no follow-up line');
  if (o.genericTitles > 0) flags.push(`${o.genericTitles} generic bucket title(s) instead of the issue the doctor addressed`);
  if (o.emptyLabels > 0) flags.push(`${o.emptyLabels} label(s) with nothing after the colon`);
  return { ours: { ...o, titles: undefined }, gold: { ...g, titles: undefined }, missing_gold_problems: missing, extra_problems: extra, flags };
}

/** Run-level means over many formatReport results. */
export function aggregate(reports) {
  const n = reports.length || 1; const mean = (f) => +(reports.reduce((s, r) => s + f(r), 0) / n).toFixed(2);
  const keys = ['problems', 'apBullets', 'repeatedLabels', 'runOnBullets', 'counsellingLines', 'followUpLines', 'genericTitles', 'emptyLabels', 'subjectiveTopics'];
  const out = { notes: reports.length, ours: {}, gold: {} };
  for (const k of keys) { out.ours[k] = mean((r) => r.ours[k]); out.gold[k] = mean((r) => r.gold[k]); }
  const gp = reports.reduce((s, r) => s + r.gold.problems, 0), miss = reports.reduce((s, r) => s + r.missing_gold_problems.length, 0);
  out.gold_problem_coverage = gp ? +(1 - miss / gp).toFixed(2) : null;
  out.notes_with_repeated_labels = reports.filter((r) => r.ours.repeatedLabels > 0).length;
  out.notes_with_fewer_problems = reports.filter((r) => r.ours.problems < r.gold.problems).length;
  return out;
}
