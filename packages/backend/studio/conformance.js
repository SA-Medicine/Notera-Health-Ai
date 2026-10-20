// Style Spec v1 conformance: deterministic checks of a RENDERED note (what the doctor reads) against the approved rules in
// spec/style-spec-v1.json. Pure functions, no model call, no side effects — Studio uses them to score every note and to run the gate.
'use strict';

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SPEC = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../spec/style-spec-v1.json', import.meta.url)), 'utf8'));
const RULE = Object.fromEntries(SPEC.rules.map((r) => [r.id, r]));

const STOP = new Set('with that this from will have been were also after about their there which patient today planned your should would please'.split(' '));
const cw = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
const overlap = (a, b) => { const A = cw(a), B = cw(b); if (A.size < 3 || B.size < 3) return 0; return [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size); };
const words = (t) => (String(t).match(/\S+/g) || []).length;

/** Rendered markdown -> { Subjective: [{type:'head'|'bullet', text}], 'Past Medical History': [...], Objective: [...], plan: [{title, items:[{label,text}]}] } */
export function parseRendered(md) {
  const out = { Subjective: [], 'Past Medical History': [], Objective: [], plan: [] };
  let cur = null; let prob = null;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^###\s+(.*)$/);
    if (h) { const t = h[1].trim(); cur = /^Assessment/i.test(t) ? 'A&P' : t; prob = null; continue; }
    if (!cur || !line.trim()) continue;
    if (cur === 'A&P') {
      const p = line.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/);
      if (p) { prob = { n: Number(p[1]), title: p[2].trim(), items: [] }; out.plan.push(prob); continue; }
      const b = line.match(/^\s+[-*]\s+(?:([A-Za-z ]{3,30}):\s+)?(.*)$/);
      if (b && prob) { prob.items.push({ label: (b[1] || '').trim(), text: b[2].trim() }); continue; }
      continue;
    }
    if (!out[cur]) continue;
    const head = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (head) { out[cur].push({ type: 'head', text: head[1].replace(/:$/, '').trim() }); continue; }
    const bl = line.match(/^\s*[-*]\s+(.*)$/);
    out[cur].push({ type: 'bullet', text: (bl ? bl[1] : line).trim() });
  }
  return out;
}

