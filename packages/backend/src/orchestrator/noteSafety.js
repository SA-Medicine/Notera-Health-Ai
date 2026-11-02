// Note safety pass (2026-11-02, from the audit of the first two real test visits). Runs on the finished note markdown, before strictPlan, in the layout layer.
// Pure code, no model call, a few milliseconds. It never adds a clinical fact: it restores a negation the recording gives, removes or softens what the recording does
// not say, merges repeats, and returns flags for the "Before you sign" box.
//   A1  a bare "Smoking" / "Alcohol" line (the negation was lost upstream) -> "Denies smoking" / "Current smoker" / "status not clear" when the recording gives no answer.
//   A2  a drug name the recording never says is replaced by the heard drug that carries the same dose (or by "medication (name not heard)"); a statin in a visit that never
//       mentions cholesterol or heart risk is flagged, and its "(generic)" label is dropped, because the generic was only a lookup of a possibly misheard brand.
//   A3  a diagnosis word the recording never supports ("deficiency", "anaemia", "infection" ...) is taken out of a problem title.
//   A5  plan lines the recording does not support: a test nobody named (HbA1c, fasting ...), "at home" monitoring nobody mentioned, "Referral ... sent" when it was only going to be asked,
//       "Arrange ... monitoring" when monitoring was only mentioned as a maybe.
//   A6  medicines the patient is not taking are marked in the Medications line; repeats are merged (a referral said twice, a prescription said twice, "declined" next to "consider"),
//       blood results said in Subjective and again in Objective are said once, a past evaluation does not belong in Objective.
// Off by default: runs with NOTE_STRICT=1.
'use strict';
import { isDrugLine } from './planStrict.js';

