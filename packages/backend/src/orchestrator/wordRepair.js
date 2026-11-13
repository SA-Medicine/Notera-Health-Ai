// Word repair (2026-11-12, owner: "fix the mis-heard words and invented problems, the major ones at least"; the doctor reported the same).
// Unlocked layer: runs on the finished note, env WORD_REPAIR=1, fails closed, the writer prompt is untouched. Two parts.
//
// 1. DRUG NAMES the speech engine garbled by one or two letters ("Symbalta", "Monjaro", "Mexalt", "pre-Gablin", "Deloxitine").
//    A name that RxNorm does not know is changed to a drug from the curated COMMON list only when
//      - exactly one common drug is that close (1 letter off, 2 for names of 10+ letters; c/s/k/z/q count as the same first sound),
//      - the heard name is not itself a known drug (a real brand the lists miss, such as Protopic, is added to COMMON, never "corrected"),
//      - the RxNorm name list is loaded (without it nothing is changed).
//    "Amopine" (is it amlodipine? amoxapine?) is NOT changed: two candidates, or none close enough. Ambiguity stays as heard.
// 2. SERIOUS WORDS (cancer, chemotherapy, stroke, heart attack, HIV, dementia, epilepsy, suicide ...).
//    a. The note line names one and the recording has no word of that family at all: the line is invented, code removes it.
//       (Negated lines, "no history of cancer", and problem titles are never removed here.)
//    b. The recording has the word but the context may show it is a mis-hearing ("I had cancer so I couldn't get there" = cancelled).
//       One model call labels only those lines (confirmed / mishear / unclear). Code acts on "mishear" only when the quote the model gives
//       is really in the transcript and contains the word. Clean-note accounts get the line removed; everyone else gets a flag.
// The model never writes note text. Everything done is stored in note.metadata.wordRepair and the flags.
'use strict';

import { drugsInNote } from './drugCheck.js';

// ── common drugs (generic + brand, US and Canada); a name here is "known" and is the only thing a garbled name can be repaired to ──
const COMMON_TEXT = `acetaminophen allopurinol alprazolam amiodarone amitriptyline amlodipine amoxicillin apixaban aripiprazole atenolol atorvastatin azithromycin baclofen bisoprolol bupropion buspirone candesartan carbamazepine carvedilol cefalexin cephalexin cetirizine ciprofloxacin citalopram clarithromycin clonazepam clonidine clopidogrel codeine colchicine cyclobenzaprine dapagliflozin diazepam diclofenac digoxin diltiazem diphenhydramine domperidone donepezil doxazosin doxycycline duloxetine empagliflozin enalapril escitalopram esomeprazole estradiol ezetimibe famotidine febuxostat fenofibrate finasteride fluconazole fluoxetine fluticasone furosemide gabapentin gliclazide glimepiride glyburide hydrochlorothiazide hydrocodone hydrocortisone hydromorphone hydroxychloroquine hydroxyzine ibuprofen indapamide insulin irbesartan isosorbide ketoconazole labetalol lamotrigine lansoprazole levetiracetam levocetirizine levofloxacin levothyroxine linagliptin liraglutide lisinopril lithium loratadine lorazepam losartan lovastatin meloxicam memantine metformin methotrexate methylphenidate metoprolol metronidazole mirtazapine montelukast morphine naproxen nifedipine nitrofurantoin nortriptyline olanzapine olmesartan omeprazole ondansetron oxybutynin oxycodone pantoprazole paroxetine penicillin perindopril pioglitazone pramipexole prasugrel pravastatin prednisone pregabalin propranolol quetiapine quinapril rabeprazole raloxifene ramipril ranitidine risperidone rivaroxaban rosuvastatin salbutamol semaglutide sertraline sildenafil simvastatin sitagliptin spironolactone sumatriptan tadalafil tamoxifen tamsulosin telmisartan terbinafine ticagrelor tirzepatide topiramate tramadol trazodone valacyclovir valsartan venlafaxine verapamil warfarin zolpidem zopiclone anastrozole letrozole alendronate risedronate rizatriptan zolmitriptan tacrolimus cortisone prednisolone mometasone betamethasone clobetasol hydroquinone tretinoin isotretinoin adapalene
advair aricept ativan atacand abilify amaryl arcoxia atarax benadryl biaxin buspar celebrex celexa cialis cipralex cipro clarinex coumadin coversyl cozaar crestor cymbalta diovan dilantin eliquis effexor entresto evista exforge farxiga flomax flonase flovent forxiga fosamax gravol humalog humulin hyzaar imitrex jardiance januvia janumet keppra klonopin lamictal lantus lasix levemir lexapro lipitor lodipine lopressor lyrica maxalt micardis mounjaro nexium norvasc novolog ozempic pantoloc paxil plavix pradax prilosec protonix prozac pristiq reactine rybelsus seroquel singulair symbicort synthroid tenormin topamax trajenta trulicity tylenol valium ventolin viagra victoza vyvanse wellbutrin xanax xarelto yasmin zestril zocor zofran zoloft zyrtec eltroxin protopic ritalin adderall concerta strattera lipidil pravachol tecta losec premarin prempro estrace provera aygestin toradol voltaren aleve advil motrin robaxin flexeril skelaxin medrol elidel dovobet daivobet diprosone elocom fucidin nizoral lamisil canesten tegretol depakote zyprexa risperdal invega lucemyra suboxone naltrexone nicorette champix zyban`;
export const COMMON = new Set(COMMON_TEXT.split(/\s+/).filter(Boolean));
const DISPLAY = (w) => w.charAt(0).toUpperCase() + w.slice(1);

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
export function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const SOUNDS = ['ckq', 'csz'];   // a hard c sounds like k or q, a soft c like s or z: Symbalta / Cymbalta
const firstOk = (a, b) => a[0] === b[0] || SOUNDS.some((g) => g.includes(a[0]) && g.includes(b[0]));

