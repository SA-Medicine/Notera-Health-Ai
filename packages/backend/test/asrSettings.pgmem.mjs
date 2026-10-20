// Speech-to-text settings stored in the database (in-memory Postgres):  PGMEM=<path to pg-mem> node packages/backend/test/asrSettings.pgmem.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { newDb } = require(process.env.PGMEM || 'pg-mem');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pgmem'; process.env.ASR_MODEL = 'chirp_2';
const { _setPool } = await import('../src/db/pool.js'); const db = newDb(); const { Pool } = db.adapters.createPg(); _setPool(new Pool());
const E = await import('../src/asr/engines.js'); const { query } = await import('../src/db/pool.js');

let s = await E.getSettings(); assert.equal(s.primary, 'chirp_2'); assert.deepEqual(s.fallbacks, ['gemini-2.5-flash', 'latest_long'], 'nothing stored: the built-in default chain');
const saved = await E.saveSettings({ primary: 'chirp_3', fallbacks: ['chirp_2', 'latest_long'], timeoutMs: 45000 }, 'owner@x');
assert.equal(saved.primary, 'chirp_3'); s = await E.getSettings(); assert.deepEqual(s.fallbacks, ['chirp_2', 'latest_long']); assert.equal(s.timeoutMs, 45000);
assert.equal((await E.settingsMeta()).updated_by, 'owner@x');
await assert.rejects(() => E.saveSettings({ primary: 'nope' }), /unknown engine/); assert.equal((await E.getSettings()).primary, 'chirp_3', 'a rejected change leaves the stored value alone');
await query(`UPDATE ops.asr_settings SET value = '{"primary":"garbage"}'::jsonb WHERE id = 1`); E.clearAsrSettingsCache();
assert.equal((await E.getSettings()).primary, 'chirp_2', 'a corrupt stored value never breaks transcription: defaults apply');
const d = await E.resetSettings(); E.clearAsrSettingsCache(); assert.equal(d.primary, 'chirp_2'); assert.equal((await E.settingsMeta()), null);
console.log('asr settings: all assertions passed'); setTimeout(() => process.exit(0), 100);
