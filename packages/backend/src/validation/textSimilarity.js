// ─────────────────────────────────────────────────────────────────────────────
// textSimilarity — the shared near-duplicate / paraphrase detector.
//
// Word-set Jaccard alone misses the duplicate the clinicians actually complain
// about: the SAME clinical point written twice in different words ("BP remains
// elevated despite amlodipine" / "Blood pressure is still above target on current
// therapy"). Three signals together catch it without merging genuinely different
// facts:
//
//   1. STEMMED CONTENT TOKENS — clinical abbreviations expanded (htn →
//      hypertension, t2dm → type 2 diabetes mellitus), stopwords and hedging
//      filler dropped, light suffix stemming. Compared by Jaccard + containment.
//   2. CHARACTER TRIGRAM DICE — catches re-ordered / re-worded phrasings that a
//      token set misses, and is robust to morphology the stemmer doesn't cover.
//   3. FACT FINGERPRINT GUARD — two sentences that carry DIFFERENT numbers, or
//      different medication/analyte names, are never duplicates however similar
//      the wording. This is what keeps "Hb 88" and "Hb 102" as two facts, and
//      "Continue amlodipine" separate from "Continue metformin".
//
// Deterministic, no LLM, no network. Used by dedupeNote (note-wide de-duplication)
// and by the ASR path (speech-recognition repetition-loop collapse).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// Clinical shorthand → canonical words, so an abbreviation and its expansion are
// recognised as the same concept. Applied on word boundaries, longest key first.
const ABBREV = {
  htn: 'hypertension', bp: 'blood pressure', hr: 'heart rate', rr: 'respiratory rate',
  t1dm: 'type 1 diabetes mellitus', t2dm: 'type 2 diabetes mellitus', dm2: 'type 2 diabetes mellitus',
  dm: 'diabetes mellitus', iddm: 'insulin dependent diabetes mellitus',
  cad: 'coronary artery disease', chf: 'congestive heart failure', af: 'atrial fibrillation',
  ckd: 'chronic kidney disease', aki: 'acute kidney injury', uti: 'urinary tract infection',
  uri: 'upper respiratory infection', urti: 'upper respiratory tract infection',
  copd: 'chronic obstructive pulmonary disease', oa: 'osteoarthritis', ra: 'rheumatoid arthritis',
  gerd: 'gastroesophageal reflux disease', gord: 'gastroesophageal reflux disease',
  ibs: 'irritable bowel syndrome', osa: 'obstructive sleep apnoea',
  mdd: 'major depressive disorder', gad: 'generalised anxiety disorder',
  adhd: 'attention deficit hyperactivity disorder', ptsd: 'post traumatic stress disorder',
  ida: 'iron deficiency anaemia', hld: 'hyperlipidaemia', dyslipidemia: 'hyperlipidaemia',
  a1c: 'hba1c', hba1c: 'hba1c', hgb: 'haemoglobin', hb: 'haemoglobin',
  ldl: 'low density lipoprotein', hdl: 'high density lipoprotein', tg: 'triglycerides',
  egfr: 'estimated glomerular filtration rate', gfr: 'glomerular filtration rate',
  cbc: 'complete blood count', fbc: 'full blood count', lft: 'liver function test',
  tft: 'thyroid function test', tsh: 'thyroid stimulating hormone', crp: 'c reactive protein',
  esr: 'erythrocyte sedimentation rate', wbc: 'white blood cell', rbc: 'red blood cell',
  ecg: 'electrocardiogram', ekg: 'electrocardiogram', cxr: 'chest radiograph',
  ct: 'computed tomography', mri: 'magnetic resonance imaging', us: 'ultrasound',
  rtc: 'return to clinic', fu: 'follow up', prn: 'as needed', od: 'once daily',
  bd: 'twice daily', bid: 'twice daily', tds: 'three times daily', tid: 'three times daily',
  qid: 'four times daily', po: 'oral', sob: 'shortness of breath', soba: 'shortness of breath',
  doe: 'dyspnoea on exertion', cp: 'chest pain', abdo: 'abdominal', hx: 'history',
  pmh: 'past medical history', fhx: 'family history', shx: 'social history',
  nkda: 'no known drug allergies', wnl: 'within normal limits', nad: 'no abnormality detected',
  loc: 'loss of consciousness', bmi: 'body mass index', bsl: 'blood sugar level',
  hs: 'at night', nocte: 'at night', mane: 'in the morning',
};

