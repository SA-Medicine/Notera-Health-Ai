// Create (or update) the first admin user.
//   ADMIN_EMAIL=you@clinic.com ADMIN_PASSWORD='min-12-chars' node db/create_admin.mjs
import bcrypt from 'bcryptjs';
import pg from 'pg';

const email = (process.env.ADMIN_EMAIL || '').toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
if (!email || password.length < 12) { console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (≥12 chars)'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined });
await client.connect();
const hash = await bcrypt.hash(password, 12);
await client.query(
  `INSERT INTO auth.users (email, password_hash, role, full_name)
   VALUES ($1,$2,'admin','Administrator')
   ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='admin', is_active=true`,
  [email, hash]);
await client.end();
console.log(`✅ admin user ready: ${email}`);
