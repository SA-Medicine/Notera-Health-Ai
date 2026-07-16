// ─────────────────────────────────────────────────────────────────────────────
// Backfill Firestore (live clinical data) → Postgres.
// Copies consults + drafts/finals/feedback, de-id maps (re-encrypted with
// DEID_ENC_KEY), the append-only audit log, and the models registry.
// Idempotent (upsert / ON CONFLICT DO NOTHING). Per-item try/catch so one bad
// row never aborts the run.
//
// Requires (in your environment):
//   DATABASE_URL=postgres://...            (target Postgres)
//   DEID_ENC_KEY=...                       (same key the app will use)
//   GOOGLE_APPLICATION_CREDENTIALS=...     (Firestore service account)
//   FIRESTORE project via GCP_PROJECT / GOOGLE_CLOUD_PROJECT
//
//   DATABASE_URL=... DEID_ENC_KEY=... node db/backfill_firestore.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { pgStoreDriver } from '../backend/src/db/pgStore.js';

if (!process.env.DATABASE_URL) { console.error('✗ DATABASE_URL not set'); process.exit(1); }

let Firestore;
try { ({ Firestore } = await import('@google-cloud/firestore')); }
catch { console.error('✗ @google-cloud/firestore not installed — run inside the backend workspace'); process.exit(1); }

const db = new Firestore();
const store = pgStoreDriver();
const count = { consults: 0, drafts: 0, finals: 0, feedback: 0, deid: 0, audit: 0, models: 0, errors: 0 };

async function run() {
  // ── consults + subcollections ────────────────────────────────────────────
  const consults = await db.collection('consults').get();
  for (const doc of consults.docs) {
    try {
      const c = doc.data();
      await store.createConsult({ consultId: doc.id, ...c });
      if (c.transcript || c.entities || c.status) await store.updateConsult(doc.id, { transcript: c.transcript, entities: c.entities, status: c.status });
      count.consults++;
      for (const d of (await doc.ref.collection('drafts').get()).docs) { try { await store.addDraft(doc.id, { draftId: d.id, ...d.data() }); count.drafts++; } catch (e) { count.errors++; } }
      for (const f of (await doc.ref.collection('finals').get()).docs) { try { await store.addFinal(doc.id, { finalId: f.id, ...f.data() }); count.finals++; } catch (e) { count.errors++; } }
      for (const fb of (await doc.ref.collection('feedback').get()).docs) { try { await store.addFeedback(doc.id, { feedbackId: fb.id, ...fb.data() }); count.feedback++; } catch (e) { count.errors++; } }
    } catch (e) { count.errors++; console.error('  consult', doc.id, '→', e.message); }
  }

  // ── de-id maps (PHI) — re-encrypted on write by pgStore ───────────────────
  for (const d of (await db.collection('deidMaps').get()).docs) {
    try { const v = d.data(); await store.putDeidMap(d.id, v.map || {}, v.fingerprint || ''); count.deid++; }
    catch (e) { count.errors++; console.error('  deid', d.id, '→', e.message); }
  }

  // ── append-only audit log ─────────────────────────────────────────────────
  for (const a of (await db.collection('auditLog').get()).docs) {
    try { await store.appendAudit({ eventId: a.id, ...a.data() }); count.audit++; }
    catch (e) { count.errors++; }
  }

  // ── models registry ───────────────────────────────────────────────────────
  for (const m of (await db.collection('models').get()).docs) {
    try { await store.registerModel({ modelVersion: m.id, ...m.data() }); count.models++; }
    catch (e) { count.errors++; }
  }
}

try {
  console.log('Backfilling Firestore → Postgres…');
  await run();
  console.log('✅ done:', JSON.stringify(count));
} catch (e) {
  console.error('✗ firestore backfill failed:', e.message);
  process.exitCode = 1;
}
