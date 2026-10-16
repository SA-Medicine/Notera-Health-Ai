// Quota SQL + middleware test against an in-memory Postgres (pg-mem).
//   PGMEM=<path to node_modules/pg-mem> node packages/backend/test/quota.pgmem.mjs
// Not part of `node --test test/` (needs the optional pg-mem dev dependency).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { newDb } = require(process.env.PGMEM || 'pg-mem');
const { _setPool, query } = await import('../src/db/pool.js');

const db = newDb();
import crypto from 'node:crypto';
db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: () => crypto.randomUUID(), impure: true });
db.public.none(`CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password_hash text NOT NULL, full_name text, role text NOT NULL DEFAULT 'clinician', is_active boolean NOT NULL DEFAULT true);
  INSERT INTO auth.users (email, password_hash) VALUES ('legacy@clinic.org', 'x');`);
const { Pool } = db.adapters.createPg();
_setPool(new Pool());

const q = await import('../src/auth/quota.js');
await q.ensureAccountSchema();
// pg-mem doesn't backfill ADD COLUMN ... DEFAULT for existing rows (real Postgres does, atomically); emulate it.
db.public.none(`UPDATE auth.users SET plan='full', free_notes_used=0`);

// 1) A pre-existing account is migrated to the FULL plan (no limits) — the grandfather guarantee.
const legacy = (await query(`SELECT id, plan, free_notes_used FROM auth.users WHERE email='legacy@clinic.org'`))[0];
assert.equal(legacy.plan, 'full'); assert.equal(legacy.free_notes_used, 0);
for (let i = 0; i < 12; i++) assert.ok(await q.reserveNote(legacy.id), 'full plan is never blocked');
assert.equal((await q.getAccount(legacy.id)).used, 0, 'full plan usage is not counted');

// 2) A new self-service account is FREE with exactly FREE_NOTE_LIMIT (5) notes.
const { createUser } = await import('../src/auth/users.js');
const u = await createUser({ email: 'new@clinic.org', password: 'a-long-password-123', fullName: 'New User', plan: 'free' });
assert.equal(u.plan, 'free');
let acc = await q.getAccount(u.id);
assert.deepEqual([acc.plan, acc.used, acc.limit, acc.remaining], ['free', 0, 5, 5]);
for (let i = 1; i <= 5; i++) { const r = await q.reserveNote(u.id); assert.ok(r, `note ${i} allowed`); assert.equal(r.used, i); }
assert.equal(await q.reserveNote(u.id), null, '6th note is refused');
acc = await q.getAccount(u.id); assert.equal(acc.remaining, 0);

// 3) A failed note is refunded, then the freed slot can be used again.
await q.refundNote(u.id);
assert.equal((await q.getAccount(u.id)).remaining, 1);
assert.ok(await q.reserveNote(u.id)); assert.equal(await q.reserveNote(u.id), null);

// 4) Express middleware: 402 with the pricing hint; legacy + service callers pass; ASR gate blocks exhausted free users.
const run = async (mw, user) => {
  const out = { status: 200, body: null, nexted: false };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  await mw({ user }, res, () => { out.nexted = true; });
  return out;
};
let r = await run(q.noteQuotaGate, { id: u.id });
assert.equal(r.status, 402); assert.equal(r.body.error, 'free_limit_reached'); assert.equal(r.body.upgradeUrl, '/pricing'); assert.equal(r.nexted, false);
r = await run(q.noteQuotaGate, { id: legacy.id }); assert.ok(r.nexted);
r = await run(q.noteQuotaGate, undefined); assert.ok(r.nexted, 'service token / no user is not metered');
r = await run(q.asrQuotaGate, { id: u.id }); assert.equal(r.status, 402);
r = await run(q.asrQuotaGate, { id: legacy.id }); assert.ok(r.nexted);

// 5) Concurrency: 8 parallel reservations for a fresh free user with 5 notes → exactly 5 succeed.
const c = await createUser({ email: 'race@clinic.org', password: 'a-long-password-123', plan: 'free' });
const results = await Promise.all(Array.from({ length: 8 }, () => q.reserveNote(c.id)));
assert.equal(results.filter(Boolean).length, 5, 'atomic: never more than the limit');

// 6) Daily ASR allowance for free accounts (in-memory counter).
const f = await createUser({ email: 'asr@clinic.org', password: 'a-long-password-123', plan: 'free' });
let blocked = 0; for (let i = 0; i < q.FREE_ASR_CHUNKS_PER_DAY + 3; i++) { const o = await run(q.asrQuotaGate, { id: f.id }); if (o.status === 429) blocked++; }
assert.equal(blocked, 3, 'free ASR is capped per day');

console.log('quota: all checks passed');
