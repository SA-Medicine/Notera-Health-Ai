// Fidelity guards (Style Spec v2.1): deterministic last checks on facts a model can invent or garble, run after the grounding agent and the reference names.
//   1. SOCIAL HISTORY   smoking, alcohol, drugs, living situation, marital status and work are kept only if the recording has the patient (or a question to the
//                       patient) say it. A clinician listing reflux triggers ("smoking, alcohol") is advice, not history. Unsupported clauses are removed.
//   2. UNHEARD DRUGS    a drug name (by its ending: -prazole, -sartan, -statin ...) that the recording never says is replaced by its class ("PPI") and flagged.
//   3. ASR SPELLING     when a spoken brand has an exact generic (RxNorm: Crestor = rosuvastatin) and the recording also contains a near spelling of that
//                       generic ("rovastatin"), the generic is written everywhere, so one drug never has two names in a note.
//   4. UNHEARD TESTS    a test or procedure named in the plan (sleep study, MRI, ultrasound ...) that the recording never mentions is taken out and flagged.
//   5. TIDY             headings with nothing under them are dropped; a stool test named twice in one problem is written once ("poop kit" -> "stool test kit");
//                       vaccines are treatment, not investigations; screening status lines in Past Medical History that the plan already carries are dropped.
// Pure code, no model call, never throws into the pipeline. Switch: stage.fidelityGuards (FIDELITY_GUARDS=0 also switches it off).
'use strict';

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const SUBJ = ['reason_for_visit', 'hpi_details', 'aggravating_relieving_factors', 'symptom_progression', 'previous_episodes', 'functional_impact', 'associated_symptoms'];
const PMH = ['medical_surgical', 'social', 'family', 'exposure', 'immunisation', 'other'];
const PLAN = ['assessment', 'investigations_planned', 'treatment_planned', 'referrals'];

/** The note's text fields in reading order: { obj, key, where, plan }. */
function fields(note) {
  const out = [];
  for (const k of SUBJ) if (typeof note?.subjective?.[k] === 'string') out.push({ obj: note.subjective, key: k, where: 'subjective', plan: false });
  for (const k of PMH) if (typeof note?.past_medical_history?.[k] === 'string') out.push({ obj: note.past_medical_history, key: k, where: 'pmh', plan: false });
  (note?.assessment_and_plan || []).forEach((p, i) => { for (const k of PLAN) if (typeof p?.[k] === 'string') out.push({ obj: p, key: k, where: 'plan', plan: true, item: i }); });
  return out;
}
const sepOf = (raw) => (/\n/.test(raw) ? '\n' : '; ');
const pieces = (f) => (f.plan ? String(f.obj[f.key]).split(/\n|; /) : String(f.obj[f.key]).split('\n'));   // plan items arrive newline-separated or joined with "; "
function setPieces(f, list) { const sep = sepOf(f.obj[f.key]); f.obj[f.key] = list.filter((x) => x !== null && String(x).trim() !== '').join(sep); }
const flag = (note, type, message, severity = 'info') => { (note.metadata ||= {}).flags = [...(note.metadata.flags || []), { type, field: 'note', message, severity }]; };

