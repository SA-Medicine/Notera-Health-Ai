// End-to-end proof that what an admin changes in the console is what the pipeline reads (in-memory Postgres).
//   PGMEM=<path to node_modules/pg-mem> DATABASE_URL=postgres://x node packages/backend/test/adminControl.pgmem.mjs
// Covers: prompt promote → active → rollback → reset (and the pipeline-side cache), runtime-config override → effective
// value → reset, validation (range/type/unknown key), change history.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { newDb } = require(process.env.PGMEM || 'pg-mem');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pgmem';
const { _setPool } = await import('../src/db/pool.js');
const db = newDb(); const { Pool } = db.adapters.createPg(); _setPool(new Pool());

const ps = await import('../src/orchestrator/promptStore.js');
const rc = await import('../src/orchestrator/runtimeConfig.js');
const { PROMPT_REGISTRY } = await import('../src/orchestrator/generateNoteV2.js');

// ── STYLE SPEC v1 HARD LOCK: locked by default; nothing that shapes a note can be changed until the owner unlocks it ──
const sl = await import('../src/orchestrator/specLock.js');
assert.equal((await sl.specLockState()).locked, true, 'the doctor-approved Style Spec is locked by default');
await assert.rejects(() => ps.promote('v2-writer', 'A'.repeat(900) + ' STRICT JSON'), /LOCKED/, 'a prompt cannot be promoted while locked');
await assert.rejects(() => ps.resetToDefault('v2-story'), /LOCKED/, 'a prompt cannot be reset while locked');
await assert.rejects(() => rc.setConfig('writer.model', 'gemini-2.5-flash'), /LOCKED/, 'a spec-shaping setting cannot be changed while locked');
await assert.rejects(() => rc.setConfig('story.enabled', false), /LOCKED/);
await rc.setConfig('writer.timeoutMs', 45000, { by: 'ops' });                       // operational limits stay tunable
assert.equal((await rc.effectiveConfig())['writer.timeoutMs'], 45000); await rc.resetConfig('writer.timeoutMs', { by: 'ops' });
await assert.rejects(() => sl.unlockSpec('owner', 'please'), /exact phrase/, 'unlocking needs the exact confirmation phrase');
assert.equal((await sl.specLockState()).locked, true);
await sl.unlockSpec('owner', sl.UNLOCK_PHRASE, 'test');                             // the remaining checks exercise the console machinery
assert.equal((await sl.specLockState()).locked, false);

// ── prompts ──
const W = 'v2-writer';
assert.equal(await ps.getActivePrompt(W), null, 'no override → code default applies');
const v1 = await ps.promote(W, 'A'.repeat(900) + ' STRICT JSON', { note: 'first', by: 'admin@x' });
assert.equal(v1.version, 1);
assert.match((await ps.getActivePromptMeta(W)).text, /STRICT JSON/, 'pipeline sees the promoted text immediately (cache cleared by promote)');
assert.equal((await ps.getActivePromptMeta(W)).version, 1);
const v2 = await ps.promote(W, 'B'.repeat(900) + ' STRICT JSON', { by: 'admin@x' });
assert.equal((await ps.getActivePromptMeta(W)).version, 2);
await ps.activate(v1.id);                                   // rollback
assert.equal((await ps.getActivePromptMeta(W)).version, 1, 'rollback is live on the very next note');
await ps.resetToDefault(W);
assert.equal(await ps.getActivePrompt(W), null, 'reset → code default');
// prompts are independent per stage
await ps.promote('v2-verifier', 'x'.repeat(300) + ' unsupported duplicates JSON', { by: 'a' });
assert.equal(await ps.getActivePrompt(W), null); assert.ok(await ps.getActivePrompt('v2-verifier'));
// registry: every prompt has a default the pipeline can fall back to, and the required markers are in the DEFAULT
for (const [name, reg] of Object.entries(PROMPT_REGISTRY)) {
  const d = reg.default(); assert.ok(d.length >= reg.min, `${name} default meets its own minimum`);
  for (const m of reg.must) assert.match(d, new RegExp(m, 'i'), `${name} default contains "${m}"`);
}

// ── runtime config ──
const base = await rc.effectiveConfig();
assert.equal(base['writer.model'], 'gemini-3.7-flash'); assert.equal(base['writer.temperature'], 0.3); assert.equal(base['verifier.enabled'], true);
await rc.setConfig('writer.model', 'gemini-3.5-flash-lite', { by: 'admin@x', reason: 'speed test' });
await rc.setConfig('writer.temperature', 0.15, { by: 'admin@x' });
await rc.setConfig('verifier.enabled', false, { by: 'admin@x' });
const eff = await rc.effectiveConfig();
assert.equal(eff['writer.model'], 'gemini-3.5-flash-lite'); assert.equal(eff['writer.temperature'], 0.15); assert.equal(eff['verifier.enabled'], false);
const desc = (await rc.describeConfig()).find((s) => s.key === 'writer.model');
assert.equal(desc.source, 'override'); assert.equal(desc.default, 'gemini-3.7-flash'); assert.equal(desc.updated_by, 'admin@x');
await assert.rejects(() => rc.setConfig('writer.temperature', 5), /between/);
await assert.rejects(() => rc.setConfig('writer.temperature', 'hot'), /number/);
await assert.rejects(() => rc.setConfig('verifier.enabled', 'yes'), /true or false/);
await assert.rejects(() => rc.setConfig('writer.model', 'bad model; drop table'), /model id/);
await assert.rejects(() => rc.setConfig('db.password', 'x'), /unknown setting/);
assert.equal(await rc.resetConfig('writer.model', { by: 'admin@x' }), true);
assert.equal((await rc.effectiveConfig())['writer.model'], 'gemini-3.7-flash', 'reset → default');
assert.equal(await rc.resetConfig('writer.model'), false, 'resetting an unchanged setting is a no-op');
const hist = await rc.configHistory(20);
assert.ok(hist.length >= 4 && hist.some((h) => h.key === 'writer.model' && h.new_value === null), 'every change, including resets, is in the history');
// ── locking again: overrides that were set while unlocked stop applying, the shipped spec applies ──
await rc.setConfig('writer.model', 'gemini-2.5-flash', { by: 'owner' }); await ps.promote(W, 'C'.repeat(900) + ' STRICT JSON', { by: 'owner' });
assert.equal((await rc.effectiveConfig())['writer.model'], 'gemini-2.5-flash');
await sl.relockSpec('owner'); sl.clearSpecLockCache();
assert.equal((await rc.effectiveConfig())['writer.model'], 'gemini-3.7-flash', 'locked: a stored override of a spec setting is ignored');
assert.equal(await ps.getActivePrompt(W), null, 'locked: a stored prompt override is ignored, the shipped prompt applies');
assert.equal((await rc.describeConfig()).find((s) => s.key === 'writer.model').locked, true);
console.log('admin control: all assertions passed');
process.exit(0);
