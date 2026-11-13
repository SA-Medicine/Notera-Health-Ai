// Fidelity gate (2026-11-13, owner: "hallucination in medical notes cannot happen"). Unlocked layer on the FINISHED note: env FIDELITY_GATE=1, fails closed,
// writer prompt and locked files untouched. It targets what the 35-note audit found slipping past the grounding agent, where every key word IS somewhere in the
// transcript but the claim is not true of this visit.
//
//  A. DRUG NOT SAID   a medicine named in the note that nothing in the recording sounds like (not the name, not a 1-2 letter mis-hearing, not a brand/generic pair,
//                     not the patient's own list). Case: "Cardizem CD 10 mg" written from "Avapro ... Micardis plus" heard as "Avel ... card is plus". Code only.
//  B. IMPOSSIBLE VALUE  A1C below 3.5 or above 20, blood pressure or pulse no human has ("A1C 2.9" copied from a mis-heard "6.9"). Code only.
//  C. YEAR NOT SAID   "since 2019" when the recording never says that year. Code only.
//  D. CLAIM JUDGE     plan actions written as DONE ("provided", "arranged", "signed", "faxed", "printed", "administered"), "Denies/No ..." lines and exam findings.
//                     ONE model call returns, per line, ok / only_discussed (it was offered, conditional, asked about, or earlier) / not_said. The model never edits.
//                     only_discussed counts only with a quote that code finds in the transcript and that shares a content word with the line;
//                     not_said counts only when most of the line's content words are missing from the transcript.
// Clean-note accounts (no flags) get the unsupported part removed (only the ';' part that holds it, else the line); other accounts get a flag for the doubtful
// and a removal only where code itself proved it (A, B, C, not_said). A safety cap leaves the note alone, with flags, when too many lines would go.
// Everything is in note.metadata.fidelityGate. Never logs note or transcript text.
'use strict';

import { drugsInNote } from './drugCheck.js';
import { COMMON, lev } from './wordRepair.js';

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const BULLET = /^(\s*(?:[-•*]|\d+\.)\s+)(.*\S)\s*$/;

// brand <-> generic pairs a note may legitimately use when only one of them was said (kept short on purpose; anything else is judged by sound)
const PAIRS = [['ozempic', 'semaglutide', 'rybelsus'], ['jardiance', 'empagliflozin'], ['synjardy', 'empagliflozin', 'metformin'], ['mounjaro', 'monjaro', 'tirzepatide'], ['farxiga', 'forxiga', 'dapagliflozin'], ['tylenol', 'acetaminophen', 'paracetamol'],
  ['lipitor', 'atorvastatin'], ['crestor', 'rosuvastatin'], ['zocor', 'simvastatin'], ['norvasc', 'amlodipine'], ['diovan', 'valsartan'], ['cozaar', 'losartan'], ['avapro', 'irbesartan'], ['micardis', 'telmisartan'], ['atacand', 'candesartan'], ['coversyl', 'perindopril'],
  ['plavix', 'clopidogrel'], ['eliquis', 'apixaban'], ['xarelto', 'rivaroxaban'], ['synthroid', 'eltroxin', 'levothyroxine'], ['zoloft', 'sertraline'], ['lexapro', 'cipralex', 'escitalopram'], ['cymbalta', 'duloxetine'], ['effexor', 'venlafaxine'], ['wellbutrin', 'bupropion'], ['seroquel', 'quetiapine'],
  ['prozac', 'fluoxetine'], ['paxil', 'paroxetine'], ['xanax', 'alprazolam'], ['ativan', 'lorazepam'], ['valium', 'diazepam'], ['lasix', 'furosemide'], ['januvia', 'sitagliptin'], ['trajenta', 'linagliptin'], ['victoza', 'liraglutide'], ['nexium', 'esomeprazole'], ['losec', 'prilosec', 'omeprazole'],
  ['pantoloc', 'protonix', 'pantoprazole'], ['vyvanse', 'lisdexamfetamine'], ['sublocade', 'buprenorphine', 'suboxone'], ['estrogel', 'estradiol', 'estrace'], ['ketoderm', 'nizoral', 'ketoconazole'], ['orajel', 'benzocaine'], ['advil', 'motrin', 'ibuprofen'], ['aleve', 'naproxen'], ['flexeril', 'cyclobenzaprine'],
  ['ventolin', 'salbutamol', 'albuterol'], ['singulair', 'montelukast'], ['zyrtec', 'reactine', 'cetirizine'], ['benadryl', 'diphenhydramine'], ['gravol', 'dimenhydrinate'], ['lyrica', 'pregabalin'], ['neurontin', 'gabapentin'], ['flomax', 'tamsulosin'], ['viagra', 'sildenafil'], ['cialis', 'tadalafil']];