// ── 1. social history ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// claim = what the note says; own = the recording says it about THIS patient (they say it, or the clinician asks them).
const SOCIAL = [
  { name: 'smoking', claim: /\b(non[- ]?smoker|ex[- ]?smoker|smok(?:es?|ing|er)|tobacco|cigarettes?|vap(?:es?|ing))\b/i,
    own: /\bnon[- ]?smoker\b|\bex[- ]?smoker\b|\bcigarettes?\b|\bpacks? (?:a|per) day\b|\bquit smoking\b|\bnever smoked\b|\b(?:do|did|have|are|were) you\b[^.?!]{0,30}\b(?:smok\w*|vap\w*|tobacco)|\bi\b[^.?!]{0,25}\b(?:smok\w*|vap\w*)\b|\bsmok\w*[^.?!]{0,30}\?/i },
  { name: 'alcohol', claim: /\b(alcohol(?:ic)?|etoh|wine|beer|liquor|spirits|drinks? (?:alcohol|wine|beer)|drinking (?:alcohol|wine|beer))\b/i,
    own: /\b(?:do|did|have|are|how much|how many|how often)\b[^.?!]{0,30}\b(?:alcohol|wine|beer)\b|\b(?:do|did) you (?:\w+ )?drink\b(?! (?:water|coffee|tea|enough|any water))|\bi\b[^.?!]{0,25}\b(?:wine|beer|alcohol)\b|\bi (?:don'?t |do not |never |rarely |occasionally )?drink (?:alcohol|wine|beer|socially)|\b(?:glass(?:es)? of (?:wine|beer)|socially|teetotal)\b/i },
  { name: 'drugs', claim: /\b(cannabis|marijuana|weed|recreational drugs?|illicit drugs?|street drugs?)\b/i,
    own: /\b(?:cannabis|marijuana|weed|recreational|street drugs?)\b[^.?!]{0,40}\b(?:i|you|use|smoke|take)\b|\b(?:do|did|have) you\b[^.?!]{0,30}\b(?:drugs|cannabis|marijuana)\b/i },
  { name: 'living', claim: /\b(?:lives? (?:alone|with [a-z ]+?)|living (?:alone|with [a-z ]+?)|lives at home)\b/i, own: /\b(?:live|lives|living)\b|\balone\b/i },
  { name: 'marital', claim: /^\s*(?:single|married|widowed|divorced|separated)\s*$|\b(?:is|are)\s+(?:single|married|widowed|divorced|separated)\b/i, own: /\b(?:husband|wife|married|single|widow\w*|divorc\w*|separated|partner|spouse|boyfriend|girlfriend|fianc\w+)\b/i },
  { name: 'work', claim: /\b(?:works? (?:as|in|at|for)|retired|occupation|employed|unemployed)\b/i, own: /\b(?:work|works|working|job|retired|occupation|career|employed|unemployed)\b/i },
];
const ADVICE = /\b(avoid|advis\w*|counsel\w*|triggers?|worsen\w*|aggravat\w*|can make|reduce|limit|cut (?:down|out)|recommend\w*|stop|quit)\b/i;
const CLAUSE = /(,\s+|;\s+|\s+and\s+|\s+but\s+)/;

export function socialGuard(note, transcript) {
  const T = String(transcript || ''); const removed = [];
  const classes = SOCIAL.map((c) => ({ ...c, said: c.own.test(T) }));
  for (const f of fields(note)) {
    if (f.where === 'plan') continue;
    const out = pieces(f).map((line) => {
      const pre = (line.match(/^\s*[-•*]\s*/) || [''])[0]; const body = line.slice(pre.length);
      if (!body.trim() || ADVICE.test(body) || /^(?:medications?|allergies)\s*:/i.test(body)) return line;
      const parts = body.split(CLAUSE);   // text, separator, text ...
      const keep = []; let dropped = 0;
      for (let i = 0; i < parts.length; i += 2) {
        const text = parts[i]; const hit = classes.filter((c) => c.claim.test(text));
        if (hit.length && hit.every((c) => !c.said)) { dropped++; removed.push(text.trim()); } else keep.push(text);
      }
      if (!dropped) return line;
      if (!keep.length) return null;
      return pre + cap(keep.join(', ').trim());
    });
    if (out.some((x, i) => x !== pieces(f)[i])) setPieces(f, out);
  }
  for (const r of removed) flag(note, 'removed_unsupported', `"${r.slice(0, 120)}" - the recording does not say this about the patient`, 'info');
  return removed;
}

// ── 2/3. drug names ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CLASS_BY_ENDING = [
  ['prazole', 'PPI'], ['tidine', 'H2 blocker'], ['sartan', 'ARB'], ['pril', 'ACE inhibitor'], ['olol', 'beta blocker'], ['dipine', 'calcium channel blocker'],
  ['statin', 'statin'], ['cillin', 'antibiotic'], ['mycin', 'antibiotic'], ['floxacin', 'antibiotic'], ['cycline', 'antibiotic'], ['zepam', 'benzodiazepine'], ['zolam', 'benzodiazepine'],
  ['oxetine', 'antidepressant'], ['setron', 'antiemetic'], ['thiazide', 'diuretic'], ['semide', 'diuretic'], ['xaban', 'anticoagulant'], ['gatran', 'anticoagulant'], ['gliptin', 'diabetes medication'],
  ['gliflozin', 'diabetes medication'], ['glutide', 'diabetes medication'], ['formin', 'diabetes medication'], ['triptan', 'migraine medication'], ['coxib', 'NSAID'], ['azole', 'medication'], ['lukast', 'medication'],
];
const DRUGISH = new RegExp(String.raw`\b[A-Za-z]{3,}(?:${CLASS_BY_ENDING.map((x) => x[0]).join('|')})\b`, 'g');
const classOf = (w) => (CLASS_BY_ENDING.find(([e]) => w.toLowerCase().endsWith(e)) || [null, 'medication'])[1];

const heard = (key, T, tWords) => {
  if (T.includes(key)) return true;
  const tol = key.length >= 9 ? 2 : 1;
  return tWords.some((w) => Math.abs(w.length - key.length) <= tol && lev(w, key) <= tol);
};

/** A word like "rovastatin" next to the spoken brand "Crestor" (= rosuvastatin) is the same drug: one name everywhere. */
export function unifySpellings(note, transcript, refMeds = []) {
  const T = String(transcript || '').toLowerCase(); const tWords = [...new Set(T.match(/[a-z]{6,20}/g) || [])]; const done = [];
  for (const m of refMeds) {
    for (const g of String(m?.generic || '').toLowerCase().split(' / ').map(letters).filter((x) => x.length >= 6)) {
      for (const w of tWords) {
        if (w === g || w === letters(m.spoken) || sim(w, g) < 0.8 || w[0] !== g[0]) continue;
        const rx = new RegExp('\\b' + w + '\\b', 'gi'); let n = 0;
        for (const f of fields(note)) { const v = String(f.obj[f.key]); if (rx.test(v)) { rx.lastIndex = 0; f.obj[f.key] = v.replace(rx, (x) => { n++; return x[0] === x[0].toUpperCase() ? cap(g) : g; }); } }
        if (n) { done.push({ from: w, to: g, n }); if (note.metadata?.flags) note.metadata.flags = note.metadata.flags.filter((f) => !(f.type === 'medication_unverified' && new RegExp('Heard "' + w + '"', 'i').test(String(f.message)))); }   // the "kept as spoken" flag is stale once the name is unified
      }
    }
  }
  return done;
}

export function unheardDrugs(note, transcript, refMeds = []) {
  const T = String(transcript || '').toLowerCase(); const tWords = [...new Set(T.match(/[a-z]{5,20}/g) || [])];
  const okGeneric = new Set(refMeds.flatMap((m) => String(m?.generic || '').toLowerCase().split(' / ').map(letters)));
  const done = [];
  for (const f of fields(note)) {
    const v = String(f.obj[f.key]); if (!DRUGISH.test(v)) { DRUGISH.lastIndex = 0; continue; } DRUGISH.lastIndex = 0;
    f.obj[f.key] = v.replace(DRUGISH, (w, off) => {
      const k = letters(w); if (okGeneric.has(k) || heard(k, T, tWords)) return w;
      const before = v.slice(Math.max(0, off - 2), off); if (before.endsWith('(')) return w;   // "Crestor (rosuvastatin)": the generic of a spoken brand
      const cls = classOf(w); const shown = cls === 'medication' ? 'medication (name not heard)' : cls;
      done.push({ drug: w, shown }); return shown;
    });
  }
  for (const d of done) flag(note, 'drug_not_heard', `"${d.drug}" was in the draft but the recording does not name the drug. Written as "${d.shown}" - check which drug was prescribed.`, 'warning');
  return done;
}

// ── 4. tests and procedures nobody mentioned ─────────────────────────────────────────────────────────────────────────────────────────
const TESTS = ['sleep study', 'polysomnography', 'mri', 'ct scan', 'cat scan', 'ultrasound', 'x-ray', 'colonoscopy', 'endoscopy', 'gastroscopy', 'biopsy', 'echocardiogram', 'stress test', 'holter', 'bone density', 'dexa scan', 'pet scan', 'angiogram', 'spirometry', 'allergy testing'];
export function unheardTests(note, transcript) {
  const T = String(transcript || '').toLowerCase(); const flat = T.replace(/[^a-z0-9]/g, ''); const removed = [];
  const said = (term) => flat.includes(term.replace(/[^a-z0-9]/g, '')) || (term === 'ct scan' && /\bct\b/.test(T)) || (term === 'cat scan' && /\bcat scan\b/.test(T)) || (term === 'x-ray' && /\bx ?ray/.test(T)) || (term === 'echocardiogram' && /\becho\b/.test(T));
  const gone = TESTS.filter((t) => !said(t));
  if (!gone.length) return removed;
  for (const f of fields(note)) {
    if (!f.plan) continue;
    const next = pieces(f).map((clause) => {
      let c = clause; let hit = null;
      for (const t of gone) {
        const rx = new RegExp(String.raw`(?:\b(?:referral|refer(?:red)?|consider|arrange|order)\s+(?:for|to)\s+)?(?:a\s+|an\s+)?\b${t.replace(/[-\s]/g, '[- ]?')}\b(?:\s+(?:or|and)\s+)?`, 'i');
        if (rx.test(c)) { hit = t; c = c.replace(rx, '').replace(/\s{2,}/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, ''); }
      }
      if (!hit) return clause;
      removed.push({ test: hit, clause });
      const label = (clause.match(/^\s*([A-Z][A-Za-z ]{2,30}:)\s*/) || [])[1];
      return c && c.length > (label || '').length + 3 ? cap(c) : null;
    });
    if (removed.length && next.some((x, i) => x !== pieces(f)[i])) setPieces(f, next);
  }
  for (const r of removed) flag(note, 'removed_unsupported', `"${r.clause.slice(0, 120)}" - "${r.test}" is not in the recording`, 'warning');
  return removed;
}

// ── 5. tidy ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const HEADING = /^\s*(?:[-•*]\s*)?[A-Za-z][A-Za-z &/,'-]{1,50}:\s*$/;
export function dropEmptyHeadings(note) {
  const subj = fields(note).filter((f) => f.where === 'subjective'); const lines = [];
  subj.forEach((f) => pieces(f).forEach((text, i) => lines.push({ f, i, text })));
  const dead = new Set();
  const next = (from) => { for (let j = from + 1; j < lines.length; j++) if (lines[j].text.trim() !== '') return lines[j]; return null; };
  lines.forEach((l, idx) => { if (HEADING.test(l.text)) { const n = next(idx); if (!n || HEADING.test(n.text)) dead.add(l); } });
  for (const f of subj) { const mine = pieces(f); const out = mine.map((t, i) => (lines.some((l) => dead.has(l) && l.f === f && l.i === i) ? null : t)); if (out.some((x, i) => x !== mine[i])) setPieces(f, out); }
  return [...dead].map((l) => l.text.trim());
}

const STOOL = /\b(?:fit|fobt|stool|faecal|fecal|poop)\b[^;\n]{0,20}\b(?:kit|test)\b|\b(?:fit|fobt)\b/i;
export function tidyPlanLines(note) {
  const out = { poop: 0, duplicates: 0, vaccines: 0 };
  for (const p of note?.assessment_and_plan || []) {
    for (const k of PLAN) if (typeof p?.[k] === 'string') { const n = p[k].replace(/\bpoop (test|kit)\b/gi, (m, w) => { out.poop++; return 'stool ' + w; }); p[k] = n; }
    // vaccines are treatment, not investigations
    if (typeof p.investigations_planned === 'string' && p.investigations_planned.trim()) {
      const keep = [], move = [];
      for (const c of cl(p.investigations_planned)) (/\b(?:tetanus|vaccin\w*|immuni[sz]ation|booster)\b/i.test(c) && !/\b(?:blood|titre|titer|screen|test)\b/i.test(c) ? move : keep).push(c);
      if (move.length) { out.vaccines += move.length; put(p, 'investigations_planned', keep); const have = /\b(?:tetanus|vaccin\w*|immuni[sz]ation|booster)\b/i.test(String(p.treatment_planned || '')); if (!have) p.treatment_planned = [p.treatment_planned, ...move.map((m) => (/^(?:administer|give|given|treatment)/i.test(m) ? m : 'Administer ' + m.replace(/^[A-Z]/, (c) => c.toLowerCase())))].filter((x) => x && String(x).trim()).join('; '); }
    }
    // a stool test named twice in one problem is written once
    let seen = false;
    for (const k of ['investigations_planned', 'treatment_planned']) if (typeof p?.[k] === 'string' && p[k].trim()) {
      const keep = cl(p[k]).filter((c) => { if (!STOOL.test(c)) return true; if (!seen) { seen = true; return true; } out.duplicates++; return false; });
      put(p, k, keep);
    }
    // a referral already written in the investigations or treatment line is not repeated in Referrals
    if (typeof p.referrals === 'string' && p.referrals.trim()) {
      const other = letters([p.investigations_planned, p.treatment_planned].join(' '));
      const keep = cl(p.referrals).filter((c) => { const k = letters(c.replace(/^(?:referral|referred|refer)\s+(?:to|for)\s+/i, '')); if (k.length >= 5 && other.includes(k)) { out.duplicates++; return false; } return true; });
      put(p, 'referrals', keep);
    }
  }
  return out;
}

const cl = (v) => String(v || '').split(/\n|; /).map((x) => x.trim()).filter(Boolean);
const put = (p, k, list) => { p[k] = list.join(/\n/.test(String(p[k])) ? '\n' : '; '); };

// ── 6. same drug listed twice, diet already in the story, numbers the recording never says, MRI wording ─────────────────────────────────
export function dedupeMedList(note) {
  const dropped = [];
  for (const f of fields(note)) {
    if (f.where !== 'pmh') continue;
    const mine = pieces(f);
    const out = mine.map((line) => {
      const m = line.match(/^(\s*(?:[-•*]\s*)?medications?\s*:\s*)(.+)$/i); if (!m) return line;
      const seen = new Set(); const keep = [];
      for (const item of m[2].split(/,\s+/)) {
        const key = letters(item.replace(/\(.*?\)/g, '').replace(/\s\d.*$/, '')); const gens = [...item.matchAll(/\(([^)]+)\)/g)].map((x) => letters(x[1]));
        if (key && seen.has(key)) { dropped.push(item); continue; }
        if (key) seen.add(key); gens.forEach((g) => seen.add(g)); keep.push(item);
      }
      return keep.length === m[2].split(/,\s+/).length ? line : m[1] + keep.join(', ');
    });
    if (out.some((x, i) => x !== mine[i])) setPieces(f, out);
  }
  return dropped;
}