const ADDRESS_VERB = /\b(?:lives?|lived|living|resides?|resided|moved|relocated|stays?|staying)\s+(?:in|on|at|to|near)\s+(?:an?\s+|the\s+)?(\S+)/i;
const STREET = /\b\d{1,5}\s+[A-Z][\w'-]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Lane|Ln|Court|Ct)\b|\b(?:Street|Avenue|Boulevard)\b/;
const ADDRESS = { test: (t) => { const m = String(t).match(ADDRESS_VERB); return (!!m && /^[A-Z]/.test(m[1])) || STREET.test(String(t)); } };
const NOT_MENTIONED = /\b(unspecified|not (mentioned|specified|stated|documented)|none mentioned|not reported)\b/i;
const RESTATES = /^(the\s+)?patient\s+(reports?|states?|has|had|previously|denies|is|was|continues|stopped|noncompliant|non-compliant|requires|needs)\b|^history of\b|^reports?\b/i;
const SYMPTOM = /\b(pain|cough|fever|nausea|headache|dizziness|dyspnoea|dyspnea|shortness of breath|fatigue|rash|vomiting|diarrh|constipation|swelling)\b/i;
const LIFESTYLE = /(lifestyle|diet|social|smok|alcohol|famil|habit|exercise)/i;

/** → { score 0..1, checks, passed, failed:[{rule, section, severity, detail}] } */
export function conformance(rendered) {
  const P = parseRendered(rendered); const failed = []; let checks = 0;
  const fail = (rule, detail) => failed.push({ rule, section: RULE[rule]?.section, severity: RULE[rule]?.severity || 'minor', detail: String(detail).slice(0, 160) });
  const check = (rule, ok, detail) => { checks++; if (!ok) fail(rule, detail); };

  const subj = P.Subjective; const sb = subj.filter((x) => x.type === 'bullet'); const sh = subj.filter((x) => x.type === 'head');
  if (subj.length) {
    check('S1', sb.length <= 3 || (sh.length >= 2 && /presenting/i.test(sh[0]?.text || '')), sb.length <= 3 ? '' : `topics: ${sh.length}, first: "${sh[0]?.text || 'none'}"`);
    const long = sb.find((b) => words(b.text) > 24); check('S2', !long, long ? `${words(long.text)} words: "${long.text.slice(0, 70)}…"` : '');
    const life = sh.find((x) => LIFESTYLE.test(x.text)); check('S3', !life, life ? `topic "${life.text}"` : '');
    let dup = null; for (let i = 0; i < sb.length && !dup; i++) for (let j = i + 1; j < sb.length; j++) if (overlap(sb[i].text, sb[j].text) >= 0.8) { dup = sb[j].text; break; }
    check('S4', !dup, dup ? `repeats: "${dup.slice(0, 70)}"` : '');
    const the = sb.filter((b) => /^the patient\b/i.test(b.text)).length; check('S5', the <= 1, `${the} bullets start with "The patient"`);
  }
  const pmh = P['Past Medical History'].filter((x) => x.type === 'bullet');
  if (pmh.length) {
    check('P1', pmh.length <= 8, `${pmh.length} bullets`);
    const meds = pmh.filter((b) => /^medications?\s*:/i.test(b.text)); check('P2', meds.length <= 1, `${meds.length} Medications lines`);
    if (meds[0]) { const names = meds[0].text.replace(/^medications?\s*:/i, '').split(/,\s*/).map((x) => (x.toLowerCase().match(/[a-z]+/) || [''])[0].slice(0, 6)).filter(Boolean); check('P2', new Set(names).size === names.length, 'a drug is repeated in the Medications line'); }
    const addr = pmh.find((b) => ADDRESS.test(b.text)); check('P3', !addr, addr ? `"${addr.text.slice(0, 70)}"` : '');
    const nm = pmh.find((b) => NOT_MENTIONED.test(b.text)); check('P4', !nm, nm ? `"${nm.text.slice(0, 70)}"` : '');
  }
  const obj = P.Objective.filter((x) => x.type === 'bullet');
  if (obj.length) {
    const pat = obj.find((b) => /^(patient\s+)?(reports?|denies|complains?|states?)\b/i.test(b.text)); check('O3', !pat, pat ? `"${pat.text.slice(0, 70)}"` : '');
    let dup = null; for (let i = 0; i < obj.length && !dup; i++) for (let j = i + 1; j < obj.length; j++) if (overlap(obj[i].text, obj[j].text) >= 0.6) { dup = obj[j].text; break; }
    check('O2', !dup, dup ? `repeats: "${dup.slice(0, 70)}"` : '');
  }
  const vit = P.Objective.findIndex((x) => x.type === 'head' && /vital/i.test(x.text));
  if (vit >= 0) { const after = []; for (let i = vit + 1; i < P.Objective.length && P.Objective[i].type === 'bullet'; i++) after.push(P.Objective[i]); const nn = after.find((b) => !/\d/.test(b.text)); check('O1', !nn, nn ? `"${nn.text.slice(0, 70)}"` : ''); }

  const plan = P.plan;
  if (plan.length || subj.length) {
    check('A1', plan.length >= 1 && plan.every((p, i) => p.n === i + 1), `${plan.length} problems`);
    const bad = plan.find((p) => /rule out|suspected|\bvs\b|\?|possible|probable/i.test(p.title)); check('A2', !bad, bad ? `"${bad.title}"` : '');
    const items = plan.flatMap((p, pi) => p.items.filter((i) => /^(investigations planned|treatment planned|referrals)$/i.test(i.label)).map((i) => ({ pi, t: i.text })));
    let dup = null; for (let i = 0; i < items.length && !dup; i++) for (let j = i + 1; j < items.length; j++) if (overlap(items[i].t, items[j].t) >= 0.75) { dup = items[j].t; break; }
    check('A3', !dup, dup ? `repeated: "${dup.slice(0, 70)}"` : '');
    const rest = plan.flatMap((p) => p.items.filter((i) => !i.label && RESTATES.test(i.text)).map((i) => i.text)); check('A4', rest.length === 0, rest[0] ? `"${rest[0].slice(0, 70)}"` : '');
    const ref = plan.find((p) => /^(medication\s+)?(refills?|renewals?)\b/i.test(p.title)); check('A5', !ref, ref ? `problem "${ref.title}"` : '');
    const fu = plan.find((p) => /^follow[\s-]?up\b/i.test(p.title)); check('A6', !fu, fu ? `problem "${fu.title}"` : '');
    const sym = plan.find((p) => { const d = p.items.find((i) => /^diagnosis$/i.test(i.label)); return d && SYMPTOM.test(d.text) && d.text.toLowerCase().includes(p.title.toLowerCase().slice(0, 12)); }); check('A7', !sym, sym ? `"${sym.title}"` : '');
  }
  const all = String(rendered || ''); check('G1', !NOT_MENTIONED.test(all), (all.match(NOT_MENTIONED) || [''])[0]);

  const w = { major: 1, minor: 0.5 }; const lost = failed.reduce((s, f) => s + (w[f.severity] || 1), 0);
  return { score: checks ? Math.max(0, 1 - lost / checks) : 1, checks, passed: checks - failed.length, failed };
}
