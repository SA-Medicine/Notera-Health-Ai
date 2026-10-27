// Dose repair from the recording (audit 2026-10-27, experiment DOSE_REPAIR=1; off by default).
//
// A model sometimes writes the usual dose of a drug instead of the one that was said: on the gold set, "Cymbalta sixteen milligrams once a day" (as heard) came out as
// "Continue Cymbalta (duloxetine) 60 mg once daily", which the judge scored as a critical wrong claim and which the late grounding check could only delete (losing the
// medicine altogether). The fact graph holds the dose that was said, with its exact quote. When
//   - a note line names a drug and gives an amount that the recording never says (missingNumbers), and
//   - the graph has exactly one fact for that drug with a dose, whose amount IS said in the recording, and the units agree,
// the amount in the line is replaced by the said one and an info flag tells the clinician. Anything less certain is left alone (the fidelity guards already flag
// a number that is not in the recording).
'use strict';

import { missingNumbers, collectParts } from './groundingAgent.js';

const AMOUNT = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|ml|units?|iu)\b/i;
const unitOf = (u) => String(u || '').toLowerCase().replace(/^units?$/, 'unit').replace('µg', 'mcg');

export function doseRepair(note, transcript, facts, log = () => {}) {
  const drugs = new Map();   // first word of the drug -> facts with a dose
  for (const f of facts || []) {
    if (!['medication', 'medication_order'].includes(f.type) || !f.medication || !f.dose) continue;
    const m = String(f.dose).match(AMOUNT); if (!m) continue;
    const key = String(f.medication).toLowerCase().split(/[\s(/,-]+/)[0]; if (key.length < 4) continue;
    (drugs.get(key) || drugs.set(key, []).get(key)).push({ amount: m[1], unit: unitOf(m[2]), text: m[0] });
  }
  const fixed = [];
  for (const p of collectParts(note)) {
    if (!(p.where.startsWith('plan') || p.where === 'past_medical_history')) continue;
    const low = p.text.toLowerCase();
    for (const [key, list] of drugs) {
      if (!new RegExp(`\\b${key.replace(/[^a-z0-9]/g, '')}`).test(low)) continue;
      const doses = [...new Map(list.map((d) => [d.amount + d.unit, d])).values()]; if (doses.length !== 1) continue;   // two different doses were said: not certain
      const said = doses[0]; if (missingNumbers(`x ${said.text}`, transcript).length) continue;           // the fact's own amount must be in the recording
      const m = p.text.match(AMOUNT); if (!m || unitOf(m[2]) !== said.unit || m[1] === said.amount) continue;
      if (!missingNumbers(m[0], transcript).includes(m[1])) continue;                                    // the line's amount is not said: that is the error
      const to = `${said.amount} ${m[2]}`; const lines = String(p.obj[p.key]); const next = lines.replace(m[0], to);
      if (next !== lines) { p.obj[p.key] = next; fixed.push({ drug: key, from: m[0], to }); log(`[v2:dose] ${key}: ${m[0]} -> ${to} (the recording says ${said.text})`); }
      break;
    }
  }
  if (fixed.length) { note.metadata = note.metadata || {}; note.metadata.flags = [...(note.metadata.flags || []), ...fixed.map((x) => ({ type: 'dose_corrected', field: 'medications', severity: 'info', message: `${x.drug}: ${x.from} changed to ${x.to} - the recording says ${x.to}` }))]; }
  return { fixed };
}
