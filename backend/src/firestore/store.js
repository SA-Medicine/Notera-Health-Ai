// ─────────────────────────────────────────────────────────────────────────────
// Notera-Health-Ai — Firestore data layer (doc 09)
//
// System of record: consults + drafts/finals/feedback subcollections, an
// append-only auditLog, and a models registry. The `deidMap` is the most
// sensitive field (identifiers ↔ tokens) and is stored in a separate, tighter
// collection (doc 09 §6).
//
// A pluggable driver keeps this runnable without GCP: FIRESTORE_DRIVER=memory
// uses an in-process store (dev/tests); FIRESTORE_DRIVER=firestore uses the real
// @google-cloud/firestore (prod). Same async API either way.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const DRIVER = process.env.FIRESTORE_DRIVER || 'memory';

// ── In-memory driver (dev / tests) ───────────────────────────────────────────
function memoryDriver() {
  const db = { consults: new Map(), deidMaps: new Map(), auditLog: [], models: new Map() };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    async createConsult(consult) {
      const id = consult.consultId;
      db.consults.set(id, { ...clone(consult), drafts: [], finals: [], feedback: [] });
      return id;
    },
    async getConsult(id) { return db.consults.has(id) ? clone(db.consults.get(id)) : null; },
    async updateConsult(id, patch) {
      const c = db.consults.get(id); if (!c) throw new Error('no consult ' + id);
      Object.assign(c, clone(patch)); return clone(c);
    },
    async addDraft(id, draft) { db.consults.get(id).drafts.push(clone(draft)); return draft.draftId; },
    async addFinal(id, final) { db.consults.get(id).finals.push(clone(final)); return final.finalId; },
    async addFeedback(id, fb) { db.consults.get(id).feedback.push(clone(fb)); return fb.feedbackId; },
    async putDeidMap(id, map, fingerprint) { db.deidMaps.set(id, { map: clone(map), fingerprint }); },
    async getDeidMap(id) { return db.deidMaps.get(id)?.map || null; },
    async appendAudit(evt) { db.auditLog.push(clone(evt)); return evt.eventId; },
    async listConsults(limit = 50) {
      return [...db.consults.values()].slice(-limit).reverse()
        .map((c) => ({ consultId: c.consultId, specialty: c.specialty, noteType: c.noteType, status: c.status, createdAt: c.createdAt }));
    },
    async registerModel(m) { db.models.set(m.modelVersion, clone(m)); },
    _debug: () => db,
  };
}

// ── Firestore driver (prod) ──────────────────────────────────────────────────
async function firestoreDriver() {
  const { Firestore, FieldValue } = await import('@google-cloud/firestore');
  const fs = new Firestore();
  const consults = fs.collection('consults');
  const deidMaps = fs.collection('deidMaps');       // locked-down (doc 09 §6)
  const auditLog = fs.collection('auditLog');
  const models = fs.collection('models');
  return {
    async createConsult(consult) {
      await consults.doc(consult.consultId).set({ ...consult, createdAt: consult.createdAt || new Date().toISOString() });
      return consult.consultId;
    },
    async getConsult(id) { const d = await consults.doc(id).get(); return d.exists ? d.data() : null; },
    async updateConsult(id, patch) { await consults.doc(id).set(patch, { merge: true }); return (await consults.doc(id).get()).data(); },
    async addDraft(id, draft) { await consults.doc(id).collection('drafts').doc(draft.draftId).set(draft); return draft.draftId; },
    async addFinal(id, final) { await consults.doc(id).collection('finals').doc(final.finalId).set(final); return final.finalId; },
    async addFeedback(id, fb) { await consults.doc(id).collection('feedback').doc(fb.feedbackId).set(fb); return fb.feedbackId; },
    async putDeidMap(id, map, fingerprint) { await deidMaps.doc(id).set({ map, fingerprint, updatedAt: FieldValue.serverTimestamp() }); },
    async getDeidMap(id) { const d = await deidMaps.doc(id).get(); return d.exists ? d.data().map : null; },
    async appendAudit(evt) { await auditLog.doc(evt.eventId).set({ ...evt, timestamp: evt.timestamp || new Date().toISOString() }); return evt.eventId; },
    async listConsults(limit = 50) {
      const snap = await consults.orderBy('createdAt', 'desc').limit(limit).get();
      return snap.docs.map((d) => { const c = d.data(); return { consultId: d.id, specialty: c.specialty, noteType: c.noteType, status: c.status, createdAt: c.createdAt }; });
    },
    async registerModel(m) { await models.doc(m.modelVersion).set(m); },
  };
}

let _driver = null;
async function driver() {
  if (_driver) return _driver;
  // STORE_BACKEND=postgres → full Postgres cutover (recommended). Falls back to the
  // legacy FIRESTORE_DRIVER (memory | firestore) when not set.
  const backend = process.env.STORE_BACKEND || (DRIVER === 'firestore' ? 'firestore' : 'memory');
  if (backend === 'postgres') { const { pgStoreDriver } = await import('../db/pgStore.js'); _driver = pgStoreDriver(); }
  else _driver = DRIVER === 'firestore' ? await firestoreDriver() : memoryDriver();
  return _driver;
}

// ── Public API (contract-aligned with doc 09 §2) ─────────────────────────────
export const store = {
  createConsult: async (c) => (await driver()).createConsult(c),
  getConsult: async (id) => (await driver()).getConsult(id),
  updateConsult: async (id, p) => (await driver()).updateConsult(id, p),
  addDraft: async (id, d) => (await driver()).addDraft(id, d),
  addFinal: async (id, f) => (await driver()).addFinal(id, f),
  addFeedback: async (id, fb) => (await driver()).addFeedback(id, fb),
  putDeidMap: async (id, m, fp) => (await driver()).putDeidMap(id, m, fp),
  getDeidMap: async (id) => (await driver()).getDeidMap(id),
  listConsults: async (n) => (await driver()).listConsults(n),
  registerModel: async (m) => (await driver()).registerModel(m),
};

/**
 * Append-only audit entry for every PHI access / note state change (doc 09 §5).
 * Never updated or deleted.
 */
export async function audit({ consultId, actor, action, target = null, meta = {} }) {
  const evt = {
    eventId: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    consultId, actor, action, target, meta,
    timestamp: new Date().toISOString(),
  };
  return (await driver()).appendAudit(evt);
}
