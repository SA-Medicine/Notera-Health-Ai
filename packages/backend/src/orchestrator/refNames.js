// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Reference names (public NIH services, no key, no patient data — only drug names / diagnosis words leave the server):
//   describeMeds      RxNorm exact-name lookup. A BRAND the clinician said gets its generic ingredient in brackets:
//                     "Synthroid 88 mcg daily" -> "Synthroid (levothyroxine) 88 mcg daily". A generic stays unchanged. A name
//                     RxNorm does not know exactly (a mis-hearing, "perindopril plus") is NEVER guessed — it stays as spoken.
//   codeDiagnoses     ICD-10-CM (NLM Clinical Table Search). A stated diagnosis that matches a reference term gets its code in
//                     note.metadata.problem_codes (the wording is not changed); one that matches nothing gets a review flag.
// Both are cached, time-boxed (default 2.5 s per call), run in parallel and can never fail a note.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
'use strict';

const RX = () => (process.env.RXNORM_BASE_URL || 'https://rxnav.nlm.nih.gov/REST').replace(/\/+$/, '');
const ICD = () => process.env.ICD_BASE_URL || 'https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search';
const cache = new Map();

async function getJson(url, timeoutMs, fetchImpl) {
  if (cache.has(url)) return cache.get(url);
  const f = fetchImpl || fetch; const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await f(url, { signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); cache.set(url, j); if (cache.size > 2000) cache.delete(cache.keys().next().value); return j; } finally { clearTimeout(t); }
}

/** → { ingredient, brand } for an exactly known name, else null. */
export async function rxIngredient(name, { timeoutMs = 2500, fetchImpl } = {}) {
  const n = String(name || '').trim(); if (n.length < 4 || /\s/.test(n)) return null;
  const id = ((await getJson(`${RX()}/rxcui.json?name=${encodeURIComponent(n)}&search=1`, timeoutMs, fetchImpl))?.idGroup?.rxnormId || [])[0]; if (!id) return null;
  const groups = (await getJson(`${RX()}/rxcui/${id}/related.json?tty=IN+BN`, timeoutMs, fetchImpl))?.relatedGroup?.conceptGroup || [];
  const names = (tty) => groups.filter((g) => g.tty === tty).flatMap((g) => (g.conceptProperties || []).map((c) => String(c.name || '')));
  const ingredients = names('IN').map((x) => x.replace(/,?\s*USP$/i, '').trim()).filter(Boolean);
  const brands = names('BN').map((x) => x.toLowerCase());
  return { ingredient: ingredients.slice(0, 2).join(' / '), brand: brands.includes(n.toLowerCase()) };
}

/** Adds the generic name after a spoken brand wherever it appears in the note. Returns [{ spoken, generic }]. */
export async function describeMeds(note, names, { log = () => {}, timeoutMs, fetchImpl } = {}) {
  const uniq = [...new Set((names || []).map((x) => String(x || '').trim()).filter((x) => /^[A-Za-z][A-Za-z-]{3,}$/.test(x)))].slice(0, 10);
  const out = [];
  const found = await Promise.all(uniq.map((n) => rxIngredient(n, { timeoutMs, fetchImpl }).then((r) => [n, r]).catch(() => [n, null])));
  for (const [spoken, r] of found) {
    if (!r || !r.brand || !r.ingredient) continue;
    if (r.ingredient.toLowerCase().split(' / ').some((g) => spoken.toLowerCase() === g)) continue;
    const rx = new RegExp('\\b' + spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?!\\s*\\()', 'g'); let n = 0;
    const fix = (v) => (typeof v === 'string' ? v.replace(rx, (m) => { n++; return `${m} (${r.ingredient.toLowerCase()})`; }) : v);
    // only the first mention per field is annotated, so a plan with the same brand five times stays readable
    const once = (v) => { let seen = false; return typeof v === 'string' ? v.replace(rx, (m) => (seen ? m : ((seen = true), n++, `${m} (${r.ingredient.toLowerCase()})`))) : v; };
    for (const sec of ['past_medical_history']) for (const k of Object.keys(note[sec] || {})) note[sec][k] = once(note[sec][k]);
    for (const p of note.assessment_and_plan || []) for (const f of ['treatment_planned', 'assessment']) p[f] = once(p[f]);
    if (n) { out.push({ spoken, generic: r.ingredient }); log(`[v2:ref] ${spoken} = ${r.ingredient} (RxNorm)`); }
  }
  return out;
}

/** Attaches ICD-10-CM codes to stated diagnoses; flags a diagnosis that matches no reference term. */
export async function codeDiagnoses(note, { log = () => {}, timeoutMs, fetchImpl } = {}) {
  const res = [];
  const todo = (note.assessment_and_plan || []).filter((p) => String(p.diagnosis || '').trim()).slice(0, 8);
  await Promise.all(todo.map(async (p) => {
    const term = String(p.diagnosis).replace(/\(.*?\)/g, '').replace(/[,;].*$/, '').trim();
    try {
      const j = await getJson(`${ICD()}?sf=code,name&terms=${encodeURIComponent(term)}&maxList=15`, timeoutMs || 2500, fetchImpl);
      const hits = (j?.[3] || []).map(([code, name]) => ({ code, name }));
      const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      // a code is attached only for the exact term or its "…, unspecified" entry — never a more specific subtype (a wrong code is worse than none)
      const t = term.toLowerCase();
      const best = hits.find((h) => h.name.toLowerCase() === t) || hits.find((h) => h.name.toLowerCase() === `${t}, unspecified`) || null;
      if (best) { (note.metadata.problem_codes ||= []).push({ issue: p.issue, diagnosis: p.diagnosis, icd10: best.code, reference: best.name }); res.push({ diagnosis: p.diagnosis, icd10: best.code }); }
      else if (hits.length === 0 && words.length) { (note.metadata.flags ||= []).push({ type: 'diagnosis_not_in_reference', field: 'diagnosis', severity: 'info', message: `"${p.diagnosis}" was not found in the ICD-10-CM reference — please check the wording.` }); res.push({ diagnosis: p.diagnosis, icd10: null }); }
    } catch { /* reference unreachable: note unchanged */ }
  }));
  if (res.length) log(`[v2:ref] ICD-10-CM: ${res.map((r) => `${r.diagnosis}${r.icd10 ? ' → ' + r.icd10 : ' (no match)'}`).join('; ')}`);
  return res;
}