// British/American and morphological variants that must collapse to one form so
// "haemoglobin"/"hemoglobin" and "anaemia"/"anemia" compare equal.
const SPELLING = [
  [/\bhaemo/g, 'hemo'], [/\banaem/g, 'anem'], [/\boedema/g, 'edema'], [/\bdyspnoea/g, 'dyspnea'],
  [/\bapnoea/g, 'apnea'], [/\bdiarrhoea/g, 'diarrhea'], [/\bfoetal/g, 'fetal'],
  [/\bcentre/g, 'center'], [/\blitre/g, 'liter'], [/\bfibre/g, 'fiber'],
  // -ise/-ize only after a real 4+ character stem, so "hospitalised" normalises but
  // "raised", "advised" and "revised" are left alone (mangling them broke the
  // condition-synonym patterns below, which match on the normalised spelling).
  [/([a-z]{4})isation\b/g, '$1ization'], [/([a-z]{4})ised\b/g, '$1ized'],
  [/([a-z]{4})ising\b/g, '$1izing'], [/([a-z]{4})ise\b/g, '$1ize'],
  [/([a-z]{3})yse\b/g, '$1yze'],
  [/\bgrey\b/g, 'gray'], [/aemia\b/g, 'emia'],
];

// True synonyms — same clinical meaning, different words. Canonicalising them is what
// lets "commence lisinopril" match "start lisinopril". NEVER put antonyms in here; words
// that distinguish meaning live in DISCRIMINATORS below.
const SYNONYM = {
  commence: 'start', commenced: 'start', commencing: 'start', initiate: 'start', initiated: 'start',
  initiating: 'start', begin: 'start', began: 'start', begun: 'start', started: 'start', starting: 'start',
  maintain: 'continue', maintained: 'continue', maintaining: 'continue', keep: 'continue',
  cease: 'stop', ceased: 'stop', discontinue: 'stop', discontinued: 'stop', stopped: 'stop',
  halt: 'stop', halted: 'stop', withhold: 'stop', withheld: 'stop',
  uptitrate: 'increase', increased: 'increase', increasing: 'increase', raise: 'increase', raised: 'increase',
  downtitrate: 'decrease', decreased: 'decrease', decreasing: 'decrease', reduce: 'decrease',
  reduced: 'decrease', reducing: 'decrease', wean: 'decrease', weaned: 'decrease',
  referral: 'refer', referred: 'refer', referring: 'refer',
  order: 'arrange', ordered: 'arrange', request: 'arrange', requested: 'arrange',
  organise: 'arrange', organize: 'arrange', organised: 'arrange', organized: 'arrange',
  book: 'arrange', booked: 'arrange', schedule: 'arrange', scheduled: 'arrange', arranged: 'arrange',
  recheck: 'followup', reassess: 'followup', reassessed: 'followup', repeat: 'followup',
  counsel: 'advise', counselled: 'advise', counseled: 'advise', educate: 'advise', educated: 'advise',
  satisfactory: 'adequate', adequately: 'adequate', good: 'adequate', well: 'adequate',
  acceptable: 'adequate', optimal: 'adequate',
  commenced_on: 'start', prescribe: 'prescribe', prescribed: 'prescribe', script: 'prescribe',
  investigation: 'investigation', investigations: 'investigation', workup: 'investigation',
  medication: 'medication', medications: 'medication', meds: 'medication', drug: 'medication',
  complaint: 'symptom', complaints: 'symptom', symptoms: 'symptom',
  tenderness: 'tender', tender: 'tender', painful: 'pain', pains: 'pain', sore: 'pain',
  nil: 'none', absent: 'none',
};