const LIFESTYLE = /\b(?:coffee|caffeine|soda|gatorade|tea|tomato\w*|diet\w*|drinks?|drinking|eats?|meals?|breakfast)\b/i;
export function dropDietRepeats(note) {
  const subj = fields(note).filter((f) => f.where === 'subjective').map((f) => String(f.obj[f.key])).join(' ').toLowerCase(); const dropped = [];
  for (const f of fields(note)) {
    if (f.where !== 'pmh') continue;
    const mine = pieces(f);
    const out = mine.map((line) => {
      const body = line.replace(/^\s*[-•*]\s*/, ''); if (!LIFESTYLE.test(body) || /^(?:medications?|allergies|preventive)/i.test(body)) return line;
      const words = body.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !['daily', 'approximately', 'denies', 'drinks', 'about'].includes(w));
      if (words.length < 2 || words.filter((w) => subj.includes(w.slice(0, 6))).length / words.length < 0.7) return line;
      dropped.push(body); return null;
    });
    if (out.some((x, i) => x !== mine[i])) setPieces(f, out);
  }
  return dropped;
}

const UNIT = /(\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?)\s*(?:mg|mcg|g|ml|units?|days?|weeks?|months?|years?|times|tablets?|capsules?|puffs?|hours?|%|degrees)\b/gi;
/** A dose or a duration in the plan that the recording never says is flagged (never removed: "one and a half" and similar spoken forms are not all understood). */
export function numberFlags(note, transcript, missing) {
  const found = [];
  for (const f of fields(note)) {
    if (!f.plan) continue;
    for (const line of pieces(f)) { for (const m of line.matchAll(UNIT)) { const bad = missing(m[1], transcript); if (bad.length) found.push({ line: line.trim(), num: m[1] }); } }
  }
  const seen = new Set(); const uniq = found.filter((x) => (seen.has(x.line + x.num) ? false : (seen.add(x.line + x.num), true))).slice(0, 4);
  for (const x of uniq) flag(note, 'check_against_recording', `"${x.line.slice(0, 110)}" - the number ${x.num} is not in the recording`, 'warning');
  return uniq;
}

