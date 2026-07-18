// ─────────────────────────────────────────────────────────────────────────────
// Postgres implementation of the store API used by the orchestrator.
// Drop-in replacement for the Firestore/in-memory driver in firestore/store.js.
// Same async method names + return values.
//
// PHI note: the de-identification map is encrypted with pgcrypto (pgp_sym_encrypt)
// using DEID_ENC_KEY from the environment — the key never lives in the database.
// ─────────────────────────────────────────────────────────────────────────────
import { getPool, withSession } from './pool.js';

const svc = (fn) => withSession({ role: 'service' }, fn);
const DEID_KEY = () => process.env.DEID_ENC_KEY || '';

async function upsertClinician(client, clinicianId) {
  if (!clinicianId) return;
  await client.query(
    `INSERT INTO clinical.clinicians (clinician_id) VALUES ($1) ON CONFLICT (clinician_id) DO NOTHING`,
    [clinicianId]
  );
}

export function pgStoreDriver() {
  return {
    async createConsult(c) {
      return svc(async (client) => {
        await upsertClinician(client, c.clinicianId);
        await client.query(
          `INSERT INTO clinical.consults
             (consult_id, clinician_id, specialty, note_type, status, audio_uri, pipeline_version, transcript, entities, metadata, created_at)
           VALUES ($1,$2,$3,$4, COALESCE($5,'processing')::clinical.consult_status, $6,$7,$8,$9, COALESCE($10,'{}')::jsonb, COALESCE($11, now()))
           ON CONFLICT (consult_id) DO UPDATE SET
             clinician_id=EXCLUDED.clinician_id, specialty=EXCLUDED.specialty, note_type=EXCLUDED.note_type,
             status=EXCLUDED.status, audio_uri=EXCLUDED.audio_uri, pipeline_version=EXCLUDED.pipeline_version`,
          [c.consultId, c.clinicianId || null, c.specialty || null, c.noteType || null, c.status || null,
           c.audioUri || null, c.generatedBy || c.pipelineVersion || null,
           c.transcript ? JSON.stringify(c.transcript) : null,
           c.entities ? JSON.stringify(c.entities) : null,
           c.metadata ? JSON.stringify(c.metadata) : null, c.createdAt || null]
        );
        return c.consultId;
      });
    },

    async getConsult(id) {
      return svc(async (client) => {
        const { rows } = await client.query(`SELECT * FROM clinical.consults WHERE consult_id=$1`, [id]);
        if (!rows[0]) return null;
        const consult = rows[0];
        const [drafts, finals, feedback] = await Promise.all([
          client.query(`SELECT * FROM clinical.drafts   WHERE consult_id=$1 ORDER BY created_at`, [id]),
          client.query(`SELECT * FROM clinical.finals    WHERE consult_id=$1 ORDER BY created_at`, [id]),
          client.query(`SELECT * FROM clinical.feedback  WHERE consult_id=$1 ORDER BY created_at`, [id]),
        ]);
        return { ...consult, drafts: drafts.rows, finals: finals.rows, feedback: feedback.rows };
      });
    },

    async updateConsult(id, patch) {
      return svc(async (client) => {
        const map = {
          clinician_id: patch.clinicianId, specialty: patch.specialty, note_type: patch.noteType,
          status: patch.status, audio_uri: patch.audioUri, pipeline_version: patch.generatedBy,
          transcript: patch.transcript !== undefined ? JSON.stringify(patch.transcript) : undefined,
          entities: patch.entities !== undefined ? JSON.stringify(patch.entities) : undefined,
          metadata: patch.metadata !== undefined ? JSON.stringify(patch.metadata) : undefined,
        };
        const sets = [], vals = []; let i = 1;
        for (const [col, v] of Object.entries(map)) {
          if (v === undefined) continue;
          if (col === 'status') { sets.push(`status = $${i}::clinical.consult_status`); }
          else if (col === 'transcript' || col === 'entities' || col === 'metadata') { sets.push(`${col} = $${i}::jsonb`); }
          else { sets.push(`${col} = $${i}`); }
          vals.push(v); i++;
        }
        if (!sets.length) return (await client.query(`SELECT * FROM clinical.consults WHERE consult_id=$1`, [id])).rows[0] || null;
        vals.push(id);
        const { rows } = await client.query(`UPDATE clinical.consults SET ${sets.join(', ')} WHERE consult_id=$${i} RETURNING *`, vals);
        return rows[0] || null;
      });
    },

    async addDraft(id, d) {
      return svc(async (client) => {
        await client.query(
          `INSERT INTO clinical.drafts (draft_id, consult_id, note, rendered_note, status, flags, generated_by, created_at)
           VALUES ($1,$2,$3::jsonb,$4, COALESCE($5,'DRAFT')::clinical.note_status, COALESCE($6,'[]')::jsonb, $7, COALESCE($8, now()))
           ON CONFLICT (draft_id) DO NOTHING`,
          [d.draftId, id, JSON.stringify(d.note ?? null), d.renderedNote || null, d.status || null,
           d.flags ? JSON.stringify(d.flags) : null, d.generatedBy || null, d.createdAt || null]
        );
        return d.draftId;
      });
    },

    async addFinal(id, f) {
      return svc(async (client) => {
        await upsertClinician(client, f.approvedBy);
        await client.query(
          `INSERT INTO clinical.finals (final_id, consult_id, draft_id, note, approved_by, approved_at, status, created_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6, COALESCE($7,'APPROVED')::clinical.note_status, now())
           ON CONFLICT (final_id) DO NOTHING`,
          [f.finalId, id, f.draftId || null, JSON.stringify(f.note ?? null), f.approvedBy || null, f.approvedAt || null, f.status || null]
        );
        return f.finalId;
      });
    },

    async addFeedback(id, fb) {
      return svc(async (client) => {
        await upsertClinician(client, fb.clinicianId);
        await client.query(
          `INSERT INTO clinical.feedback (feedback_id, consult_id, draft_id, final_id, clinician_id, rating, edits, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, COALESCE($8, now()))
           ON CONFLICT (feedback_id) DO NOTHING`,
          [fb.feedbackId, id, fb.draftId || null, fb.finalId || null, fb.clinicianId || null,
           (typeof fb.rating === 'number' ? fb.rating : null), fb.edits ? JSON.stringify(fb.edits) : null, fb.createdAt || null]
        );
        return fb.feedbackId;
      });
    },

    async putDeidMap(id, map, fingerprint) {
      return svc(async (client) => {
        await client.query(
          `INSERT INTO phi.deid_maps (consult_id, map_enc, fingerprint, token_count)
           VALUES ($1, pgp_sym_encrypt($2, $3), $4, $5)
           ON CONFLICT (consult_id) DO UPDATE SET
             map_enc = pgp_sym_encrypt($2, $3), fingerprint = $4, token_count = $5, updated_at = now()`,
          [id, JSON.stringify(map || {}), DEID_KEY(), fingerprint || '', Object.keys(map || {}).length]
        );
      });
    },

    async getDeidMap(id) {
      return svc(async (client) => {
        const { rows } = await client.query(
          `SELECT pgp_sym_decrypt(map_enc, $2)::text AS m FROM phi.deid_maps WHERE consult_id=$1`, [id, DEID_KEY()]
        );
        if (!rows[0]) return null;
        try { return JSON.parse(rows[0].m); } catch { return null; }
      });
    },

    async listConsults(limit = 50) {
      return svc(async (client) => {
        const { rows } = await client.query(`SELECT * FROM clinical.consults ORDER BY created_at DESC LIMIT $1`, [limit]);
        return rows;
      });
    },

    async registerModel(m) {
      await getPool().query(
        `INSERT INTO ops.models (model_version, provider, name, params)
         VALUES ($1,$2,$3, COALESCE($4,'{}')::jsonb)
         ON CONFLICT (model_version) DO UPDATE SET provider=EXCLUDED.provider, name=EXCLUDED.name, params=EXCLUDED.params`,
        [m.modelVersion, m.provider || null, m.name || null, m.params ? JSON.stringify(m.params) : null]
      );
    },

    async appendAudit(evt) {
      await getPool().query(
        `INSERT INTO clinical.audit_log (consult_id, actor, action, target, meta, created_at)
         VALUES ($1,$2,$3,$4, COALESCE($5,'{}')::jsonb, COALESCE($6, now()))`,
        [evt.consultId || null, evt.actor || 'system', evt.action || 'unknown', evt.target || null,
         evt.meta ? JSON.stringify(evt.meta) : null, evt.timestamp || null]
      );
      return evt.eventId || null;
    },
  };
}
