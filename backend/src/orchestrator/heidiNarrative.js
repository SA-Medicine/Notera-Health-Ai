// ─────────────────────────────────────────────────────────────────────────────
// heidiNarrative — LLM narrative composition pass (Heidi flow + completeness).
//
// Takes the deterministic schema note (grounded, structured) PLUS the raw transcript
// and rewrites the PROSE fields into flowing, intelligently-summarised Heidi-style
// clinical narrative. Because it can see the transcript, it may also RECOVER relevant
// details that belong in a field but were missed by extraction — but ONLY facts that
// are explicitly present in the transcript. It may never invent, infer, or assume.
//
// Guards: every rewritten field is checked — a number that appears in neither the
// field's source text nor the transcript is rejected (hallucination); a populated
// field is never blanked; runaway expansion is rejected. On any parse/LLM failure the
// note is returned unchanged (deterministic text stands).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const S = () => ({ type: 'STRING' });

const SUBJ = ['reason_for_visit', 'hpi_details', 'aggravating_relieving_factors',
  'symptom_progression', 'previous_episodes', 'functional_impact', 'associated_symptoms'];
const PMH = ['medical_surgical', 'social', 'family', 'exposure', 'immunisation', 'other'];

const SYS = `You are Notera's Heidi note writer. You are given (a) the raw consultation
transcript and (b) individual fields of a clinical SOAP note that were extracted from it.
Rewrite each field so it reads as flowing, natural, intelligently SUMMARISED clinical prose
in the exact style of a Heidi note — clear sentences a clinician would write, and MORE
complete than a terse fact list.

WHAT YOU MAY DO:
- Rephrase and connect the field's facts into readable, well-ordered clinical prose.
- RECOVER additional details that clearly belong in THIS field and are EXPLICITLY present in
  the transcript but were missing from the extracted text (this makes the note more complete).
- Keep body-part grouping: if a field's input has "Body Part: …" lines (e.g. "Right Hip/Leg:"),
  preserve one flowing labelled line per body part so the note stays bifurcated by region.

ABSOLUTE RULES:
1. GROUNDING: use ONLY information explicitly stated in the transcript. Never invent, infer,
   assume, or embellish any detail, number, medication, diagnosis, date, dose or value.
2. NEVER DROP a fact already in the field. Only add; never remove.
3. Put each fact in the RIGHT field only — do not duplicate the same fact across fields, and do
   not move vitals/labs/plan actions into a subjective/history field.
4. If a field genuinely has no supporting content in the transcript, return it EXACTLY as given
   (or "" if it was empty). Never write "not mentioned", "N/A", "none", or meta commentary.
5. Be faithful and concise — richer than the input, but no padding and no speculation.
6. Return STRICT JSON with exactly the same keys you were given, each a rewritten string.`;

function nums(s) { return String(s || '').match(/\d+(?:\.\d+)?/g) || []; }

const STOP = new Set(('the a an and or of to in on for with at by is are was were be been being has have had as that this it its their his her he she from into within not no also but had will would can could may might do does done other'.split(' ')));
function contentToks(s) { return (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 3 && !STOP.has(w)); }

export async function narrateNote(note, opts = {}) {
  const { llm = null, transcript = '' } = opts;
  if (!llm || !note) return note;

  // Target prose fields (send even when empty so the model can recover missed content).
  const src = {};
  for (const k of SUBJ) src[`subjective.${k}`] = note.subjective?.[k] || '';
  for (const k of ['medical_surgical', 'social', 'family']) src[`pmh.${k}`] = note.past_medical_history?.[k] || '';
  src['objective.examination'] = note.objective?.examination || '';
  (note.assessment_and_plan || []).forEach((it, i) => {
    if (it.assessment?.trim()) src[`ap.${i}.assessment`] = it.assessment;
  });
  const keys = Object.keys(src);
  const schema = { type: 'OBJECT', properties: Object.fromEntries(keys.map((k) => [k, S()])) };

  const tnums = new Set(nums(transcript));

  let out;
  try {
    const raw = await llm.generateContent(
      SYS,
      `TRANSCRIPT (sole source of truth):\n"""\n${transcript}\n"""\n\nNOTE FIELDS to rewrite (return ONLY JSON with these exact keys):\n${JSON.stringify(src, null, 2)}`,
      schema,
      { timeoutMs: 150000, retries: 1, maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536, thinkingBudget: 0 }
    );
    out = JSON.parse(String(raw).replace(/^```(json)?/i, '').replace(/```$/, '').trim());
  } catch (e) {
    console.warn('[heidiNarrative] narration failed, keeping deterministic text:', e.message);
    return note;
  }

  const accept = (orig, next) => {
    if (typeof next !== 'string') return orig;
    const t = next.trim();
    if (!t) return orig;                                          // never blank a field
    if (orig.trim() && !t) return orig;
    const srcN = new Set(nums(orig));
    for (const n of nums(t)) if (!srcN.has(n) && !tnums.has(n)) return orig;   // ungrounded number
    const oTok = contentToks(orig);
    if (oTok.length) {
      const nSet = new Set(contentToks(t));
      const kept = oTok.filter((w) => nSet.has(w)).length;
      if (kept / oTok.length < 0.8) return orig;   // lossy rewrite dropped facts → keep deterministic
    }
    if (t.length > Math.max(240, (orig.length || 60) * 2.6)) return orig;      // runaway expansion
    return t;
  };

  for (const k of keys) {
    if (!(k in out)) continue;
    const val = accept(src[k], out[k]);
    if (k.startsWith('subjective.')) note.subjective[k.slice(11)] = val;
    else if (k.startsWith('pmh.')) note.past_medical_history[k.slice(4)] = val;
    else if (k === 'objective.examination') note.objective.examination = val;
    else if (k.startsWith('ap.')) {
      const i = Number(k.split('.')[1]);
      if (note.assessment_and_plan[i]) note.assessment_and_plan[i].assessment = val;
    }
  }
  return note;
}