const VERB = /^(Start|Stop|Continue|Resume|Change|Increase|Reduce|Prescribe)\s+/;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const STOPW = new Set('the and for with from that this was are were has have had not any all can will may would should could after before about into over then than also per out off her his their its you your patient reports report'.split(' '));
const toks = (s) => (String(s || '').toLowerCase().replace(/haemo/g, 'hemo').match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOPW.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ''));
const subset = (a, b) => { const B = new Set(b); return a.length > 0 && a.every((x) => B.has(x)); };
const sentencesOf = (t) => String(t || '').split(/(?<=[.?!])\s+/);

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function heard(word, T, tWords) {
  const k = norm(word); if (k.length < 4) return true;
  if (T.includes(k)) return true;
  const tol = k.length >= 9 ? 2 : 1;
  return tWords.some((w) => w[0] === k[0] && Math.abs(w.length - k.length) <= tol && lev(w, k) <= tol);
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────
function parse(md) {
  const lines = String(md).split('\n');
  const apAt = lines.findIndex((l) => /^###\s+Assessment/i.test(l));
  const head = apAt < 0 ? lines.slice() : lines.slice(0, apAt);
  const problems = []; let cur = null;
  if (apAt >= 0) for (const ln of lines.slice(apAt + 1)) {
    const pm = ln.match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/);
    if (pm) { cur = { title: pm[1].trim(), lines: [] }; problems.push(cur); continue; }
    const bm = ln.match(/^\s*[-*]\s+(.*)$/);
    if (bm && cur) cur.lines.push(bm[1].trim());
  }
  let follow = null; if (problems.length && /^follow-?up$/i.test(problems[problems.length - 1].title)) follow = problems.pop();
  return { head, apHeader: apAt < 0 ? null : lines[apAt], problems, follow };
}
function render({ head, apHeader, problems, follow }) {
  const out = head.slice();
  if (apHeader) {
    out.push(apHeader);
    problems.forEach((p, k) => { out.push(`${k + 1}. **${p.title}**`); for (const l of p.lines) out.push(`   - ${l}`); });
    if (follow && follow.lines.length) { out.push(`${problems.length + 1}. **Follow-up**`); for (const l of follow.lines) out.push(`   - ${l}`); }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** head lines grouped by their ### heading: { name, from, to } over indexes of head */
function sections(head) {
  const out = []; head.forEach((l, i) => { const h = l.match(/^###\s+(.*)$/); if (h) { if (out.length) out.at(-1).to = i; out.push({ name: h[1].trim(), from: i + 1, to: head.length }); } });
  return out;
}

// ── A1 social status ───────────────────────────────────────────────────────────────────────
const SOC = {
  smoking: { word: /\b(smok\w*|tobacco|cigarettes?|vap\w*)/gi, no: 'Denies smoking', yes: 'Current smoker', unclear: 'Smoking status not clear in the recording' },
  alcohol: { word: /\b(alcohol\w*|alco\w*)/gi, no: 'Denies alcohol use', yes: 'Drinks alcohol', unclear: 'Alcohol use not clear in the recording' },
};
function socialStatus(T, kind) {
  const re = new RegExp(SOC[kind].word.source, 'gi'); let m; let seenNo = false, seenYes = false;
  while ((m = re.exec(T))) {
    const before = T.slice(Math.max(0, m.index - 60), m.index); const after = T.slice(m.index, m.index + 90);
    const q = after.indexOf('?'); const ans = q >= 0 ? after.slice(q + 1, q + 30) : '';
    if (/^\s*(no|nope|nah|never)\b/i.test(ans) || /\bnon-?smoker\b|\bnever smoked\b|\b(don'?t|do not|never|not)\s+(\w+\s+){0,2}$/i.test(before) && q < 0) seenNo = true;
    if (/^\s*(yes|yeah|yep|sometimes|socially|a little)\b/i.test(ans) || /\bi (smoke|drink)\b|\bpacks? (a|per) day\b|\bcigarettes? (a|per) day\b/i.test(after)) seenYes = true;
  }
  return seenNo && !seenYes ? 'no' : seenYes && !seenNo ? 'yes' : 'unclear';
}
function fixSocial(P, T, flags, note) {
  const sec = sections(P.head).filter((s) => /subjective|past medical/i.test(s.name));
  for (const s of sec) for (let i = s.from; i < s.to; i++) {
    const m = P.head[i].match(/^(\s*[-•*]\s+)(.*)$/); if (!m) continue;
    const segs = m[2].split(/,\s+/); let hit = false;
    const fixed = segs.map((seg) => {
      const b = seg.replace(/[.;]+$/, '').trim().toLowerCase();
      const kind = /^(smoking|smoker|tobacco|cigarettes?|vaping)$/.test(b) ? 'smoking' : /^alcohol$/.test(b) ? 'alcohol' : null;
      if (!kind) return seg;
      const st = socialStatus(T, kind); hit = true;
      const text = st === 'no' ? SOC[kind].no : st === 'yes' ? SOC[kind].yes : SOC[kind].unclear;
      flags.push({ type: 'social_status_restored', field: 'past_medical_history', severity: st === 'unclear' ? 'warning' : 'info', message: st === 'unclear' ? `The note said only "${seg}" and the recording does not give a clear answer. Check the patient's ${kind} status.` : `The note said only "${seg}"; the recording answers it ("${text}"). Check the wording.` });
      note(`social: "${seg}" -> "${text}"`); return text;
    });
    if (hit) P.head[i] = m[1] + fixed.join(', ').replace(/^./, (c) => c.toUpperCase());
  }
}

// ── A2 drug names ──────────────────────────────────────────────────────────────────────────
const STATIN = /\b([A-Za-z]+statin|Lipitor|Crestor|Zocor|Pravachol|Mevacor|Lescol)\b/;
const LIPID_CUE = /cholesterol|lipid|\bldl\b|statin|triglycerid|cardiovascular|heart attack|stroke|coronary/i;
const PPI_CUE = /reflux|heartburn|dyspepsia|belching|stomach|\bppi\b|proton|acid|ulcer|gerd/i;
const doseOf = (l) => (String(l).match(/\b(\d+(?:\.\d+)?)\s?(?:mg|mcg|milligrams?)\b/i) || [])[1];
const drugWord = (l) => (String(l).replace(VERB, '').match(/^[^A-Za-z]*([A-Za-z]{4,})/) || [])[1];

function fixDrugs(P, T, flags, note) {
  const low = T.toLowerCase(); const tWords = [...new Set(low.match(/[a-z]{4,20}/g) || [])];
  const NOT_A_DRUG = new Set('dose doses renewed prescribed started stopped continued changed vitamins vitamin nasal bandage periodic antihypertensive medication medications tablets pills cream ointment daily twice once repeat arrange'.split(' '));
  for (const p of P.problems) {
    for (let i = 0; i < p.lines.length; i++) {
      const l = p.lines[i];
      if (!VERB.test(l) || !doseOf(l)) continue;   // only a line that starts "Start/Continue/Resume ... " and carries a dose
      const w = drugWord(l); if (!w || NOT_A_DRUG.has(w.toLowerCase()) || heard(w, low, tWords)) continue;
      const dose = doseOf(l);
      const sib = p.lines.find((x, j) => j !== i && VERB.test(x) && doseOf(x) === dose && drugWord(x) && heard(drugWord(x), low, tWords));
      if (sib) {
        const sw = drugWord(sib); p.lines[i] = l.replace(w, sw);
        flags.push({ type: 'drug_not_heard', field: 'assessment_and_plan', severity: 'warning', message: `"${w}" is not in the recording. The recording names only ${sw} with the same dose, so the line now says ${sw}. Check which drug was prescribed.` });
        note(`unheard drug "${w}" -> "${sw}" (same ${dose} mg)`);
      } else {   // no other heard drug carries this dose: the name stays as written, the doctor is told
        flags.push({ type: 'drug_not_heard', field: 'assessment_and_plan', severity: 'warning', message: `"${w}" is in the draft but the recording does not clearly say this drug name. Check which drug was prescribed.` });
        note(`unheard drug "${w}" flagged`);
      }
    }
  }
  // a statin in a visit that never mentions cholesterol or heart risk
  const all = [...P.head, ...P.problems.flatMap((p) => p.lines), ...(P.follow ? P.follow.lines : [])].join('\n');
  const sm = all.match(STATIN);
  if (sm && !LIPID_CUE.test(T)) {
    const ppi = PPI_CUE.test(T);
    flags.push({ type: 'drug_context', field: 'note', severity: 'warning', message: `${sm[1]} is a cholesterol medicine, but the recording never mentions cholesterol or heart risk.${ppi ? ' The visit sounds like a stomach-acid medicine (for example Prevacid or Prilosec), so the name may have been misheard.' : ''} Check the drug name before signing.` });
    const strip = (s) => s.replace(new RegExp('\\b(' + sm[1] + ')\\s*\\(\\s*[a-z]+statin\\s*\\)', 'ig'), '$1');
    P.head = P.head.map(strip); for (const p of P.problems) p.lines = p.lines.map(strip); if (P.follow) P.follow.lines = P.follow.lines.map(strip);
    note(`statin ${sm[1]} without lipid context: flagged, generic label dropped`);
  }
}

// ── A3 unsupported diagnosis word in a title ───────────────────────────────────────────────
const DX_WORD = /\b(deficiency|insufficiency|anaemia|anemia|infection)\b/i;
const DX_FAMILY = { deficiency: /deficien|\blow\b|lack|short of/i, insufficiency: /insufficien|\blow\b|poor/i, anaemia: /an(a)?emi|\blow\b.*(iron|hemoglobin|haemoglobin)|(iron|hemoglobin|haemoglobin).*\blow\b/i, anemia: /an(a)?emi|\blow\b.*(iron|hemoglobin|haemoglobin)|(iron|hemoglobin|haemoglobin).*\blow\b/i, infection: /infect|pus|antibiotic/i };
function fixTitles(P, T, flags, note) {
  const sents = sentencesOf(T);
  for (const p of P.problems) {
    if (/screening|prevention|follow/i.test(p.title)) continue;
    const m = p.title.match(DX_WORD); if (!m) continue;
    const rest = p.title.replace(DX_WORD, '').replace(/\s+/g, ' ').trim(); if (rest.length < 3 || /\b(and|with|of|or|for|the)$/i.test(rest)) continue;
    const key = (rest.toLowerCase().match(/[a-z]{4,}/g) || []).sort((a, b) => b.length - a.length)[0]; if (!key) continue;
    const fam = DX_FAMILY[m[1].toLowerCase()];
    const where = m[1].toLowerCase() === 'infection' ? [T] : sents.filter((s) => s.toLowerCase().includes(key.slice(0, 6)));   // an infection is searched in the whole visit, a deficiency in the sentences about that thing
    if (where.some((s) => fam.test(s))) continue;
    flags.push({ type: 'diagnosis_not_said', field: 'assessment_and_plan', severity: 'warning', message: `"${p.title}": the recording never says "${m[1].toLowerCase()}". The problem is now named "${rest}". Check the diagnosis.` });
    note(`title: "${p.title}" -> "${rest}"`); p.title = rest;
  }
}

// ── A5 plan lines the recording does not support ───────────────────────────────────────────
const TESTS = [
  ['HbA1c', /\bhba1c\b|\ba1c\b/i, /a1c|glycated|glycosylated|hemoglobin a|haemoglobin a/i],
  ['fasting', /\bfasting\b/i, /\bfast(ing)?\b/i],
  ['ECG', /\b(ecg|ekg)\b/i, /ecg|ekg|electrocardio|heart tracing/i],
  ['echocardiogram', /\bechocardiogram\b/i, /echo/i],
  ['lipid panel', /\blipid (panel|profile)\b/i, /lipid/i],
  ['TSH', /\btsh\b/i, /\btsh\b|thyroid/i],
  ['CBC', /\bcbc\b/i, /\bcbc\b|blood count/i],
  ['urinalysis', /\burinalysis\b/i, /urin/i],
  ['ferritin', /\bferritin\b/i, /ferritin|iron/i],
  ['colonoscopy', /\bcolonoscopy\b/i, /colonoscop/i],
];
const REFERRAL_DONE = /\b(sent|submitted|faxed|placed|put in|made the referral|referred you|i('| ha)ve referred)\b/i;
function fixUnsupported(P, T, flags, note) {
  const monitorOnlyMaybe = (() => { const s = sentencesOf(T).filter((x) => /monitor/i.test(x)); return s.length > 0 && s.every((x) => /\b(if|whether|or not|anything)\b/i.test(x)); })();
  for (const p of [...P.problems, ...(P.follow ? [P.follow] : [])]) {   // the Follow-up item too
    const keep = [];
    for (const l of p.lines) {
      let line = l;
      // tests nobody named
      const missing = TESTS.filter(([, inNote, inT]) => inNote.test(line) && !inT.test(T));
      if (missing.length) {
        const sibling = p.lines.find((x) => x !== l && /^(repeat|arrange|order)/i.test(x) && toks(x).filter((w) => toks(l).includes(w)).length >= 2 && !missing.some(([, r]) => r.test(x)));
        if (sibling) { note(`unsupported test line dropped (${missing.map((x) => x[0]).join(', ')}): "${l.slice(0, 50)}"`); flags.push({ type: 'test_not_said', field: 'assessment_and_plan', severity: 'warning', message: `"${l}" named ${missing.map((x) => x[0]).join(' and ')}, which the recording never says. Dropped; "${sibling}" stays.` }); continue; }
        let n = line; for (const [, r] of missing) n = n.replace(new RegExp('\\s*(,|and|&|/)?\\s*' + r.source.replace(/\\b/g, ''), 'ig'), '');
        n = n.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
        flags.push({ type: 'test_not_said', field: 'assessment_and_plan', severity: 'warning', message: `"${l}" named ${missing.map((x) => x[0]).join(' and ')}, which the recording never says. Taken out of the line.` });
        note(`unsupported test word removed: "${l.slice(0, 50)}"`); line = n;
      }
      // home monitoring nobody mentioned
      if (/\bat home\b|\bhome (monitoring|readings?|blood pressure)\b/i.test(line) && !/\bhome\b/i.test(T)) {
        if (/^(monitor|check|record|measure|keep|log|take)\b/i.test(line)) { note(`home instruction dropped: "${line.slice(0, 50)}"`); flags.push({ type: 'plan_not_said', field: 'assessment_and_plan', severity: 'warning', message: `"${line}" - the recording never mentions home monitoring. Dropped.` }); continue; }
        flags.push({ type: 'plan_not_said', field: 'assessment_and_plan', severity: 'warning', message: `"${line}" - the recording never says "home". Check this line.` });   // an observation, not an instruction: kept, but the doctor is told
      }
      // referral said as done
      if (/^Referral\b/i.test(line) && /\b(sent|placed|made|submitted|faxed)\s*$/i.test(line) && !REFERRAL_DONE.test(T)) { const n = line.replace(/\s*\b(sent|placed|made|submitted|faxed)\s*$/i, ''); note(`referral status removed: "${line.slice(0, 50)}"`); line = n; }
      // monitoring that was only a maybe
      if (monitorOnlyMaybe && /^Arrange\b.*\bmonitoring\b/i.test(line) && p.lines.some((x) => /^Referral/i.test(x))) { note(`maybe-monitoring dropped: "${line.slice(0, 50)}"`); flags.push({ type: 'plan_not_said', field: 'assessment_and_plan', severity: 'warning', message: `"${line}" - the recording mentions monitoring only as a possibility for the specialist. Dropped.` }); continue; }
      keep.push(line);
    }
    p.lines = keep;
  }
}

/** "daily (at least four times weekly)": the doctor said both; the note must not blend them silently. */
function flagFrequency(P, flags) {
  for (const p of P.problems) for (const l of p.lines) {
    if (/\b(daily|every day)\b/i.test(l) && /\b(at least|up to)?\s*(\w+)\s+times\s+(a|per)\s+week\b|\bweekly\b|\bfour times (a )?week/i.test(l) && isDrugLine(l)) {
      flags.push({ type: 'frequency_conflict', field: 'assessment_and_plan', severity: 'warning', message: `"${l.replace(VERB, '').slice(0, 90)}" gives two frequencies (every day and a number of times a week). The recording has both; confirm which one the patient was told.` });
    }
  }
}

// ── A6 medicines not being taken, repeats ──────────────────────────────────────────────────
const NOT_TAKING = /\b(miss(ed|ing)|not taking|not taken|did not take|didn'?t take|discontinued|stopped|non-?complian\w*|non-?adheren\w*|off (the )?(medication|treatment|therapy))\b/i;
function markNotTaking(P, note) {
  const secs = sections(P.head); const pmh = secs.find((s) => /past medical/i.test(s.name)); if (!pmh) return;
  for (let i = pmh.from; i < pmh.to; i++) {
    const m = P.head[i].match(/^(\s*[-•*]\s+Medications?:\s*)(.*)$/i); if (!m) continue;
    const others = [...P.head.filter((_, j) => j !== i), ...P.problems.flatMap((p) => p.lines)];
    const items = m[2].replace(/\.\s*$/, '').split(/,\s+(?![^()]*\))/);
    const tagged = items.map((it) => {
      if (/not (currently )?taking/i.test(it)) return it;
      const w = it.match(/^[A-Za-z]{4,}/); const first = w ? w[0].toLowerCase() : '';
      if (/^(medication|medications|medicine|medicines|pill|pills|tablet|tablets|second|other|my|the|name)$/.test(first)) return it;   // too generic to match a line about "missed medications"
      const key = /^(blood|high|water|heart)$/.test(first) ? it.toLowerCase().split(/\s+/).slice(0, 2).join(' ') : first;
      if (!key) return it;
      const RESUMED = /\b(resum\w*|back on|restart\w*|(taking|taken) (them|it) again)\b/i;   // the patient is taking it again: not "not taking"
      const resumed = P.head.some((o, j) => j !== i && RESUMED.test(o) && (o.toLowerCase().includes(key) || /\b(medications?|meds|medicines?)\b/i.test(o)));
      const hit = !resumed && others.some((o) => o.toLowerCase().includes(key) && NOT_TAKING.test(o));
      if (hit) {
        note(`medication marked not taking: "${it.slice(0, 40)}"`);
        // a drug the patient is not taking is resumed, not continued
        for (const p of P.problems) p.lines = p.lines.map((l) => { if (/^Continue\s/.test(l) && l.toLowerCase().includes(key)) { note(`verb: "${l.slice(0, 40)}" -> Resume`); return l.replace(/^Continue\s/, 'Resume '); } return l; });
      }
      return hit ? it + ' (not currently taking)' : it;
    });
    P.head[i] = m[1] + tagged.join(', ') + '.';
  }
}
const STATUS = new Set('sent made placed arranged provided given done submitted faxed completed'.split(' '));
function mergeRepeats(P, note) {
  for (const p of P.problems) {
    // "declined X" next to "consider X"
    const declined = p.lines.filter((l) => /\b(declin\w*|refus\w*|does not want|doesn'?t want)\b/i.test(l));
    if (declined.length) p.lines = p.lines.filter((l) => {
      if (declined.includes(l) || !/^(consider|refer|offer|see|arrange)/i.test(l)) return true;
      const k = (w) => norm(w).slice(0, 5);
      const mine = (l.match(/[A-Za-z]{6,}/g) || []).map(k);
      const clash = declined.some((d) => (d.match(/[A-Za-z]{6,}/g) || []).map(k).some((x) => mine.includes(x) && !['consi', 'refer', 'offer', 'sugar'].includes(x)));
      if (clash) note(`contradiction dropped: "${l.slice(0, 50)}" (declined line stays)`);
      return !clash;
    });
    // a prescription said twice
    const hasRx = (x) => /prescription/i.test(x) && x.length > 40;
    p.lines = p.lines.filter((l) => { const lone = /^prescription\b.*\b(given|provided|handed|printed|issued)/i.test(l) && l.length < 60; if (lone && p.lines.some((x) => x !== l && hasRx(x))) { note(`prescription repeat dropped: "${l.slice(0, 40)}"`); return false; } return true; });
    // token-subset repeats (a referral twice, a follow-up twice)
    const sig = (l) => toks(l).filter((w) => !STATUS.has(w));
    const dropped = new Set();
    p.lines.forEach((a, i) => p.lines.forEach((b, j) => {
      if (i === j || dropped.has(i) || dropped.has(j)) return;
      const A = sig(a), B = sig(b); const need = /^Referral/i.test(a) && /^Referral/i.test(b) ? 2 : 3;
      if (A.length >= need && A.length <= B.length && subset(A, B) && (A.length < B.length || i > j)) { dropped.add(i); note(`repeat dropped: "${a.slice(0, 50)}"`); }
    }));
    if (dropped.size) p.lines = p.lines.filter((_, i) => !dropped.has(i));
  }
}
const KEYS = { hemoglobin: ['hemoglobin', 'haemoglobin'], kidney: ['kidney', 'renal'], sodium: ['sodium'], potassium: ['potassium'], liver: ['liver', 'hepatic'], sugar: ['sugar', 'glucose'], cholesterol: ['cholesterol', 'ldl', 'lipid'], lymphocytes: ['lymphocyte'], neutrophils: ['neutrophil'] };
const keysIn = (s) => { const x = s.toLowerCase().replace(/haemo/g, 'hemo'); return Object.entries(KEYS).filter(([, v]) => v.some((w) => x.includes(w.replace('haemo', 'hemo')))).map(([k]) => k); };
const ASKS = /\b(asks?|acknowledg\w*|reports?|states?|denies|wants?|concern\w*|worr\w*|scared|feels?|says?)\b/i;
const RESULT_WORD = /\b(normal|fine|borderline|high|elevated|low)\b/i;
function resultsOnce(P, note) {
  const secs = sections(P.head); const sub = secs.find((s) => /subjective/i.test(s.name)); const obj = secs.find((s) => /objective/i.test(s.name)); const pmh = secs.find((s) => /past medical/i.test(s.name));
  if (!obj) return;
  const objText = () => P.head.slice(obj.from, obj.to).join('\n');
  const drop = new Set();
  // short "x: fine" lines that a longer Objective line already says
  for (let i = obj.from; i < obj.to; i++) {
    const m = P.head[i].match(/^\s*[-•*]\s+([A-Za-z]+):\s*(fine|normal|borderline|high|very high|elevated|low)\.?\s*$/i); if (!m) continue;
    const ks = keysIn(m[1]); const others = P.head.slice(obj.from, obj.to).filter((_, k) => obj.from + k !== i && P.head[obj.from + k].length > P.head[i].length);
    if (ks.length && ks.every((k) => others.some((o) => keysIn(o).includes(k)))) { drop.add(i); note(`objective repeat dropped: "${P.head[i].trim()}"`); }
  }
  // blood results told in Subjective with no patient statement, when Objective has them
  if (sub) for (let i = sub.from; i < sub.to; i++) {
    const l = P.head[i]; if (!/^\s*[-•*]\s/.test(l) || ASKS.test(l) || !RESULT_WORD.test(l)) continue;
    if (!/^\s*[-•*]\s+[A-Za-z ,/&]{3,70}\b(is|are|was|were)\s+(all\s+)?(?:(?:very|still|again|now)\s+)*(normal|fine|borderline(?: high)?|high|elevated|low)(?:\s+again)?\.?\s*$/i.test(l)) continue;   // a bare result sentence only; a line with history or advice in it stays
    const ks = keysIn(l); if (!ks.length) continue;
    const ot = objText().toLowerCase().replace(/haemo/g, 'hemo');
    if (ks.every((k) => KEYS[k].some((w) => ot.includes(w.replace('haemo', 'hemo'))))) { drop.add(i); note(`subjective result repeat dropped: "${l.trim().slice(0, 50)}"`); }
  }
  // a past evaluation is history, not an exam finding
  const moved = [];
  for (let i = obj.from; i < obj.to; i++) {
    if (drop.has(i)) continue;
    if (pmh && /^\s*[-•*]\s+(previous(ly)?|prior)\s+(evaluation|evaluated|seen|assessed|review)\w*/i.test(P.head[i]) && /\b(\d+ years? ago|dr\.)/i.test(P.head[i])) { moved.push(P.head[i]); drop.add(i); note(`past evaluation moved to Past Medical History: "${P.head[i].trim().slice(0, 50)}"`); }
  }
  if (!drop.size) return;
  let after = -1;   // the last line of Past Medical History that stays: the past evaluation goes right under it
  if (moved.length && pmh) for (let i = pmh.to - 1; i >= pmh.from; i--) if (P.head[i].trim() && !drop.has(i)) { after = i; break; }
  const out = [];
  P.head.forEach((l, i) => { if (!drop.has(i)) out.push(l); if (i === after) out.push(...moved); });
  P.head = out;
}

export function safetyPass(md, transcript = '', log = () => {}) {
  const flags = []; if (!md) return { md, flags };
  const T = String(transcript || ''); const changes = []; const note = (s) => changes.push(s);
  const P = parse(md);
  if (T.length >= 200) {   // checks against the recording need a recording
    fixSocial(P, T, flags, note);
    fixDrugs(P, T, flags, note);
    fixTitles(P, T, flags, note);
    fixUnsupported(P, T, flags, note);
    flagFrequency(P, flags);
  }
  markNotTaking(P, note);
  mergeRepeats(P, note);
  resultsOnce(P, note);
  if (!changes.length) return { md, flags };
  log(`[v2:safety] ${changes.length} change(s): ` + changes.join(' | '));
  return { md: render(P), flags };
}
