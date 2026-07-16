// Apply db/schema.sql to the database in DATABASE_URL. Idempotent (safe to re-run).
//   DATABASE_URL=postgres://user:pass@localhost:5432/notera node db/migrate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) { console.error('✗ DATABASE_URL is not set'); process.exit(1); }

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  await client.query(sql);
  console.log('✅ schema applied to', url.replace(/:[^:@/]+@/, ':***@'));
} catch (e) {
  console.error('✗ migrate failed:', e.message || e.code || String(e));
  if (e.code) console.error('   code:', e.code);
  if (e.errors) for (const sub of e.errors) console.error('   -', sub.code || sub.message);
  if ((e.code === 'ECONNREFUSED') || (e.errors && e.errors.some((x) => x.code === 'ECONNREFUSED')))
    console.error('   → is Postgres reachable on', process.env.DATABASE_URL?.replace(/:[^:@/]+@/, ':***@'), '? Make sure the container publishes 5432 and is healthy.');
  process.exitCode = 1;
} finally {
  await client.end();
}
