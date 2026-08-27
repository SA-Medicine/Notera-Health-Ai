// Apply the auth schema (db/schema.auth.sql) to DATABASE_URL.
//   node db/migrate_auth.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, 'schema.auth.sql'), 'utf8');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined });
await client.connect();
await client.query(sql);
await client.end();
console.log('✅ auth schema applied');