/** The one common drug a garbled name is clearly meant to be, or null. Pure; `extra` are more names the patient's own list gives. */
export function repairTarget(heard, { extra = [] } = {}) {
  const k = letters(heard); if (k.length < 6) return null;
  const maxD = k.length >= 10 ? 2 : 1;
  const pool = new Set([...COMMON, ...extra.map(letters).filter((x) => x.length >= 5)]);
  const hits = [];
  for (const w of pool) { if (Math.abs(w.length - k.length) > maxD || !firstOk(k, w)) continue; const d = lev(k, w); if (d >= 1 && d <= maxD) hits.push({ w, d }); }
  if (hits.length !== 1) return null;   // none close enough, or two drugs that close: ambiguous, leave it as heard
  return DISPLAY(hits[0].w);
}

const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const walk = (v, fn) => { if (typeof v === 'string') return fn(v); if (Array.isArray(v)) return v.map((x) => walk(x, fn)); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = k === 'metadata' ? x : walk(x, fn); return o; } return v; };

/** Part 1. → { md, note?, fixes: [{ from, to, places }] }. Needs the RxNorm lexicon ({ set }); without it nothing changes. */
export function repairDrugNames(md, transcript, { lexicon, patientMeds = [], note = null } = {}) {
  const out = { md, fixes: [] };
  if (!lexicon || !lexicon.set || lexicon.set.size < 1000) return out;
  const extra = (patientMeds || []).map((m) => String(m).split(/\s+\d/)[0].trim()).filter(Boolean);
  const tNorm = letters(transcript);
  const seen = new Set();
  for (const d of drugsInNote(md)) {
    const heard = d.term.split(' ')[0]; const key = letters(heard);
    if (key.length < 6 || seen.has(key)) continue; seen.add(key);
    if (lexicon.set.has(key) || COMMON.has(key) || extra.some((e) => letters(e) === key)) continue;   // a real drug, even a rare one
    const to = repairTarget(heard, { extra }); if (!to) continue;
    const rx = new RegExp(`(?<![A-Za-z-])${escRx(heard)}(?![A-Za-z])`, 'gi'); let places = 0;
    const sub = (s) => s.replace(rx, () => { places++; return to; });
    out.md = sub(out.md);
    if (note) { const fixed = walk(note, sub); Object.assign(note, fixed); }
    if (places) out.fixes.push({ from: heard, to, places, saidTo: tNorm.includes(letters(to)) });
  }
  return out;
}