// Function words plus clinical hedging/filler that carries no fact. Removing them is
// what lets "patient reports the pain is worse at night" and "pain worse overnight"
// line up on their content. NOTE: negation words are deliberately ABSENT — they are
// handled as a polarity discriminator, because dropping them would make
// "BP controlled" and "BP not controlled" look like the same sentence.
const STOP = new Set(`a about after again against all also am an and any are as at
be because been before being between both but by can cannot could did do does doing
during each few for from further had has have having he her here hers herself him
himself his how i if in into is it its itself me more most my myself nor of off on
once only or other ought our ours ourselves out over own same she should so some such than
that the their theirs them themselves then there these they this those through to too
until very was we were what when where which while who whom why with would you your yours
yourself yourselves
patient pt client case today currently current presently now ongoing
reports report reported reporting states state stated stating notes note noted noting
describes describe described mentions mentioned says said tells told
appears appear seems seem likely apparently overall generally
discussed discussion reviewed review
mr mrs ms dr`.split(/\s+/).filter(Boolean));

// ── Discriminators: tokens that CHANGE the clinical meaning ───────────────────
// Two texts that land on different members of the same axis are never duplicates,
// however similar their wording. This is what keeps "left knee" apart from "right
// knee", "improving" from "worsening", and "start" from "stop". Because these are
// guarded, the similarity thresholds below can stay aggressive enough to catch real
// paraphrases without risking a clinically wrong merge.
const DISCRIMINATORS = {
  negation: /^(?:no|not|non|none|never|without|absent|negative|denies|denied|deny|nil|free|ruled|excludes?|excluded|unremarkable)$/,
  laterality: /^(?:left|right|bilateral|bilaterally)$/,
  vertical: /^(?:upper|lower|proximal|distal|superior|inferior)$/,
  plane: /^(?:anterior|posterior|medial|lateral|dorsal|ventral)$/,
  direction: /^(?:increase|decrease|rising|falling|higher|lower|upward|downward|elevated|reduced)$/,
  action: /^(?:start|stop|continue|hold|switch|change)$/,
  control: /^(?:controlled|uncontrolled|suboptimal|stable|unstable|target|abnormal|normal)$/,
  trajectory: /^(?:improve|improving|improved|resolve|resolved|resolving|worsen|worsening|worse|deteriorate|deteriorating|progress|progressing|unchanged)$/,
  certainty: /^(?:confirmed|suspected|possible|probable|query|provisional|presumed|definite)$/,
  severity: /^(?:mild|moderate|severe|profound|slight|marked)$/,
  timing: /^(?:new|old|chronic|acute|subacute|recurrent|initial|previous|prior|historical)$/,
  accepted: /^(?:declined|refused|accepted|agreed|consented|deferred)$/,
  tense: /^(?:planned|completed|done|pending|awaiting|already)$/,
};

// Medication/analyte-ish tokens: if two sentences disagree on this set they are
// different facts. Kept broad — any capitalised-or-long token that isn't a stopword
// would over-trigger, so we key off drug suffixes plus an explicit analyte list.
const DRUG_SUFFIX = /(?:pril|sartan|olol|dipine|statin|formin|gliptin|glitazone|flozin|glutide|prazole|tidine|azepam|zolam|pam|oxetine|pram|traline|faxine|azine|apine|idone|codone|morphine|cillin|cycline|mycin|oxacin|azole|ovir|tinib|mab|cept|parin|aban|warfarin|insulin|thyroxine|prednisone|prednisolone|salbutamol|ventolin|paracetamol|acetaminophen|ibuprofen|naproxen|tramadol|gabapentin|pregabalin|amitriptyline|omeprazole|pantoprazole)$/i;
const ANALYTE = /^(?:haemoglobin|hemoglobin|ferritin|iron|a1c|hba1c|glucose|cholesterol|ldl|hdl|triglycerides?|creatinine|egfr|gfr|tsh|t4|t3|sodium|potassium|calcium|magnesium|phosphate|albumin|bilirubin|alt|ast|alp|ggt|urea|crp|esr|wbc|rbc|platelets?|inr|b12|folate|psa|vitamin|weight|height|bmi|lipids?|liver|renal|kidney|electrolytes?|thyroid|urinalysis|urine|lfts?|ues?)$/i;