const PAIR_OF = new Map(); for (const g of PAIRS) for (const w of g) PAIR_OF.set(w, g);

/** Is a drug name (first word) said, or mis-heard by a letter or two, anywhere in the recording? */
export function drugSaid(term, transcript, { patientMeds = [] } = {}) {
  const key = letters(String(term).split(' ')[0]); if (key.length < 5) return true;   // too short to judge: leave it
  const words = norm(transcript).split(' ').filter(Boolean); const maxD = key.length >= 10 ? 3 : 2;
  // said = a word (or 2-3 words run together: "at a cand" = "atacand") within 1-2 letters of the name, a longer name built on a said word ("cortisone" for "hydrocortisone"),
  // or the start of the name said whole (5+ letters: "amlodip"). A shared first five letters alone is NOT enough: "card is plus" must not vouch for "Cardizem".
  const near = (k) => { const lim = k.length >= 10 ? 3 : 2;
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 3 && i + n <= words.length; n++) { const w = letters(words.slice(i, i + n).join('')); if (w.length < 4) continue; if (Math.abs(w.length - k.length) <= lim && lev(w, k) <= lim) return true; if (n === 1 && w.length >= 5 && (k.includes(w) || w.includes(k) || k.startsWith(w))) return true; if (n === 1 && w.length >= 6 && (k.includes(w.slice(0, 6)) || k.slice(0, 6) === w.slice(0, 6))) return true; }
    } return false; };
  if (near(key)) return true;
  for (const m of patientMeds || []) { const pk = letters(String(m).split(/\s+\d/)[0]); if (pk && (pk.slice(0, 5) === key.slice(0, 5) || lev(pk, key) <= maxD)) return true; }
  const grp = PAIR_OF.get(key); if (grp && grp.some((g) => g !== key && near(g))) return true;
  return false;
}

/** Cut `rx` out of a bullet line: a ';' or ',' part when the line has several (a "Medications:" list), otherwise the whole line. Returns the new line or null. */
function cutPart(line, rx) {
  const m = line.match(BULLET); if (!m) return null;
  const body = m[2]; const head = body.match(/^(Medications?:\s*)(.*)$/i);
  const parts = head ? head[2].split(/,\s*/) : body.split(/;\s*/);
  if (parts.length > 1) { const keep = parts.filter((p) => !rx.test(p)); if (!keep.length) return null; if (keep.length < parts.length) return m[1] + (head ? head[1] + keep.join(', ') : keep.join('; ')); }
  return rx.test(body) ? null : line;
}
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── A: drugs not said ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const VERB_DRUG = /^(?:start(?:ed)?|begin|began|stop(?:ped)?|continue[d]?|increase[d]?|decrease[d]?|reduce[d]?|change[d]?|switch(?:ed)?|restart(?:ed)?|prescribe[d]?|refill(?:ed)?|renew(?:ed)?|resume[d]?|discuss(?:ed)?|trial(?:led)?)\s+(?:to\s+)?(?:on\s+)?([A-Za-z][A-Za-z-]{4,})/i;
export function unsaidDrugs(md, transcript, { patientMeds = [], lexicon = null } = {}) {
  const found = new Map();   // key -> { term, lines: Set(idx) }
  const lines = String(md || '').split('\n');
  const add = (term, idx) => { const k = letters(term.split(' ')[0]); if (k.length < 5) return; if (!found.has(k)) found.set(k, { term: term.split(' ')[0], idxs: new Set() }); found.get(k).idxs.add(idx); };
  for (const d of drugsInNote(md)) lines.forEach((l, i) => { if (l.includes(d.line.trim().slice(0, 40)) || l === d.line) add(d.term, i); });
  lines.forEach((l, i) => { for (const w of l.match(/[A-Za-z][A-Za-z-]{4,}/g) || []) if (COMMON.has(w.toLowerCase())) add(w, i); });
  // "Start Cardizem CD 10 mg": the word after a prescribing verb counts when RxNorm (or the common list) knows it as a drug
  lines.forEach((l, i) => { const b = l.match(BULLET); const v = b && b[2].match(VERB_DRUG); if (v && (COMMON.has(v[1].toLowerCase()) || (lexicon?.set && lexicon.set.has(letters(v[1]))))) add(v[1], i); });
  const out = [];
  for (const [, v] of found) if (!drugSaid(v.term, transcript, { patientMeds })) out.push({ term: v.term, idxs: [...v.idxs] });
  return out;
}