/** Whether an implant is MRI compatible is safety-critical; when the recording is not clear about it, the wording is flagged. */
export function mriCheck(note, transcript) {
  if (/\bmri[ -](?:compatible|safe|conditional)\b|\bcompatible with (?:an )?mri\b/i.test(transcript)) return [];
  const rx = /\bMRI\b[^.;\n]{0,40}\b(?:compatib\w*|safe|unsafe|conditional)\b|\b(?:compatib\w*|incompatib\w*|non-MRI)\b[^.;\n]{0,40}\bMRI\b|\bnon[- ]MRI\b/i;
  const hit = fields(note).flatMap((f) => pieces(f)).find((l) => rx.test(l)); if (!hit) return [];
  flag(note, 'check_against_recording', `"${hit.trim().replace(/^[-•*]\s*/, '').slice(0, 110)}" - the recording is not clear about MRI compatibility of the hardware. Confirm it from the operative record.`, 'warning');
  return [hit.trim()];
}

const SCREEN_WORDS = [['mammogram', /mammo/i], ['pap', /\bpap\b|cervical/i], ['stool', /stool|\bfit\b|fobt|faecal|fecal|colonoscopy/i], ['tetanus', /tetanus/i], ['vaccine', /vaccin|immuni[sz]/i], ['screening', /screening/i]];
export function dropCoveredScreeningStatus(note) {
  const planText = (note?.assessment_and_plan || []).map((p) => [p.issue, p.diagnosis, ...PLAN.map((k) => p[k])].join(' ')).join(' ');
  const dropped = [];
  for (const f of fields(note)) {
    if (f.where !== 'pmh') continue;
    const mine = pieces(f);
    const out = mine.map((line) => {
      const body = line.replace(/^\s*[-•*]\s*/, '');
      if (!/^(?:preventive care|tetanus|immuni[sz]ation|vaccin\w*|mammogram|pap|stool test|fit\b|colonoscopy|screening)/i.test(body)) return line;
      const words = SCREEN_WORDS.filter(([, rx]) => rx.test(body));
      if (!words.length || !words.every(([, rx]) => rx.test(planText))) return line;
      dropped.push(body); return null;
    });
    if (out.some((x, i) => x !== mine[i])) setPieces(f, out);
  }
  return dropped;
}