const lower = (s) => String(s == null ? '' : s).toLowerCase();

/** Normalise to bare lowercase words (punctuation → space, spelling unified). */
export function normalizeText(s) {
  let t = lower(s).replace(/[^a-z0-9.\s/]/g, ' ');
  for (const [rx, to] of SPELLING) t = t.replace(rx, to);
  return t.replace(/\s+/g, ' ').trim();
}

// Whole-phrase condition synonyms. A problem the clinician calls "hypertension" and
// one the scribe wrote as "elevated blood pressure" share no words at all, so no
// token metric can see they are the same problem — this table is what collapses them.
// Each entry is a regex over the normalised text and the canonical concept it maps to.
const CONCEPTS = [
  // "Haemoglobin A1c" expands word-by-word to "hemoglobin hba1c"; collapse the pair so
  // it matches a bare "HbA1c" instead of carrying a spurious extra analyte.
  [/\bhemoglobin hba1c\b/g, 'hba1c'],
  [/\b(?:hypertension|hypertensive|(?:elevated|raised|high|increased)\s+(?:blood pressure|bp))\b/g, 'hypertension'],
  // A refinement keeps its broad term plus a qualifier token ("diabetes type2", not
  // "type2diabetes"), so the SPECIFIC title still subsumes the vague one and
  // de-duplication retitles "Diabetes" to "Type 2 diabetes mellitus" instead of
  // treating the two as unrelated problems.
  [/\b(?:type 2 diabetes(?: mellitus)?|(?:elevated|raised|high)\s+blood sugar|poor glycemic control|hyperglycemia)\b/g, 'diabetes type2'],
  [/\b(?:type 1 diabetes(?: mellitus)?)\b/g, 'diabetes type1'],
  [/\b(?:hyperlipidemia|dyslipidemia|(?:elevated|raised|high)\s+(?:cholesterol|lipids))\b/g, 'hyperlipidemia'],
  [/\b(?:iron deficiency anemia|iron deficient anemia)\b/g, 'anemia irondeficiency'],
  [/\b(?:hypothyroidism|underactive thyroid|(?:low|underactive)\s+thyroid function)\b/g, 'hypothyroidism'],
  [/\b(?:hyperthyroidism|overactive thyroid)\b/g, 'hyperthyroidism'],
  [/\b(?:obesity|obese|(?:elevated|raised|high)\s+body mass index)\b/g, 'obesity'],
  [/\b(?:chronic kidney disease|renal impairment|impaired renal function|reduced kidney function)\b/g, 'kidneydisease chronic'],
  [/\b(?:osteoarthritis|degenerative joint disease|degenerative arthritis)\b/g, 'osteoarthritis'],
  [/\b(?:gastroesophageal reflux disease|acid reflux|reflux disease|heartburn)\b/g, 'reflux'],
  [/\b(?:major depressive disorder|depression|depressive episode|low mood)\b/g, 'depression'],
  [/\b(?:generalised anxiety disorder|generalized anxiety disorder|anxiety disorder|anxiety)\b/g, 'anxiety'],
  [/\b(?:urinary tract infection|bladder infection|cystitis)\b/g, 'infection urinarytract'],
  [/\b(?:upper respiratory (?:tract )?infection|common cold|viral uri)\b/g, 'infection upperrespiratory'],
  [/\b(?:chronic obstructive pulmonary disease|emphysema)\b/g, 'copd'],
  [/\b(?:atrial fibrillation|irregular heart rhythm)\b/g, 'atrialfibrillation'],
  [/\b(?:vitamin d deficiency|low vitamin d)\b/g, 'vitamind deficiency'],
  [/\b(?:insomnia|sleep disturbance|difficulty sleeping|poor sleep)\b/g, 'insomnia'],
  [/\b(?:medication (?:refill|renewal)|prescription (?:refill|renewal)|repeat prescription)\b/g, 'medication refill'],
];

