// Validates every admin-console SQL statement against the REAL schema with EXPLAIN (plans only — no rows are read).
//   docker exec notera-backend node test/panelSql.explain.mjs        (needs DATABASE_URL)
import { SQL } from '../src/admin/panelRoutes.js';
import { query } from '../src/db/pool.js';
import { ensureAccountSchema } from '../src/auth/quota.js';
await ensureAccountSchema();
const P = {
  users: ['', '', 10], user: ['00000000-0000-0000-0000-000000000000'], consults: ['', false, '', 10], consult: ['x'],
  drafts: ['x'], finals: ['x'], runs: ['x'], audit: ['', 10], audioRow: ['x'], usersByDay: [], consultsByDay: [], liveDaily: [14], liveByModel: [14], liveErrors: [14], liveSignups: [14], liveNotes: [14],
};
let bad = 0;
for (const [k, sql] of Object.entries(SQL)) {
  try { await query(`EXPLAIN ${sql}`, P[k]); console.log('ok  ', k); } catch (e) { bad++; console.log('FAIL', k, '-', e.message); }
}
process.exit(bad ? 1 : 0);
