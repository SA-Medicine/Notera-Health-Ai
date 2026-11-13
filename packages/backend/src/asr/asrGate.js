// Speech-output gate (2026-11-13). Two guards around the speech engine, both pure code apart from one small, rare second opinion.
//
// Why: Gemini (a generative model) wrote a prescription sentence the doctor never said at the END of three real visits ("I'm going to give you a prescription for
// 20 milligrams of Prednisone ... an inhaler called Albuterol ..."); two other speech runs of the same audio (Chirp 2 twice, Gemini on other audio) ended at the real
// last words. Amplifying a quiet ending made it worse (a 100-word visit came back as a 292-word invented cardiology handover). So:
//
//  1. trimSilentTail   a recording that ends in several seconds of silence or room noise is cut a moment after its last speech, so the model has no empty room to fill.
//                      Nothing is ever amplified. Quiet speech counts as speech (the threshold is the recording's own noise floor + 9 dB).
//  2. verifyTail       when the finished transcript ends with a "going to give you a prescription for X ..." statement, ONE other engine (Chirp 2) hears only the last
//                      75 seconds. If it does not hear the drug named, the statement is cut. Costs about a cent, and only on the few visits that end that way.
//                      If the second engine fails, the transcript is left alone (never delete without evidence).
//
// ASR_TRIM_TAIL=0 and ASR_TAIL_GATE=0 switch the two parts off. Never logs transcript text.
'use strict';

const SR = 16000, BPS = 32000;

/** RMS (0..32768) of each `winMs` window of 16 kHz mono 16-bit PCM. */
export function windowRms(pcm, winMs = 250) {
  const n = Math.floor(SR * winMs / 1000); const out = [];
  for (let i = 0; i + n * 2 <= pcm.length; i += n * 2) { let s = 0; for (let j = 0; j < n; j++) { const v = pcm.readInt16LE(i + j * 2); s += v * v; } out.push(Math.sqrt(s / n)); }
  return out;
}

/**
 * Cut trailing silence/room noise. → { pcm, trimmedS, thresholdDb }.
 * Speech window = rms above (noise floor + 9 dB, never below -50 dBFS); the cut is `padS` after the last speech window, only when the silent tail is at least `minTailS`
 * and at least `minKeepS` of audio remains.
 */
export function trimSilentTail(pcm, { winMs = 250, minTailS = 5, padS = 1.5, minKeepS = 8 } = {}) {
  const none = { pcm, trimmedS: 0, thresholdDb: null };
  if (!pcm || pcm.length < (minTailS + minKeepS) * BPS) return none;
  const rms = windowRms(pcm, winMs); if (rms.length < 20) return none;
  const sorted = [...rms].sort((a, b) => a - b); const floor = Math.max(1, sorted[Math.floor(sorted.length * 0.1)]);
  // +9 dB over the recording's noise floor, kept between -52 and -48 dBFS. The ceiling matters: in a file with little true silence the "floor" can land inside quiet speech
  // (a far speaker sits near -45 dBFS), and a threshold above that would cut the end of the visit. A noisy room (floor above -48) simply isn't trimmed.
  const lin = (db) => 32768 * Math.pow(10, db / 20);
  const thr = Math.min(lin(-48), Math.max(floor * 2.8, lin(-52)));
  let last = -1; for (let i = rms.length - 1; i >= 0; i--) { if (rms[i] > thr && (rms[i - 1] > thr || rms[i + 1] > thr)) { last = i; break; } }   // two neighbouring windows: a click is not speech
  if (last < 0) return none;
  const endS = (last + 1) * winMs / 1000; const totalS = pcm.length / BPS; const tailS = totalS - endS;
  if (tailS < minTailS) return none;
  const keepS = Math.max(minKeepS, endS + padS); if (keepS >= totalS - 0.5) return none;
  const bytes = Math.floor(keepS * SR) * 2;
  return { pcm: pcm.subarray(0, bytes), trimmedS: +(totalS - keepS).toFixed(1), thresholdDb: +(20 * Math.log10(thr / 32768)).toFixed(1) };
}

/**
 * Non-speech output of a Gemini window: Gemini 3.5 answers a silent clip with a bare "00:00" or a sound word ("cough"). That is not speech and must never reach the note.
 * Removes 00:SS stamps and [sound] / (sound) labels; a window that is nothing but a stamp or a sound word becomes ''. Real clock times a patient says ("8:30") are untouched.
 */
const SOUND = 'cough|coughing|cough cough|laughter|laughs|laughing|music|silence|noise|background noise|sigh|sighs|inaudible|static|clears throat|sniffle|breathing|typing|crosstalk';
export function cleanAsrText(text) {
  let t = String(text || '');
  t = t.replace(/\[(?:[^\]]{1,30})\]|\((?:[^)]{1,30})\)/g, (m) => (new RegExp(`^[\\[(]\\s*(?:${SOUND})\\s*[\\])]$`, 'i').test(m) ? ' ' : m));
  t = t.replace(/\b00:\d{2}(?::\d{2})?\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (new RegExp(`^(?:${SOUND})[.!?]*$`, 'i').test(t)) return '';
  return t;
}