/**
 * Expand clinical abbreviations and fold condition synonyms. Spelling normalisation
 * runs again at the end because abbreviation expansion reintroduces full words
 * ("hba1c" → "hemoglobin a1c") that must land in the same spelling as written text.
 */
export function expandAbbreviations(s) {
  let t = normalizeText(s)
    .split(' ')
    .map((w) => {
      const bare = w.replace(/\.$/, '');
      return ABBREV[bare] || w;
    })
    .join(' ');
  for (const [rx, to] of SPELLING) t = t.replace(rx, to);
  for (const [rx, to] of CONCEPTS) t = t.replace(rx, to);
  return t.replace(/\s+/g, ' ').trim();
}

// Very light suffix stemmer — enough to fold elevated/elevation/elevating together
// without an external stemmer dependency. Rules are ordered longest-first and AT MOST
// ONE fires, with a 4-character floor on the result: cascading them over-stemmed badly
// ("present" → "pres" → "pr") and made plurals disagree with their singulars
// ("mornings" → "morning" but "morning" → "morn").
const STEM_RULES = [
  /(?:ational|isation|ization|iveness|fulness|ousness)$/,
  /(?:ingly|edly|ation|ition|ement|ences|ances|ities|ively)$/,
  /(?:ings|ions|ments|nesses)$/,
  /(?:ing|ion|ies|ers|est|ely|ous|ive|ful|ness|ment|ence|ance|ity)$/,
  /(?:ed|es|ly|er)$/,
  /s$/,
];
function stem(w) {
  // Strip a plural first so "mornings" and "morning" reach the same stem.
  let t = w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w;
  for (const rx of STEM_RULES) {
    const next = t.replace(rx, '');
    if (next !== t && next.length >= 4) return next;
  }
  return t;
}

/** Canonical word list: abbreviations expanded, synonyms folded, stopwords dropped. */
function words(s) {
  return expandAbbreviations(s)
    .split(' ')
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map((w) => SYNONYM[w] || w);
}

/**
 * Stemmed content tokens: the primary comparison key. Every negation cue collapses to
 * one `neg` token so "no fever" and "denies fever" share a key, while the separate
 * negation axis still stops "fever" from matching "no fever".
 */