/** Runs all guards. Returns what each one did (for the trace); never throws. */
export function fidelityGuards(note, transcript, { refMeds = [], log = () => {}, missing = () => [] } = {}) {
  const r = {};
  const run = (name, fn) => { try { r[name] = fn(); } catch (e) { log(`[v2:fidelity] ${name} skipped - ${e.message}`); } };
  run('spellings', () => unifySpellings(note, transcript, refMeds));
  run('social', () => socialGuard(note, transcript));
  run('drugs', () => unheardDrugs(note, transcript, refMeds));
  run('tests', () => unheardTests(note, transcript));
  run('headings', () => dropEmptyHeadings(note));
  run('plan', () => tidyPlanLines(note));
  run('screening', () => dropCoveredScreeningStatus(note));
  run('medlist', () => dedupeMedList(note));
  run('diet', () => dropDietRepeats(note));
  run('numbers', () => numberFlags(note, transcript, missing));
  run('mri', () => mriCheck(note, transcript));
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  log(`[v2:fidelity] spellings ${n(r.spellings)} · social ${n(r.social)} · unheard drugs ${n(r.drugs)} · unheard tests ${n(r.tests)} · empty headings ${n(r.headings)} · plan tidy ${JSON.stringify(r.plan || {})} · screening lines ${n(r.screening)}`);
  return r;
}
