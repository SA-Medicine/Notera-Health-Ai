// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL connection pool + helpers (node-postgres).
//   • one shared pool from DATABASE_URL
//   • query(text, params) → rows
//   • tx(fn) → run fn(client) in a transaction
//   • withSession({ clinicianId, role }, fn) → sets RLS session GUCs then runs fn
// Requires:  npm i pg     (in the @notera/backend workspace)
// ─────────────────────────────────────────────────────────────────────────────
import pg from 'pg';

const { Pool } = pg;

let _pool = null;

export function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set (Postgres backend requested).');
  _pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });
  _pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  return _pool;
}

export async function query(text, params) {
  const res = await getPool().query(text, params);
  return res.rows;
}

export async function one(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/** Run fn(client) inside a single transaction (BEGIN/COMMIT/ROLLBACK). */
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Run fn(client) with the RLS session variables set for this request.
 * Uses SET LOCAL so they reset at transaction end.
 */
export async function withSession({ clinicianId = '', role = 'service' } = {}, fn) {
  return tx(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.clinician_id', String(clinicianId || '')]);
    await client.query('SELECT set_config($1, $2, true)', ['app.role', String(role || 'service')]);
    return fn(client);
  });
}

export async function closePool() { if (_pool) { await _pool.end(); _pool = null; } }
