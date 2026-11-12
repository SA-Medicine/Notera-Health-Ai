// Clean-note accounts (owner, 2026-11-12, Dr Seema Aggarwal's request). For the accounts listed in CLEAN_NOTE_EMAILS the note is only the note: no "Before you sign" flags are stored or returned,
// no Medicines box checks run, and no marker is written into the text ("medication (name unclear)"). She reads and corrects every note herself and pastes it into her EHR.
// Two flags still pass because they say the whole note is not usable: an empty encounter and a recording that is not a consultation.
// Nothing else about the note changes. Other accounts are not affected. Env: CLEAN_NOTE_EMAILS="a@x.com,b@y.com" (empty or unset = nobody).
'use strict';

import { one } from '../db/pool.js';

const KEEP_TYPES = new Set(['empty_encounter', 'input_not_consultation']);
const cache = new Map();   // clinicianId -> { v, t }
const TTL = 5 * 60_000;

export const cleanEmails = () => String(process.env.CLEAN_NOTE_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** True when this clinician's account is on the clean-note list. A failed lookup means "not clean": the normal checks stay on. */
export async function isCleanNoteClinician(clinicianId, { lookup } = {}) {
  const list = cleanEmails(); if (!list.length || !clinicianId || clinicianId === 'unknown') return false;
  const hit = cache.get(clinicianId); if (hit && Date.now() - hit.t < TTL) return hit.v;
  try {
    const row = await (lookup ? lookup(clinicianId) : one('SELECT lower(email) AS email FROM auth.users WHERE id::text = $1', [String(clinicianId)]));
    const v = !!row?.email && list.includes(String(row.email).toLowerCase()); cache.set(clinicianId, { v, t: Date.now() }); return v;
  } catch { return false; }
}

/** The flags a clean-note account still gets. */
export const keepCriticalFlags = (flags) => (Array.isArray(flags) ? flags.filter((f) => f && KEEP_TYPES.has(f.type)) : []);
export const _resetCleanCache = () => cache.clear();
