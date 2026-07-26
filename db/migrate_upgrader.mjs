// db/migrate_upgrader.mjs — apply the ADDITIVE System Upgrader tables.
// Safe on a live DB (CREATE ... IF NOT EXISTS only; nothing is dropped).
//   node db/migrate_upgrader.mjs      (or npm run db:upgrader)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) { const v = m[2].replace(/^["']|["']$/g, '').replace(/[\r\n]+$/, '').trim();
        if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v; }
    }
  } catch {}
})();

const url = process.env.DATABASE_URL;
if (!url) { console.error('✗ DATABASE_URL is not set'); process.exit(1); }

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query(fs.readFileSync(path.join(__dirname, 'schema.upgrader.sql'), 'utf8'));
  console.log('✅ System Upgrader tables ready (upgrade_runs, prompt_suggestions, system_suggestions)');
} catch (e) {
  console.error('✗ migrate_upgrader failed:', e.message || e.code || String(e));
  process.exitCode = 1;
} finally {
  await client.end();
}
