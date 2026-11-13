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
  const meta = { drugs: [], values: [], years: [], claims: { checked: 0, removed: [], flagged: [] }, capped: false };
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