// ── part 2: serious words ───────────────────────────────────────────────────────────────────
const F = (re) => new RegExp(re, 'i');
export const FAMILIES = [
  { name: 'cancer', note: F(String.raw`\b(cancer\w*|carcinoma\w*|malignan\w*|tumou?rs?|metasta\w*|lymphoma|leuk(?:a)?emia|melanoma)\b`),
    proof: F(String.raw`\b(cancer\w*|carcinoma\w*|malignan\w*|tumou?rs?|metasta\w*|lymphoma|leuk(?:a)?emia|melanoma|ca|chemo\w*|radiation|radiotherapy|oncolog\w*|biops\w*|mass|lump|growth|polyps?|lesions?|moles?|psa|mammogra\w*|colonoscop\w*|pap|screening|nodules?|cyst)\b`) },
  { name: 'chemotherapy', note: F(String.raw`\b(chemo\w*|radiotherapy|radiation therapy)\b`), proof: F(String.raw`\b(chemo\w*|radiotherapy|radiation|oncolog\w*|cancer\w*|treatments?|infusions?)\b`) },
  { name: 'stroke or heart attack', note: F(String.raw`\b(stroke|tia|transient ischemic attack|heart attack|myocardial infarction|cardiac arrest)\b`), proof: F(String.raw`\b(stroke|tia|ischemi\w*|ischaemi\w*|heart attack|infarct\w*|cardiac arrest|mi|blood clot|clots?|angioplasty|stents?|cardiolog\w*|bypass)\b`) },
  { name: 'HIV or hepatitis', note: /\b(HIV|AIDS|TB|[Hh]epatitis [ABCabc]|[Tt]uberculosis)\b/, proof:   /* acronyms are case-sensitive: "Mobility aids" is not AIDS */ F(String.raw`\b(hiv|aids|hepatitis|tuberculosis|tb|liver|viral|positive)\b`) },
  { name: 'dementia', note: F(String.raw`\b(dementia|alzheimer\w*)\b`), proof: F(String.raw`\b(dementia|alzheimer\w*|memory|forget\w*|confus\w*|cognit\w*|aricept|donepezil)\b`) },
  { name: 'seizures', note: F(String.raw`\b(epilep\w*|seizures?)\b`), proof: F(String.raw`\b(epilep\w*|seizures?|convuls\w*|blackouts?|passed out|fits?|keppra|lamictal|dilantin|topamax|neurolog\w*)\b`) },
  { name: 'suicide', note: F(String.raw`\b(suicid\w*|self[- ]harm)\b`), proof: F(String.raw`\b(suicid\w*|self[- ]harm|kill myself|end my life|hurt myself|better off dead)\b`) },
];
const NEGATED = /\b(no|not|never|denies|denied|without|negative|nil|ruled out|free of)\b/i;

