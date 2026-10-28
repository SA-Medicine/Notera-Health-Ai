// Drug suggestions (RxNorm name and dose checks): the flags at the top of the note and the Medicines box. A clinician can switch them off and on; the choice is remembered in this browser.
// Accounts listed here start with the suggestions OFF (they can still switch them on).
export const DRUG_SUGGEST_OFF_FOR = ['seema.aggarwal@agilepartners-ai.com']
export const DRUG_FLAG_TYPES = ['medication_unverified', 'drug_review', 'suspicious_medication_value', 'dose_check']
const KEY = 'notera.drugSuggest'

export function readDrugSuggest(email: string): boolean {
  try { const v = localStorage.getItem(KEY); if (v === 'on') return true; if (v === 'off') return false } catch { /* private window */ }
  return !DRUG_SUGGEST_OFF_FOR.includes((email || '').toLowerCase())
}
export function writeDrugSuggest(on: boolean) { try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* */ } }
