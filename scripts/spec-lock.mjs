#!/usr/bin/env node
// Style Spec v1 fingerprint.
//   node scripts/spec-lock.mjs            -> check: exits 1 and lists every difference if the approved spec has drifted
//   node scripts/spec-lock.mjs write      -> record the CURRENT code as the approved spec. ONLY when the owner has approved a new spec.
import fs from 'node:fs';
import { LOCK_FILE, computeFingerprint, diffLock, readLock } from '../packages/backend/spec/computeLock.mjs';

const now = await computeFingerprint();
if (process.argv[2] === 'write') {
  const prev = fs.existsSync(LOCK_FILE) ? readLock() : {};
  const lock = { specVersion: process.argv[3] || prev.specVersion || '1.0.0', lockedAt: new Date().toISOString(), note: 'Doctor-approved note format. Do not change without the owner. See docs/STYLE_SPEC_V1_LOCKED.md', ...now };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
  console.log(`Style Spec ${lock.specVersion} fingerprint written (${Object.keys(now.files).length} files, ${Object.keys(now.prompts).length} prompts).`);
} else {
  const diff = diffLock(readLock(), now);
  if (diff.length) { console.error('STYLE SPEC DRIFT — the doctor-approved spec has changed:\n  ' + diff.join('\n  ')); process.exit(1); }
  console.log('Style Spec v1: unchanged.');
}