// ── invented prescription ending ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TRIGGER = /\b(?:I'?m|I am|I'?ll|I will|we'?re|we are)\s+(?:also\s+)?(?:going to\s+)?(?:give|write|prescribe)\s+you\s+(?:a|an|the)?\s*(?:prescription|script|refill)|\bprescription for (?:an? )?(?:\d|[A-Za-z]+ milligrams)|\byou'?re going to take (?:one|two|three|four|\d+|that|this|it)\b/i;
const FOLLOW = /\bgoing to (?:take|give|use|start|put)\b|\bprescription\b|\binhaler\b|\bpuffs?\b|\btablets?\b|\bcapsules?\b|\bmilligrams?\b|\bmg\b|\bby mouth\b|\bevery \d+ hours\b|\bas needed\b|\bonce a day\b|\btwice a day\b|\bfor (?:\d+|five|three|seven|ten|two) days\b/i;
const GENERIC = new Set('prescription prescriptions milligrams milligram tablets tablet capsules capsule going take taking give giving mouth once daily twice times every hours days weeks puffs puff needed called inhaler also script refill'.split(' '));

/** Split into sentences with their positions. */
function sentences(text) { const out = []; const rx = /[^.?!]+[.?!]*\s*/g; let m; while ((m = rx.exec(text))) { if (!m[0].trim()) continue; out.push({ s: m[0], start: m.index, end: m.index + m[0].length }); } return out; }

/** The stock statement near the end: { drop:[sentence indexes], drugs:[names], parts } or null. Looks only at the last `window` characters. */
export function stockTail(text, { window = 700 } = {}) {
  const t = String(text || ''); if (t.length < 40) return null;
  const sents = sentences(t); const from = t.length - window;
  const first = sents.findIndex((x) => x.end > from && TRIGGER.test(x.s)); if (first < 0) return null;
  const drop = [first]; for (let i = first + 1; i < sents.length; i++) { if (FOLLOW.test(sents[i].s) || TRIGGER.test(sents[i].s)) drop.push(i); else break; }
  const blob = drop.map((i) => sents[i].s).join(' ');
  const drugs = new Set();
  for (const re of [/(?:mg|milligrams?)\s+(?:of\s+)?([A-Za-z][A-Za-z-]{4,})/gi, /\bcalled\s+([A-Za-z][A-Za-z-]{4,})/gi, /prescription for (?:an? )?(?:[a-z]+ )?([A-Z][a-z]{4,})/g]) { let m; while ((m = re.exec(blob))) { const w = m[1].toLowerCase(); if (!GENERIC.has(w)) drugs.add(w); } }
  return { drop, drugs: [...drugs], sents, blob };
}

/** Remove the sentences at `drop` (indexes into `sents`) from `text`. */
export function cutSentences(text, sents, drop) {
  const set = new Set(drop); let out = ''; sents.forEach((x, i) => { if (!set.has(i)) out += x.s; }); return out.replace(/\s{2,}/g, ' ').trim();
}

const pre5 = (w) => String(w).toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);

/**
 * If the transcript ends with a prescription statement naming a drug, a second engine hears the last 75 seconds; no drug heard there = the statement is cut.
 * `runners.v2(pcm, 'chirp_2', log)` -> { text }. → { text, meta }.
 */
export async function verifyTail({ text, pcm, runners, log = () => {}, tailSeconds = 75, timeoutMs = 30000 }) {
  const meta = { checked: false };
  try {
    const st = stockTail(text); if (!st) return { text, meta };
    meta.checked = true; meta.drugs = st.drugs;
    if (!st.drugs.length) { meta.result = 'no drug named, left alone'; return { text, meta }; }
    const run = runners?.v2; if (!run || !pcm || pcm.length < BPS * 5) { meta.result = 'unverified (no second engine)'; return { text, meta }; }
    const tail = pcm.subarray(Math.max(0, pcm.length - tailSeconds * BPS));
    let other = '';
    try { const r = await Promise.race([Promise.resolve(run(tail, 'chirp_2', log)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]); other = String(r?.text || ''); }
    catch (e) { meta.result = `unverified (${String(e.message).slice(0, 60)})`; return { text, meta }; }
    if (!other.trim()) { meta.result = 'unverified (second engine heard nothing)'; return { text, meta }; }
    const heard = new Set(other.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).map(pre5));
    if (st.drugs.some((d) => heard.has(pre5(d)))) { meta.result = 'confirmed by a second engine'; return { text, meta }; }
    const cut = cutSentences(text, st.sents, st.drop);
    meta.result = 'cut'; meta.removed = st.blob.length; log(`[asr] the last ${st.drop.length} sentence(s) name ${st.drugs.join('/')}; a second engine does not hear it in the final ${tailSeconds} s - cut`);
    return { text: cut, meta };
  } catch (e) { meta.result = `skipped (${String(e.message).slice(0, 60)})`; return { text, meta }; }
}