// ── B: impossible values ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function impossibleValues(line) {
  const out = [];
  const a = line.match(/\b(?:hba1c|a1c|hemoglobin a1c)\b\D{0,14}(\d+(?:\.\d+)?)/i); if (a) { const v = Number(a[1]); if (v < 3.5 || v > 20) out.push({ kind: 'A1C', value: a[1], rx: new RegExp(`(?:hba1c|a1c|hemoglobin a1c)\\D{0,14}${escRx(a[1])}`, 'i') }); }
  const bp = line.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/); if (bp && /\b(?:bp|blood pressure|systolic)\b/i.test(line)) { const s = Number(bp[1]), d = Number(bp[2]); if (s < 60 || s > 260 || d < 30 || d > 150 || d >= s) out.push({ kind: 'blood pressure', value: bp[0], rx: new RegExp(escRx(bp[0])) }); }
  const hr = line.match(/\b(?:heart rate|hr|pulse)\b\D{0,10}(\d{2,3})\b/i); if (hr) { const v = Number(hr[1]); if (v < 25 || v > 220) out.push({ kind: 'pulse', value: hr[1], rx: new RegExp(`(?:heart rate|hr|pulse)\\D{0,10}${escRx(hr[1])}`, 'i') }); }
  return out;
}

// ── C: years not said ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words99 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
export function yearSaid(year, transcript) {
  const t = norm(transcript); if (new RegExp(`\\b${year}\\b`).test(t)) return true;
  const tail = year % 100; const w = tail ? words99(tail) : 'hundred';
  const forms = year >= 2000 ? [`twenty ${tail ? w : ''}`, `two thousand ${tail ? 'and ' + w : ''}`, `two thousand ${tail ? w : ''}`] : [`nineteen ${tail ? w : ''}`];
  if (year === 2000) return /\btwo thousand\b/.test(t);
  return forms.some((f) => f.trim() && t.includes(f.trim()));
}
const YEAR_RX = /(\s*(?:\b(?:since|in|from|during|dated|diagnosed in|started in|around)\s+)?)\b((?:19|20)\d\d)\b/g;