/** Bullet lines of the note that name a serious word: { idx, line, section, family }. Problem titles and headings are skipped. */
export function seriousLines(md) {
  const lines = String(md || '').split('\n'); const out = []; let sec = '';
  lines.forEach((ln, idx) => {
    const h = ln.match(/^###\s+(.*)$/); if (h) { sec = h[1].trim(); return; }
    const b = ln.match(/^\s*[-•*]\s+(.*\S)\s*$/); if (!b) return;
    for (const fam of FAMILIES) if (fam.note.test(b[1])) { out.push({ idx, line: b[1], section: sec, family: fam }); break; }
  });
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Short passages of the transcript around where the family word is said (up to 3). */
export function passages(transcript, fam, { span = 260, max = 3 } = {}) {
  const t = String(transcript || ''); const rx = new RegExp(fam.note.source, 'gi'); const out = []; let m;
  while ((m = rx.exec(t)) && out.length < max) out.push(t.slice(Math.max(0, m.index - span), m.index + span).replace(/\s+/g, ' ').trim());
  return out;
}

export const MAJOR_SYS = `You check serious medical words in a clinic note against the transcript. Speech recognition mishears words: "I was supposed to see him yesterday but I had cancer so I couldn't get there" was really "I had to cancel", so a note saying "missed the appointment due to cancer" is WRONG.
You get numbered NOTE LINES, each with the transcript passages where the serious word is said. For each line decide:
- "confirmed": the passages clearly say the patient has, had, or is treated for it (or, if the line says family history, that a relative has it). A real diagnosis, a treatment, a test result, a referral for it.
- "mishear": in the passages the word is clearly a mis-recognition of another word (cancel, cancelled, counsel, ...) and nobody states that diagnosis or treatment.
- "unclear": anything else. When in doubt answer "unclear".
Return ONLY JSON: {"checks":[{"n":1,"verdict":"confirmed|mishear|unclear","meant":"the word probably meant, or empty","quote":"the exact transcript words that show it, at most 25 words"}]}`;

/** Parse the model answer. Only a "mishear" whose quote is really in the transcript and holds the word is acted on. */
export function parseMajor(raw, cands, transcript) {
  let j; try { j = JSON.parse(String(raw || '').replace(/^```(?:json)?|```$/g, '').trim()); } catch { return []; }
  const tn = norm(transcript); const acts = [];
  for (const c of j?.checks || []) {
    const cand = cands[(Number(c?.n) || 0) - 1]; if (!cand || c.verdict !== 'mishear') continue;
    const q = norm(c.quote); if (q.length < 12 || !tn.includes(q) || !cand.family.note.test(c.quote)) continue;   // the model must show where, and the word must be in what it shows
    // a mis-hearing is one word for another: the word meant is one or two words and the recording says something like it elsewhere ("cancer" / "canceled")
    const meant = norm(c.meant).split(' ').filter(Boolean); if (!meant.length || meant.length > 2 || !meant.some((w) => w.length >= 5 && tn.includes(w.slice(0, 5)))) continue;
    acts.push({ ...cand, meant: String(c.meant || '').slice(0, 40), quote: String(c.quote).slice(0, 160) });
  }
  return acts;
}

/**
 * Part 2. → { md, removed: [{ line, why }], flagged: [{ line, why }], checked, flags }.
 *   `clean` = the account wants no flags: lines are removed. Otherwise the ambiguous ones are flagged and only "no such word in the recording" removes.
 *   `getLlm` is called only when a line needs the model; `llm.generateContent(system, user, null, opts)` like the other steps.
 */
export async function repairSeriousWords(md, transcript, { clean = false, getLlm = null, log = () => {}, cap = 3 } = {}) {
  const out = { md, removed: [], flagged: [], checked: 0, flags: [] };
  const cands = seriousLines(md); out.checked = cands.length; if (!cands.length) return out;
  const lines = String(md).split('\n'); const drop = new Map(); const ask = [];
  // what is cut: a line joined with semicolons loses only the part that holds the word ("Hypothyroidism under care of Dr. Noor; missed appointment due to cancer" keeps the first part); a one-part line goes
  const cut = (c) => {
    const m = String(lines[c.idx]).match(/^(\s*[-•*]\s+)(.*\S)\s*$/); const parts = m ? m[2].split(/;\s*/) : [];
    const keep = parts.length > 1 ? parts.filter((p) => !c.family.note.test(p)) : [];
    drop.set(c.idx, keep.length ? m[1] + keep.join('; ') : null);
  };
  for (const c of cands) {
    if (c.family.proof.test(transcript)) { ask.push(c); continue; }   // the word, or something that explains it, is in the recording: the model looks at the context
    if (NEGATED.test(c.line)) continue;
    if (drop.size >= cap) continue;
    cut(c); out.removed.push({ line: c.line, why: `nothing in the recording mentions ${c.family.name}` });
  }
  const toAsk = ask.filter((c) => c.family.note.test(transcript)).slice(0, 6);   // only when the exact word is said: the doubt is about its meaning there
  if (toAsk.length && getLlm) {
    try {
      const llm = await getLlm();
      const user = toAsk.map((c, i) => `${i + 1}. NOTE LINE: ${c.line}\n   TRANSCRIPT: ${passages(transcript, c.family).map((p) => `"…${p}…"`).join(' / ')}`).join('\n\n') + '\n\nReturn ONLY the JSON.';
      const raw = await llm.generateContent(MAJOR_SYS, user, null, { maxOutputTokens: 900, temperature: 0, timeoutMs: 15000, retries: 1, hedgeMs: 0, thinkingBudget: 0, responseMimeType: 'application/json' });
      for (const a of parseMajor(raw, toAsk, transcript)) {
        if (clean) { if (drop.size < cap) { cut(a); out.removed.push({ line: a.line, why: `"${a.family.name}" was probably mis-heard${a.meant ? ` (meant "${a.meant}")` : ''}`, quote: a.quote }); } }
        else {
          out.flagged.push({ line: a.line, why: a.meant });
          out.flags.push({ type: 'word_check', field: 'subjective', severity: 'warning', message: `Please check "${a.line.slice(0, 90)}": the recording may have been mis-heard${a.meant ? ` (probably "${a.meant}")` : ''}.` });
        }
      }
    } catch (e) { log(`[v2:words] model check skipped — ${String(e.message || e).slice(0, 80)}`); }
  }
  if (drop.size) out.md = lines.map((l, i) => (drop.has(i) ? drop.get(i) : l)).filter((l) => l !== null).join('\n');
  return out;
}

/** Both parts on a finished note. Mutates `note` (structured copy of the drug fixes), returns { md, meta, flags }. */
export async function repairWords({ md, note = null, transcript, lexicon, patientMeds = [], clean = false, getLlm = null, log = () => {} }) {
  const meta = { drugs: [], removed: [], flagged: [], checked: 0 }; const flags = []; let cur = md;
  try {
    const dr = repairDrugNames(cur, transcript, { lexicon, patientMeds, note }); cur = dr.md; meta.drugs = dr.fixes;
    for (const f of dr.fixes) { flags.push({ type: 'drug_corrected', field: 'medications', severity: 'warning', message: `Heard "${f.from}" (${f.places}×); written as "${f.to}". Please check it is the drug meant.` }); log(`[v2:words] drug "${f.from}" -> "${f.to}" (${f.places} place${f.places === 1 ? '' : 's'})`); }
  } catch (e) { log(`[v2:words] drug repair skipped — ${e.message}`); }
  try {
    const sr = await repairSeriousWords(cur, transcript, { clean, getLlm, log }); cur = sr.md; meta.removed = sr.removed; meta.flagged = sr.flagged; meta.checked = sr.checked; flags.push(...sr.flags);
    for (const r of sr.removed) log(`[v2:words] removed "${r.line.slice(0, 70)}" — ${r.why}`);
  } catch (e) { log(`[v2:words] serious-word check skipped — ${e.message}`); }
  return { md: cur, meta, flags };
}
