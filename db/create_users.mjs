// ─────────────────────────────────────────────────────────────────────────────
// Bulk create/update clinician users in PostgreSQL auth.users
// Usage: node /app/db/create_users.mjs
// ─────────────────────────────────────────────────────────────────────────────
import bcrypt from 'bcrypt';
import pg from 'pg';

const DOMAIN = process.env.USER_DOMAIN || 'agilepartners-ai.com';

const USERS = [
  {
    fullName: 'Seema Aggarwal',
    email: process.env.SEEMA_EMAIL || `seema.aggarwal@${DOMAIN}`,
    password: process.env.SEEMA_PASSWORD || 'Seema#Aggr!9842',
    role: 'clinician',
  },
  {
    fullName: 'Fatima Afzal',
    email: process.env.FATIMA_EMAIL || `fatima.afzal@${DOMAIN}`,
    password: process.env.FATIMA_PASSWORD || 'Fatima#Afzl!7319',
    role: 'clinician',
  },
  {
    fullName: 'Mark Rodrigues',
    email: process.env.MARK_EMAIL || `mark.rodrigues@${DOMAIN}`,
    password: process.env.MARK_PASSWORD || 'Mark#Rodrg!6541',
    role: 'clinician',
  },
  {
    fullName: 'Ben Arsic',
    email: process.env.BEN_EMAIL || `ben.arsic@${DOMAIN}`,
    password: process.env.BEN_PASSWORD || 'Ben#Arsic!8293',
    role: 'clinician',
  },
];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

await client.connect();

for (const u of USERS) {
  const email = u.email.toLowerCase().trim();
  const hash = await bcrypt.hash(u.password, 12);
  await client.query(
    `INSERT INTO auth.users (email, password_hash, role, full_name, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (email) DO UPDATE 
     SET password_hash = EXCLUDED.password_hash,
         full_name = EXCLUDED.full_name,
         role = EXCLUDED.role,
         is_active = true`,
    [email, hash, u.role, u.fullName]
  );
  console.log(`✅ Clinician ready: ${u.fullName} <${email}>`);
}

await client.end();
console.log('🎉 All users created/updated successfully.');