export function contentTokens(s) {
  const out = [];
  for (const w of words(s)) {
    if (DISCRIMINATORS.negation.test(w)) { out.push('neg'); continue; }
    if (w.length <= 2 || STOP.has(w) || /^\d+(?:\.\d+)?$/.test(w)) continue;
    const t = stem(w);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Meaning-changing markers present in the text, grouped by axis. Matched on the
 * canonical (un-stemmed) words, so each regex lists the inflections it must catch.
 * @returns {Record<string, Set<string>>}
 */
export function discriminators(s) {
  const out = {};
  // "free of" and "ruled out" only negate as a phrase, never as a bare word.
  const phrase = expandAbbreviations(s);
  for (const w of words(s)) {
    for (const [axis, rx] of Object.entries(DISCRIMINATORS)) {
      if (!rx.test(w)) continue;
      if (axis === 'negation') {
        if ((w === 'free' || w === 'ruled') && !/\b(?:free of|ruled out)\b/.test(phrase)) continue;
        (out.negation ||= new Set()).add('neg');
        continue;
      }
      (out[axis] ||= new Set()).add(w === 'bilaterally' ? 'bilateral' : w);
    }
  }
  return out;
}

/** Every number in the text, normalised so "5.0" and "5" match. */
export function numberSet(s) {
  const out = new Set();
  for (const raw of lower(s).match(/\d+(?:\.\d+)?/g) || []) {
    const n = Number(raw);
    out.add(Number.isFinite(n) ? String(n) : raw);
  }
  return out;
}

/**
 * Medication / analyte names mentioned — the fact-identity guard. Runs on the EXPANDED
 * text so an abbreviation and its written-out form produce the same fact ("HbA1c" and
 * "Haemoglobin A1c" must not look like two different analytes).
 */
export function factTokens(s) {
  const out = new Set();
  // Scan both spellings: abbreviation expansion turns "ldl" into "low density
  // lipoprotein", which no longer looks like an analyte, so the raw pass keeps the
  // guard effective. A token one side misses only ever weakens the guard (a subset is
  // never a conflict), so the union is safe.
  for (const text of [normalizeText(s), expandAbbreviations(s)]) {
    for (const w of text.split(' ')) {
      const t = w.replace(/^\.+|\.+$/g, '');
      if (t.length < 3) continue;
      if (ANALYTE.test(t) || DRUG_SUFFIX.test(t)) out.add(stem(t));
    }
  }
  return out;
}

function charTrigrams(s) {
  const t = ` ${expandAbbreviations(s).replace(/\s+/g, ' ')} `;
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccardSets(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function diceSets(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Fraction of the smaller token set contained in the larger. */
function containmentSets(A, B) {
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  if (!small.size) return 0;
  let c = 0;
  for (const x of small) if (large.has(x)) c++;
  return c / small.size;
}

/**
 * Precompute every signature for one piece of text. Callers that compare a
 * sentence against many others should build this once.
 */
export function signature(text) {
  const raw = String(text == null ? '' : text).trim();
  const tokens = contentTokens(raw);
  return {
    raw,
    key: [...new Set(tokens)].sort().join(' '),   // order-independent exact key
    tokens: new Set(tokens),
    tokenCount: tokens.length,
    trigrams: charTrigrams(raw),
    numbers: numberSet(raw),
    facts: factTokens(raw),
    axes: discriminators(raw),
    len: raw.length,
  };
}

/**
 * True when the two texts sit on DIFFERENT members of the same meaning axis — left vs
 * right, improving vs worsening, start vs stop, negated vs affirmed. An axis only
 * discriminates when both sides actually mention it, so "knee pain" still merges into
 * "left knee pain" (the unmarked text is the vaguer duplicate), while "left knee pain"
 * and "right knee pain" stay apart.
 */
function axesConflict(a, b) {
  for (const axis of Object.keys(DISCRIMINATORS)) {
    const A = a.axes?.[axis];
    const B = b.axes?.[axis];
    if (!A?.size || !B?.size) {
      // Negation is the one axis where silence is meaningful: an affirmed statement is
      // the opposite of a negated one, so a missing marker on one side IS a conflict.
      if (axis === 'negation' && Boolean(A?.size) !== Boolean(B?.size)) return true;
      continue;
    }
    if (conflicts(A, B)) return true;
  }
  return false;
}

/**
 * True only when the two sets genuinely CONFLICT — each side holds a member the
 * other lacks. A subset is not a conflict: "continue amlodipine 5 mg" and
 * "continue amlodipine" describe one fact at two levels of detail (we keep the
 * richer one), whereas "5 mg" vs "10 mg" is a real dose change and must survive.
 */
function conflicts(A, B) {
  let aExtra = false, bExtra = false;
  for (const x of A) if (!B.has(x)) { aExtra = true; break; }
  for (const x of B) if (!A.has(x)) { bExtra = true; break; }
  return aExtra && bExtra;
}

const DEFAULTS = {
  jaccard: 0.52,       // stemmed content-token overlap
  dice: 0.66,          // character-trigram overlap (the paraphrase signal)
  containment: 0.85,   // most of the shorter text's content sits inside the longer one
  minTokens: 3,        // below this, only full subsumption counts (plan lines are terse)
};

/**
 * Similarity report for two texts.
 * @returns {{duplicate:boolean, jaccard:number, dice:number, containment:number, reason:string}}
 */
export function compareText(a, b, opts = {}) {
  const sa = a && a.tokens ? a : signature(a);
  const sb = b && b.tokens ? b : signature(b);
  return compareSignatures(sa, sb, opts);
}

export function compareSignatures(sa, sb, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const none = { duplicate: false, jaccard: 0, dice: 0, containment: 0, reason: '' };
  if (!sa.raw || !sb.raw) return none;

  // GUARDS — checked before every similarity signal, so no amount of shared wording can
  // merge two clinically different statements.
  if (conflicts(sa.numbers, sb.numbers)) return { ...none, reason: 'different-numbers' };
  if (conflicts(sa.facts, sb.facts)) return { ...none, reason: 'different-facts' };
  if (axesConflict(sa, sb)) return { ...none, reason: 'different-meaning' };

  // Identical content key → duplicate regardless of length or word order.
  if (sa.key && sa.key === sb.key) {
    return { duplicate: true, jaccard: 1, dice: 1, containment: 1, reason: 'identical-content' };
  }

  const c = containmentSets(sa.tokens, sb.tokens);
  // Full subsumption holds at any length: a terse plan line whose every content word
  // appears in a fuller one ("continue amlodipine" ⊂ "continue amlodipine 5 mg daily")
  // is the same instruction, and moreInformative() keeps the detailed version.
  if (c === 1 && Math.min(sa.tokenCount, sb.tokenCount) >= 1) {
    return { duplicate: true, jaccard: jaccardSets(sa.tokens, sb.tokens), dice: diceSets(sa.trigrams, sb.trigrams), containment: 1, reason: 'subsumed' };
  }
  // Below minTokens the fuzzy signals are noise — two short lines that are not a full
  // subset of each other stay as two facts.
  if (sa.tokenCount < o.minTokens || sb.tokenCount < o.minTokens) return { ...none, containment: c };

  const j = jaccardSets(sa.tokens, sb.tokens);
  const d = diceSets(sa.trigrams, sb.trigrams);
  const duplicate = j >= o.jaccard || d >= o.dice || c >= o.containment;
  return {
    duplicate,
    jaccard: j,
    dice: d,
    containment: c,
    reason: duplicate ? (j >= o.jaccard ? 'token-overlap' : d >= o.dice ? 'paraphrase' : 'subsumed') : '',
  };
}

/**
 * Why two texts must NOT be merged, independent of how similar they read.
 * Returns '' when nothing conflicts. Used to vet any externally proposed merge
 * (e.g. a group suggested by the semantic de-duplication pass).
 */
export function conflictReason(a, b) {
  const sa = a && a.tokens ? a : signature(a);
  const sb = b && b.tokens ? b : signature(b);
  if (conflicts(sa.numbers, sb.numbers)) return 'different-numbers';
  if (conflicts(sa.facts, sb.facts)) return 'different-facts';
  if (axesConflict(sa, sb)) return 'different-meaning';
  return '';
}

/**
 * Does `a` carry a medication/analyte or a number that `b` lacks?
 *
 * Subsumption alone is not safe to act on when the caller keeps the FIRST occurrence:
 * "Repeat HbA1c in 3 months" and "Liver function tests and repeat lipid panel in 3 months
 * (combined with HbA1c)" look like one fact at two levels of detail, so the richer line
 * was discarded and two orders went with it. Any line that adds information must survive.
 */
export function addsInformation(a, b) {
  const sa = a && a.tokens ? a : signature(a);
  const sb = b && b.tokens ? b : signature(b);
  for (const f of sa.facts) if (!sb.facts.has(f)) return true;
  for (const n of sa.numbers) if (!sb.numbers.has(n)) return true;
  return false;
}

/** Which of two near-duplicates to keep: the one carrying more information. */
export function moreInformative(sa, sb) {
  if (sa.numbers.size !== sb.numbers.size) return sa.numbers.size > sb.numbers.size ? sa : sb;
  if (sa.facts.size !== sb.facts.size) return sa.facts.size > sb.facts.size ? sa : sb;
  if (sa.tokenCount !== sb.tokenCount) return sa.tokenCount > sb.tokenCount ? sa : sb;
  return sa.len >= sb.len ? sa : sb;
}

/**
 * Collapse a list of texts to its unique members.
 * @param {string[]} items
 * @param {{opts?:object, keep?:'first'|'best', seen?:Array, onDrop?:Function}} cfg
 *   seen — signatures already accepted elsewhere (cross-section de-duplication);
 *          accepted items are appended to it so the caller can chain passes.
 * @returns {string[]}
 */
export function dedupeList(items, cfg = {}) {
  const { opts = {}, keep = 'best', seen = [], onDrop = () => {} } = cfg;
  // Entries carry `slot` only when they belong to THIS list; a match against an entry
  // from an earlier pass can't be upgraded in place, so that item is simply dropped.
  for (const e of seen) if (e && e.sig === undefined) { e.sig = signature(e.raw != null ? e.raw : e); }
  const out = [];
  for (const item of items || []) {
    const text = String(item == null ? '' : item).trim();
    if (!text) continue;
    const sig = signature(text);
    let dup = null;
    for (const entry of seen) {
      if (compareSignatures(sig, entry.sig, opts).duplicate) { dup = entry; break; }
    }
    if (!dup) {
      const entry = { sig, slot: out.length };
      seen.push(entry);
      out.push(text);
      continue;
    }
    // A duplicate of something in THIS list may still be the better phrasing — swap it
    // in rather than keeping the weaker first mention.
    if (dup.slot !== undefined && keep === 'best' && moreInformative(sig, dup.sig) === sig) {
      onDrop(dup.sig.raw, text);
      out[dup.slot] = text;
      dup.sig = sig;
      continue;
    }
    onDrop(text, dup.sig.raw);
  }
  return out;
}

/**
 * Collapse speech-recognition repetition loops inside one transcript chunk: a decoder can
 * emit the same phrase or sentence back to back many times. Keeps the first
 * occurrence of any run of immediate repeats.
 */
export function collapseRepetitions(text, { maxWindow = 24 } = {}) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return '';
  const words = src.split(/\s+/).filter(Boolean);
  const out = [];
  const same = (i, j, n) => {
    for (let k = 0; k < n; k++) {
      if (lower(out[i + k] || '').replace(/[^a-z0-9]/g, '') !== lower(words[j + k] || '').replace(/[^a-z0-9]/g, '')) return false;
    }
    return true;
  };
  for (let i = 0; i < words.length;) {
    let collapsed = false;
    // Look for the longest window that immediately repeats what we just emitted.
    for (let n = Math.min(maxWindow, out.length, words.length - i); n >= 2; n--) {
      if (same(out.length - n, i, n)) { i += n; collapsed = true; break; }
    }
    if (collapsed) continue;
    // Single-word stutter, but only from the THIRD consecutive repeat onward, so a
    // genuine spoken double ("no no", "bye bye") survives while a decoder loop
    // ("pain pain pain pain") collapses.
    const bare = lower(words[i]).replace(/[^a-z0-9]/g, '');
    const tail = (k) => lower(out[out.length - k] || '').replace(/[^a-z0-9]/g, '');
    if (bare && bare === tail(1) && bare === tail(2)) { i += 1; continue; }
    out.push(words[i]);
    i += 1;
  }
  return out.join(' ');
}