// ── E: a diagnosis in Past Medical History that nobody says ─────────────────────────────────────────────────────────────────────────────────────
// "Dysglycemia" written from "your sugar is better too": no diabetes, no sugar medicine, no test for it. A bare diagnosis in PMH stays only when the recording says it, or says
// something that only a patient WITH it would say (a drug, a test, the name of the condition in plain words). A family that matches the diagnosis decides; with no family, a medical-sounding
// word (-emia, -osis, -itis, -pathy ...) none of whose letters appear in the recording is removed. Plain symptoms and anything else are left alone.
const FAMILIES_PMH = [
  { key: /hypertens|high blood pressure/i, proof: /hypertens|blood pressure|bp|\w*(?:sartan|pril|dipine|olol|thiazide)\b|diltiazem|verapamil|spironolactone|indapamide|coversyl|diovan|norvasc|lisinopril/i },
  { key: /dysglyc|hyperglyc|prediab|diabet|glucose intoler|insulin resist/i, proof: /diabet|prediab|dysglyc|hyperglyc|\ba1c\b|metformin|insulin|ozempic|semaglutide|jardiance|farxiga|januvia|gliclazide|glyburide|glimepiride|glucometer|lantus|sugar (?:pill|medic)|high sugar/i },
  { key: /lipid|cholesterol|triglycerid/i, proof: /cholesterol|lipid|triglycerid|\w*statin\b|crestor|lipitor|ezetimibe|fenofibrate/i },
  { key: /hypothyroid|thyroid/i, proof: /thyroid|levothyrox|synthroid|eltroxin|\btsh\b/i },
  { key: /uric|gout/i, proof: /uric|gout|allopurinol|colchicine|febuxostat/i },
  { key: /an(?:a)?emi|iron defic/i, proof: /an(?:a)?emi|iron|ferritin|hemoglobin|haemoglobin|\bhb\b|b12/i },
  { key: /depress|anxi/i, proof: /depress|anxi|mood|panic|sertraline|escitalopram|fluoxetine|venlafaxine|duloxetine|therap(?:y|ist)/i },
  { key: /asthma|copd|emphysema/i, proof: /asthma|copd|emphysema|puffer|inhaler|ventolin|salbutamol|symbicort|wheez/i },
  { key: /reflux|gerd/i, proof: /reflux|gerd|heartburn|omeprazole|pantoprazole|esomeprazole|antacid/i },
  { key: /kidney|renal|\bckd\b/i, proof: /kidney|renal|creatinine|egfr|nephrolog/i },
  { key: /osteopor|osteopen/i, proof: /osteopor|osteopen|bone density|fosamax|alendronate|calcium|dexa/i },
  { key: /arthrit/i, proof: /arthrit|joint|finger|knuckle|knee|stiff|swollen/i },
  { key: /migraine/i, proof: /migraine|headache/i },
  { key: /obes|overweight/i, proof: /obes|overweight|weight/i },
  { key: /sleep apn|apn(?:o)?ea/i, proof: /apn(?:o)?ea|cpap|snor/i },
  { key: /atrial fib|a-?fib|heart failure|coronary|\bcad\b/i, proof: /heart|cardi|atrial|fibrillation|stent|bypass|angina|eliquis|apixaban|warfarin|xarelto/i },
];
const DX_SUFFIX = /(?:a?emia|osis|itis|pathy|plasia|algia|penia|uria|oma|trophy|sclerosis)$/i;
const PMH_SKIP = /^(?:medications?|allerg|social|family|surgical|surgeries|smok|alcohol|occupation|no\b|nil|denies|not\b)/i;
export function unsupportedDiagnoses(md, transcript) {
  const lines = String(md || '').split('\n'); const out = []; let sec = ''; const t = String(transcript || ''); const tw = norm(t).split(' ').filter((w) => w.length >= 4);
  lines.forEach((ln, idx) => {
    const h = ln.match(/^###\s+(.*)$/); if (h) { sec = h[1].trim().toLowerCase(); return; }
    if (!/past medical|medical history|\bpmh\b/.test(sec)) return;
    const b = ln.match(BULLET); if (!b) return; const text = b[2].replace(/[.;]+$/, '').trim();
    if (PMH_SKIP.test(text) || text.split(/\s+/).length > 5) return;   // a bare diagnosis only
    const fam = FAMILIES_PMH.find((f) => f.key.test(text));
    if (fam) { if (!fam.proof.test(t)) out.push({ idx, text, why: 'nobody in the recording says it, takes a medicine for it or has it tested' }); return; }
    const dx = text.split(/\s+/).find((w) => DX_SUFFIX.test(w)); if (!dx) return;
    const root = letters(dx).slice(0, 6);
    if (!tw.some((w) => w.slice(0, 6) === root || (w.length >= 6 && (lev(w, letters(dx)) <= 2 || letters(dx).includes(w) || w.includes(letters(dx)))))) out.push({ idx, text, why: 'the diagnosis is never mentioned in the recording' });
  });
  return out;
}

// ── F: the same lab with two values: the one said once, next to filler, is a mis-hearing ─────────────────────────────────────────────────────────
// "Hb 128" and "Hemoglobin: 158" in one note; the recording opens "Yeah, the hemoglobin is 158. I don't know. what I do..." and later says 128 twice ("it was 128 ... today it's 128").
const LABS = { hemoglobin: 'hb|hgb|hemoglobin|haemoglobin', a1c: 'a1c|hba1c', 'uric acid': 'uric acid', glucose: 'glucose|blood sugar', creatinine: 'creatinine', ldl: 'ldl', hdl: 'hdl', triglycerides: 'triglycerides?', cholesterol: 'total cholesterol|cholesterol', tsh: 'tsh', ferritin: 'ferritin', egfr: 'egfr', potassium: 'potassium', sodium: 'sodium', 'vitamin d': 'vitamin d', b12: 'b12|vitamin b12', inr: 'inr', psa: 'psa' };
const LAB_RXS = Object.entries(LABS).map(([lab, alt]) => [lab, new RegExp(String.raw`\b(?:${alt})\b[^0-9;]{0,18}?(?<![\d.])(\d+(?:\.\d+)?)(?!\d)`, 'ig')]);
const TREND_CUE = /\b(?:from|to|was|were|prior|previous|previously|last|before|earlier|baseline|improved|decreased|increased|dropped|rose|up|down|vs|versus|goal|target|today|now|currently)\b/i;
const FILLER = new Set('um uh uhm hmm huh yeah okay ok so like know don t oh well right mhm mm what'.split(' '));
const countNum = (t, v) => (String(t).match(new RegExp(`(?<![\\d.])${escRx(v)}(?![\\d]|\\.\\d)`, 'g')) || []).length;
function fillerAround(t, v, span = 8) {
  const words = norm(t).split(' '); const i = words.indexOf(norm(v)); if (i < 0) return 0;
  const win = words.slice(Math.max(0, i - span), i).concat(words.slice(i + 1, i + 1 + span)); return win.length ? win.filter((w) => FILLER.has(w)).length / win.length : 0;
}
export function labConflicts(md, transcript) {
  const t = String(transcript || ''); const seen = [];
  String(md || '').split('\n').forEach((ln, idx) => {
    const b = ln.match(BULLET); if (!b) return;
    b[2].split(/;\s*/).forEach((seg, si) => { for (const [lab, rx] of LAB_RXS) { rx.lastIndex = 0; let m; while ((m = rx.exec(seg))) seen.push({ lab, value: m[1], idx, si, seg }); } });
  });
  const byLab = new Map(); for (const s of seen) { if (!byLab.has(s.lab)) byLab.set(s.lab, []); byLab.get(s.lab).push(s); }
  const out = [];
  for (const [lab, arr] of byLab) {
    const vals = [...new Set(arr.map((s) => s.value))]; if (vals.length < 2) continue;
    const cnt = Object.fromEntries(vals.map((v) => [v, countNum(t, v)]));
    for (const v of vals) {
      const others = vals.filter((o) => o !== v);
      if (cnt[v] !== 1 || !others.some((o) => cnt[o] >= 2) || fillerAround(t, v) < 0.15) continue;
      const all = arr.filter((s) => s.value === v); const segs = all.filter((s) => !TREND_CUE.test(s.seg));   // a segment with a time or trend word ("last year ... was") is a different fact, never dropped
      if (segs.length && segs.length === all.length) out.push({ lab, drop: v, keep: others.filter((o) => cnt[o] >= 2), segs: segs.map((s) => ({ idx: s.idx, si: s.si })) });
    }
  }
  return out;
}

// ── G: two verbs stuck together ("Arrange Provide new prescriptions") ────────────────────────────────────────────────────────────────────────────
const V1 = 'Arrange|Provide|Request|Send|Start|Stop|Continue|Increase|Decrease|Order|Refer|Schedule|Book|Obtain|Review|Discuss|Monitor|Check|Change|Prescribe|Advise|Recommend|Counsel|Organize|Organise';
const V2 = 'Provide|Arrange|Send|Obtain|Prescribe|Advise|Recommend|Organize|Organise';
const DOUBLE_VERB = new RegExp(`(^|[;:]\\s*)(?:${V1})\\s+(${V2})\\s+(?=[a-z0-9])`, 'g');
/** "Arrange Provide new prescriptions" -> "Provide new prescriptions": the verb next to its object stays. Only at the start of a line or of a ';' part. */
export function fixDoubleVerb(line) { const m = line.match(BULLET); if (!m) return line; const body = m[2].replace(DOUBLE_VERB, (all, lead, v2) => `${lead}${v2} `); return body === m[2] ? line : m[1] + body; }

// ── H: the same fact written twice in Subjective / Objective ─────────────────────────────────────────────────────────────────────────────────────
// Seema's note 4x15c: "B12 low-normal" and "B12: lower side of normal", "Thyroid: fine" beside "Bloods: hemoglobin normal; thyroid normal", the ultrasound result twice, the 6-week follow-up in both
// sections. A line whose every content word is already in another line of those two sections is dropped (the shorter one; equal ones keep the longer text). Words are compared by their first five
// letters with a few synonyms (fine/ok/normal, low/lower), numbers and left/right/no/not are never ignored, and a negated line never absorbs a positive one (or the reverse).
const REP_STOP = new Set('the of on in at to a an and or with for from is are was were has have had that this it as by be showed shows show described describes noted note reported reports states stated appearance appears seems side end level range today patient pt been also about'.split(' '));
const REP_NEG = new Set(['no', 'not', 'denies', 'denied', 'without', 'negative', 'never', 'nil', 'none']);
const REP_SYN = { fine: 'normal', ok: 'normal', okay: 'normal', unremarkable: 'normal', lower: 'low', lowest: 'low', higher: 'high' };
export function lineTokens(text) {
  const out = new Set();
  for (const raw of norm(text).split(' ')) { if (!raw) continue; const w = REP_SYN[raw] || raw; if (REP_STOP.has(w)) continue; out.add(/^\d/.test(w) || w.length <= 5 ? w : w.slice(0, 5)); }
  return out;
}
export function repeatedLines(md, { cap = 6 } = {}) {
  const lines = String(md || '').split('\n'); const cands = []; let sec = '';
  lines.forEach((ln, idx) => {
    const h = ln.match(/^###\s+(.*)$/); if (h) { sec = h[1].trim().toLowerCase(); return; }
    if (sec !== 'subjective' && sec !== 'objective') return;
    const b = ln.match(BULLET); if (!b) return; const tok = lineTokens(b[2]); if (tok.size < 2) return;
    // the first line of a group is its title ("Rash across stomach" above its details): it can absorb others but is never dropped itself
    const prev = lines[idx - 1] ?? ''; const next = lines[idx + 1] ?? ''; const title = (prev.trim() === '' || /^###/.test(prev)) && BULLET.test(next);
    cands.push({ idx, text: b[2], tok, title, neg: [...tok].some((w) => REP_NEG.has(w)) });
  });
  const dropped = new Set(); const out = [];
  const order = [...cands].sort((a, b) => a.tok.size - b.tok.size || b.idx - a.idx);   // smallest first; of equal size the later line goes first
  for (const a of order) {
    if (a.title || dropped.has(a.idx) || out.length >= cap) continue;
    const home = cands.find((b) => b !== a && !dropped.has(b.idx) && b.neg === a.neg && b.tok.size >= a.tok.size && [...a.tok].every((w) => b.tok.has(w))
      && !(b.tok.size === a.tok.size && (b.text.length < a.text.length || (b.text.length === a.text.length && b.idx > a.idx))));   // equal sets: keep the longer text, else the earlier line
    if (home) { dropped.add(a.idx); out.push({ idx: a.idx, text: a.text, keptIdx: home.idx, kept: home.text }); }
  }
  return out;
}

// ── D: claim judge ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ACTION = /\b(provided|arranged|signed|administered|faxed|printed|handed|booked|completed|performed|given|ordered|issued|sent|refilled|renewed|injected|applied)\b/i;
const NEGATIVE = /^(?:denies|denied|no|nil|negative for|not)\b/i;
const STOP = new Set('with that this have been were from they them their there which about after before patient patients visit today note noted discussed discussion reports reported states stated history regarding plan follow further would could should also again other some more than then when what where while into over only just very like'.split(' '));
const stems = (s) => [...new Set(norm(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w) && !ACTION.test(w)).map((w) => w.slice(0, 5)))];

// A line that is itself a plan, request or condition ("Clinic to notify patient once the appointment is booked", "Patient needs a form printed") does not claim the action happened.
const PLAN_STATEMENT = /^(?:follow[- ]?up|referral to|refer|arrange|send|request|clinic to|patient to|to be)\b|\b(?:once|when|until|if|will|to be|to notify|to send|should|can|may|needs?|wants?|wanted|requested|requests|asking|plan(?:ned)?)\b/i;
// the quote that backs an "only_discussed" verdict must itself show the doubt: a condition, a question, a dispute, an offer, someone else doing it
const DOUBT = /\b(?:if|whether|unless|maybe|might|could|would|do we|did i|did you|didn'?t|don'?t think|not sure|or not|want me to|you want|do you want|have (?:him|her|them)|someone else|last time|earlier|previous(?:ly)?)\b/i;
export const CLAIM_SYS = `You check lines of a clinic note against the transcript of the visit (the only truth). Speech recognition is imperfect, so judge meaning, not spelling.
For each numbered LINE return one verdict:
- "ok": the transcript says it, or clearly means it, as true of THIS visit. A clinician who says "I'll print the prescription", "I'm faxing it", "here is your paper", "I'll sign it" is doing it as part of the visit: that is "ok". Paraphrase and a mis-heard spelling are fine.
- "only_discussed": the transcript mentions it, but ONLY as something conditional ("if he does, have it faxed"), asked about or disputed ("did I give you one?" "I don't think you did"), offered but not accepted ("do you want me to..."), done by somebody else or at an EARLIER visit, or negated, while the line states it as done in this visit.
- "not_said": nothing in the transcript supports the line.
When in doubt answer "ok". Most lines are "ok". For "only_discussed" give "quote": the exact transcript words (at most 25) that show the doubt.
Return ONLY JSON: {"checks":[{"n":1,"verdict":"ok|only_discussed|not_said","quote":"","why":"short"}]}`;

/** Candidate lines for the judge: plan actions written as done, "Denies/No ..." lines and Objective findings. */
export function claimLines(md, { max = 24 } = {}) {
  const lines = String(md || '').split('\n'); const out = []; let sec = '';
  lines.forEach((ln, idx) => {
    const h = ln.match(/^###\s+(.*)$/); if (h) { sec = h[1].trim().toLowerCase(); return; }
    const b = ln.match(BULLET); if (!b) return; const text = b[2]; let kind = '';
    // Only plan actions written as done. "Denies ..." and exam lines were tried too: a patient's plain "no" reads as doubt to a judge (false removals on the first real run), and the grounding agent already covers them.
    if (/assessment|plan/.test(sec) && ACTION.test(text) && !PLAN_STATEMENT.test(text)) kind = 'action';
    if (kind) out.push({ idx, text, kind });
  });
  return out.slice(0, max);
}

/** Decide what to do with the model's answer. Pure: returns [{ ...cand, verdict, quote, act: 'remove'|'flag', why }]. */
export function parseClaims(raw, cands, transcript) {
  let j; try { j = JSON.parse(String(raw || '').replace(/^```(?:json)?|```$/g, '').trim()); } catch { return []; }
  const tn = norm(transcript); const tstems = new Set(norm(transcript).split(' ').filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));
  const acts = [];
  for (const c of j?.checks || []) {
    const cand = cands[(Number(c?.n) || 0) - 1]; if (!cand) continue;
    if (c.verdict === 'only_discussed') {
      const q = norm(c.quote); if (q.length < 12 || !tn.includes(q)) continue;   // the model must show where, and it must be real
      const need = stems(cand.text); const qs = new Set(q.split(' ').map((w) => w.slice(0, 5))); const verb = (cand.text.match(ACTION)?.[1] || '').toLowerCase().slice(0, 5);
      if (!need.some((s) => qs.has(s)) && !(verb && [...qs].some((s) => s === verb))) continue;   // the quote has to be about this line
      if (!DOUBT.test(String(c.quote))) continue;   // and has to show the doubt itself: "I'll print it" is not doubt
      acts.push({ ...cand, verdict: 'only_discussed', quote: String(c.quote).slice(0, 160), why: 'only discussed in the visit', strong: false });
    } else if (c.verdict === 'not_said') {
      const need = stems(cand.text); if (need.length < 2) continue;
      const missing = need.filter((s) => !tstems.has(s)).length / need.length;
      acts.push({ ...cand, verdict: 'not_said', quote: '', why: missing >= 0.6 ? 'nothing in the recording supports it' : 'not found in the recording', strong: missing >= 0.6 });
    }
  }
  return acts;
}

// ── the gate ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * → { md, meta, flags }. Mutates nothing else; `note` is only used to keep the structured copy in step for years/values (md is the source of truth).
 * `getLlm` is called at most once, only when a candidate line exists.
 */
export async function fidelityGate({ md, transcript, patientMeds = [], lexicon = null, clean = false, claimMode = 'shadow', getLlm = null, log = () => {}, cap = 4 }) {
  const meta = { drugs: [], values: [], years: [], pmh: [], labs: [], verbs: 0, repeats: [], claims: { checked: 0, removed: [], flagged: [] }, capped: false };
  const flags = []; let lines = String(md || '').split('\n'); const t = String(transcript || '');
  const flag = (type, field, message) => { if (!clean) flags.push({ type, field, severity: 'warning', message }); };
  const apply = (idx, rx) => { const next = cutPart(lines[idx], rx); lines[idx] = next; };   // null = line removed

  try {   // A
    for (const d of unsaidDrugs(lines.join('\n'), t, { patientMeds, lexicon })) {
      const rx = new RegExp(`(?<![A-Za-z-])${escRx(d.term)}(?![A-Za-z])`, 'i'); let n = 0;
      for (const i of d.idxs) if (lines[i] != null && rx.test(lines[i])) { apply(i, rx); n++; }
      if (n) { meta.drugs.push({ drug: d.term, lines: n }); flag('drug_not_said', 'medications', `"${d.term}" was written but is not said anywhere in the recording; the line was removed. Please check what was prescribed.`); log(`[v2:fidelity] drug "${d.term}" not in the recording - removed from ${n} line(s)`); }
    }
    lines = lines.filter((l) => l !== null);
  } catch (e) { log(`[v2:fidelity] drug check skipped - ${String(e.message).slice(0, 80)}`); }

  try {   // B
    lines.forEach((l, i) => { if (l == null) return; for (const v of impossibleValues(l)) { const next = cutPart(l, v.rx); lines[i] = next; meta.values.push({ kind: v.kind, value: v.value }); flag('implausible_value', 'objective', `${v.kind} "${v.value}" is not a possible value (probably mis-heard); it was removed. Please add the right value.`); log(`[v2:fidelity] impossible ${v.kind} ${v.value} removed`); if (next == null) break; l = next; } });
    lines = lines.filter((l) => l !== null);
  } catch (e) { log(`[v2:fidelity] value check skipped - ${String(e.message).slice(0, 80)}`); }

  try {   // C
    const thisYear = new Date().getFullYear();
    lines = lines.map((l) => {
      const m = l.match(BULLET); if (!m) return l; let changed = false;   // only the body of a line that really lost a year is touched; indentation (sub-bullets) stays
      const body = m[2].replace(YEAR_RX, (all, lead, y) => { const yr = Number(y); if (yr >= thisYear - 1 && yr <= thisYear + 1) return all; if (yearSaid(yr, t)) return all; meta.years.push(y); changed = true; return ''; });
      return changed ? m[1] + body.replace(/\s{2,}/g, ' ').replace(/\s+([,;.)])/g, '$1').trim() : l;
    });
    if (meta.years.length) { for (const y of meta.years) flag('year_not_said', 'subjective', `The year ${y} is not said in the recording; it was removed.`); log(`[v2:fidelity] year(s) not said removed: ${meta.years.join(', ')}`); }
  } catch (e) { log(`[v2:fidelity] year check skipped - ${String(e.message).slice(0, 80)}`); }

  try {   // E, F, G (added 2026-11-13 after Seema's note km7o4: "Dysglycemia", Hb 128 and 158, "Arrange Provide")
    const joined = lines.join('\n'); const badDx = unsupportedDiagnoses(joined, t); const labFix = labConflicts(joined, t);
    for (const d of badDx) {
      meta.pmh.push({ line: d.text, why: d.why });
      if (clean) lines[d.idx] = null; else flag('pmh_unsupported', 'past_medical_history', `"${d.text}" is in Past Medical History but ${d.why}. Please check it.`);
      log(`[v2:fidelity] PMH "${d.text.slice(0, 30)}" not supported by the recording${clean ? ' - removed' : ' - flagged'}`);
    }
    for (const c of labFix) {
      meta.labs.push({ lab: c.lab, dropped: c.drop, kept: c.keep });
      for (const { idx, si } of c.segs) {
        if (lines[idx] == null) continue; const m = lines[idx].match(BULLET); if (!m) continue; const parts = m[2].split(/;\s*/); parts.splice(si, 1);
        lines[idx] = parts.length ? m[1] + parts.join('; ').replace(/^./, (c) => c.toUpperCase()) : null;
      }
      flag('lab_conflict', 'objective', `${c.lab} was written as ${c.drop} and as ${c.keep.join(' / ')}; ${c.drop} is said once, in the middle of unclear speech, so it was removed. Please check the value.`);
      log(`[v2:fidelity] ${c.lab}: ${c.drop} dropped, ${c.keep.join('/')} kept`);
    }
    lines = lines.filter((l) => l !== null).map((l) => { const f = fixDoubleVerb(l); if (f !== l) meta.verbs++; return f; });
    const reps = repeatedLines(lines.join('\n'));   // H
    if (reps.length) {
      const gone = new Set(reps.map((r) => r.idx)); const kept = lines.filter((_, i) => !gone.has(i));
      lines = kept.filter((l, i) => !(l.trim() === '' && i > 0 && kept[i - 1].trim() === ''));   // a group of one line that goes leaves no double gap
      meta.repeats = reps.map((r) => ({ dropped: r.text.slice(0, 100), keptAs: r.kept.slice(0, 100) }));
      log(`[v2:fidelity] ${reps.length} repeated line(s) merged`);
    }
  } catch (e) { log(`[v2:fidelity] diagnosis, lab and verb checks skipped - ${String(e.message).slice(0, 80)}`); }

  try {   // D
    const text = lines.filter((l) => l !== null).join('\n'); const cands = claimLines(text); meta.claims.checked = cands.length;
    if (cands.length && getLlm && t.length > 80 && claimMode !== 'off') {
      const llm = await getLlm();
      const user = `TRANSCRIPT:\n${t.slice(0, 18000)}\n\nLINES:\n${cands.map((c, i) => `${i + 1}. [${c.kind}] ${c.text}`).join('\n')}\n\nReturn ONLY the JSON.`;
      const raw = await llm.generateContent(CLAIM_SYS, user, null, { maxOutputTokens: 1200, temperature: 0, timeoutMs: 20000, retries: 1, hedgeMs: 0, thinkingBudget: 0, responseMimeType: 'application/json' });
      const acts = parseClaims(raw, cands, t); const curLines = text.split('\n');
      if (claimMode !== 'act') {   // shadow (the default): measured on 35 real notes the judge was right on about 1 of 6 lines it doubted, so it only LOGS; the owner switches it to 'act' when it earns that
        meta.claims.shadow = acts.map((a) => ({ line: a.text.slice(0, 110), verdict: a.verdict, quote: a.quote }));
        return { md: lines.filter((l) => l !== null).join('\n'), meta, flags };
      }
      const removable = acts.filter((a) => (clean ? true : a.strong));   // non-clean accounts: only what code itself proved is removed, the rest is a flag
      const tooMany = removable.length > cap || removable.length > Math.max(1, Math.floor(cands.length * 0.25));
      if (tooMany) meta.capped = true;
      const drop = new Set();
      for (const a of acts) {
        const canRemove = removable.includes(a) && !tooMany;
        if (canRemove) { drop.add(a.idx); meta.claims.removed.push({ line: a.text.slice(0, 110), verdict: a.verdict, quote: a.quote, why: a.why }); log(`[v2:fidelity] removed ${a.kind} line (${a.verdict})`); }
        else { meta.claims.flagged.push({ line: a.text.slice(0, 110), verdict: a.verdict, why: a.why }); flag('claim_check', a.kind === 'action' ? 'plan' : a.kind === 'exam' ? 'objective' : 'subjective', `Please check "${a.text.slice(0, 90)}": the recording ${a.verdict === 'only_discussed' ? 'only discusses this (offered, planned or conditional)' : 'does not seem to say this'}.`); }
      }
      for (const a of acts) if (drop.has(a.idx)) curLines[a.idx] = cutPart(curLines[a.idx], a.kind === 'action' ? ACTION : /[\s\S]/);
      lines = curLines.filter((l) => l !== null);
    }
  } catch (e) { log(`[v2:fidelity] claim check skipped - ${String(e.message || e).slice(0, 80)}`); }

  return { md: lines.filter((l) => l !== null).join('\n'), meta, flags };
}
