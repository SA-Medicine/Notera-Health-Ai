// Drug suggestions (RxNorm name and dose checks): the flags at the top of the note and the Medicines box. A clinician can switch them off and on; the choice is remembered in this browser, per account.
// Accounts listed in NO_SUGGESTIONS_FOR have no suggestions at all: no flags at the top of the note, no Medicines box and no switch. A saved choice in the browser cannot turn them back on.
export const NO_SUGGESTIONS_FOR = ['seema.aggarwal@agilepartners-ai.com']
export const DRUG_FLAG_TYPES = ['medication_unverified', 'drug_review', 'suspicious_medication_value', 'dose_check']
const KEY = 'notera.drugSuggest'

export function suggestionsLocked(email: string | undefined | null): boolean {
  return NO_SUGGESTIONS_FOR.includes((email || '').trim().toLowerCase())
}
export function readDrugSuggest(email: string): boolean {
  if (suggestionsLocked(email)) return false
  try { const v = localStorage.getItem(KEY + ':' + (email || '').toLowerCase()); if (v === 'on') return true; if (v === 'off') return false } catch { /* private window */ }
  return true
}
export function writeDrugSuggest(on: boolean, email = '') { try { localStorage.setItem(KEY + ':' + (email || '').toLowerCase(), on ? 'on' : 'off') } catch { /* */ } }
