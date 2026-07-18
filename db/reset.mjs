// ─────────────────────────────────────────────────────────────────────────────
// db/reset.mjs — FULL REPLACEMENT to the Testing Lab schema.
//
//   1. pg_dump the current DB to db/backups/  (best-effort, via docker exec)
//   2. DROP SCHEMA clinical, phi, ops, lab CASCADE   (destructive!)
//   3. Apply db/schema.lab.sql
//   4. Backfill data/gold + eval/results  (node db/backfill_lab.mjs)
//
// Usage:  npm run db:reset          (add --no-backfill to skip step 4)
//         DATABASE_URL=... node db/reset.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// load .env (strip CR, override empty) so DATABASE_URL is available
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
const noBackfill = process.argv.includes('--no-backfill');
const container = process.env.PG_CONTAINER || 'notera-postgres';

// 1. backup (best-effort) ------------------------------------------------------
try {
  const backups = path.join(__dirname, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const inContainer = `/tmp/pre-lab-${ts}.dump`;
  console.log('• backing up current DB (docker exec pg_dump) …');
  execSync(
    `docker exec ${container} sh -lc "PGPASSWORD=$(cat /run/secrets/pg_password) pg_dump -U notera_admin -d notera -Fc -f ${inContainer}"`,
    { stdio: 'ignore' }
  );
  execSync(`docker cp ${container}:${inContainer} "${path.join(backups, `pre-lab-${ts}.dump`)}"`, { stdio: 'ignore' });
  console.log(`  ✓ backup → db/backups/pre-lab-${ts}.dump`);
} catch (e) {
  console.warn('  ⚠ backup skipped (docker/pg_dump unavailable):', e.message.split('\n')[0]);
}

// 2 + 3. drop + apply ----------------------------------------------------------
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  console.log('• dropping clinical / phi / ops / lab …');
  await client.query('DROP SCHEMA IF EXISTS clinical CASCADE; DROP SCHEMA IF EXISTS phi CASCADE; DROP SCHEMA IF EXISTS ops CASCADE; DROP SCHEMA IF EXISTS lab CASCADE;');
  console.log('• applying db/schema.lab.sql …');
  await client.query(fs.readFileSync(path.join(__dirname, 'schema.lab.sql'), 'utf8'));
  console.log('  ✓ lab schema created');
} catch (e) {
  console.error('✗ reset failed:', e.message || e.code || String(e));
  process.exitCode = 1;
} finally {
  await client.end();
}

// 4. backfill ------------------------------------------------------------------
if (!noBackfill && process.exitCode !== 1) {
  console.log('• backfilling data/gold + eval/results …');
  try {
    execSync(`node "${path.join(__dirname, 'backfill_lab.mjs')}"`, { stdio: 'inherit', cwd: ROOT });
  } catch (e) {
    console.warn('  ⚠ backfill reported an error:', e.message.split('\n')[0]);
  }
}
console.log(process.exitCode === 1 ? 'Done with errors.' : '✅ Testing Lab is ready.');
