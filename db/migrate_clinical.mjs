// Apply the clinical persistence schema (db/schema.clinical.sql) to DATABASE_URL.
//   node db/migrate_clinical.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, 'schema.clinical.sql'), 'utf8');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined });
await client.connect();
await client.query(sql);
await client.end();
console.log('✅ clinical schema applied (consults, drafts, finals, feedback, deid_maps, models, audit)');
