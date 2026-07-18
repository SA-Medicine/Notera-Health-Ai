// ─────────────────────────────────────────────────────────────────────────────
// labStore — data access for the Testing Lab schema (db/schema.lab.sql).
//
// Thin, humanized helpers over the pg pool. Everything here is best-effort from
// the eval harness: if Postgres is unavailable the caller can ignore the throw
// and keep writing file results, so a broken DB never blocks a run.
//
//   patients:   upsertPatient, getPatientBySlug, listPatients
//   runs:       createRun, finishRun, nextRunNo
//   records:    upsertRunPatient
//   agents:     insertAgentRun, getAgentRun, latestRun
//   metrics:    upsertMetrics
// ─────────────────────────────────────────────────────────────────────────────
import { query, one, tx } from './pool.js';
import { sha256, slugify } from './labUtils.js';

// Re-export the pure helpers so existing importers (server, eval) are unaffected.
export { sha256, slugify };

// ── patients ─────────────────────────────────────────────────────────────────
/**
 * Insert or update a reference patient by heidi_session_id (falls back to slug).
 * Returns { id, slug, name, created } where created=true if newly inserted.
 */
export async function upsertPatient(p) {
  const slug = p.slug || slugify(p.name || p.subtitle, 'patient');
  const row = await one(
    `INSERT INTO lab.patients
       (slug, name, heidi_session_id, source_url, subtitle, tags,
        transcript_raw, transcript_clean, gold_note, transcript_sha256, gold_hash, artifacts, audits)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
     ON CONFLICT (heidi_session_id) DO UPDATE SET
        name=EXCLUDED.name, source_url=EXCLUDED.source_url, subtitle=EXCLUDED.subtitle,
        tags=EXCLUDED.tags, transcript_raw=EXCLUDED.transcript_raw,
        transcript_clean=EXCLUDED.transcript_clean, gold_note=EXCLUDED.gold_note,
        transcript_sha256=EXCLUDED.transcript_sha256, gold_hash=EXCLUDED.gold_hash,
        artifacts=EXCLUDED.artifacts, audits=EXCLUDED.audits, updated_at=now()
     RETURNING id, slug, name, (xmax = 0) AS created`,
    [slug, p.name || slug, p.heidi_session_id || null, p.source_url || null, p.subtitle || null,
     JSON.stringify(p.tags || []), p.transcript_raw || null, p.transcript_clean || null,
     p.gold_note || null, p.transcript_sha256 || (p.transcript_clean ? sha256(p.transcript_clean) : null),
     p.gold_hash || (p.gold_note ? sha256(p.gold_note) : null),
     JSON.stringify(p.artifacts || []), JSON.stringify(p.audits || [])]
  ).catch(async (e) => {
    // heidi_session_id may be null → ON CONFLICT can't fire; fall back to slug upsert.
    if (/null value|there is no unique|ON CONFLICT/i.test(e.message)) {
      return one(
        `INSERT INTO lab.patients
           (slug, name, source_url, subtitle, tags, transcript_raw, transcript_clean, gold_note, transcript_sha256, gold_hash, artifacts, audits)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
         ON CONFLICT (slug) DO UPDATE SET
            name=EXCLUDED.name, source_url=EXCLUDED.source_url, subtitle=EXCLUDED.subtitle,
            tags=EXCLUDED.tags, transcript_raw=EXCLUDED.transcript_raw,
            transcript_clean=EXCLUDED.transcript_clean, gold_note=EXCLUDED.gold_note,
            transcript_sha256=EXCLUDED.transcript_sha256, gold_hash=EXCLUDED.gold_hash,
            artifacts=EXCLUDED.artifacts, audits=EXCLUDED.audits, updated_at=now()
         RETURNING id, slug, name, (xmax = 0) AS created`,
        [slug, p.name || slug, p.source_url || null, p.subtitle || null, JSON.stringify(p.tags || []),
         p.transcript_raw || null, p.transcript_clean || null, p.gold_note || null,
         p.transcript_sha256 || (p.transcript_clean ? sha256(p.transcript_clean) : null),
         p.gold_hash || (p.gold_note ? sha256(p.gold_note) : null),
         JSON.stringify(p.artifacts || []), JSON.stringify(p.audits || [])]
      );
    }
    throw e;
  });
  return row;
}

export const getPatientBySlug = (slug) =>
  one(`SELECT * FROM lab.patients WHERE lower(slug)=lower($1)`, [slug]);

export const listPatients = () =>
  query(`SELECT id, slug, name, subtitle, heidi_session_id, source_url,
                length(transcript_clean) AS transcript_len, length(gold_note) AS gold_len,
                created_at, updated_at
         FROM lab.patients ORDER BY id`);

// ── runs ───────────────────────────────────────────────────────────────────
export async function nextRunNo() {
  const r = await one(`SELECT COALESCE(max(run_no),0)+1 AS n FROM lab.runs`);
  return r ? Number(r.n) : 1;
}

/** Create a run row. label is the eval dir name (unique). Returns the run id. */
export async function createRun({ label, pipelineVersion, model, promptSnapshot, notes, status = 'running' }) {
  const run_no = await nextRunNo();
  const r = await one(
    `INSERT INTO lab.runs (run_no, label, status, pipeline_version, model, prompt_snapshot, notes)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (label) DO UPDATE SET status=EXCLUDED.status
     RETURNING id, run_no`,
    [run_no, label, status, pipelineVersion || null, model || null, JSON.stringify(promptSnapshot || {}), notes || null]
  );
  return r;
}

export const finishRun = (runId, status = 'done') =>
  query(`UPDATE lab.runs SET status=$2, finished_at=now() WHERE id=$1`, [runId, status]);

export const listRuns = () =>
  query(`SELECT id, run_no, label, status, pipeline_version, model, started_at, finished_at,
                (SELECT count(*) FROM lab.run_patients rp WHERE rp.run_id=r.id) AS patient_count
         FROM lab.runs r ORDER BY run_no DESC`);

// ── records (run × patient) ──────────────────────────────────────────────────
export async function upsertRunPatient({ runId, patientId, generatedNote, renderedNote, status, schemaValid }) {
  const r = await one(
    `INSERT INTO lab.run_patients (run_id, patient_id, generated_note, rendered_note, status, schema_valid)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id, patient_id) DO UPDATE SET
       generated_note=EXCLUDED.generated_note, rendered_note=EXCLUDED.rendered_note,
       status=EXCLUDED.status, schema_valid=EXCLUDED.schema_valid
     RETURNING id`,
    [runId, patientId, generatedNote || null, renderedNote || null, status || null,
     schemaValid == null ? null : !!schemaValid]
  );
  return r.id;
}

// ── agent_runs ───────────────────────────────────────────────────────────────
export async function insertAgentRun(a) {
  const r = await one(
    `INSERT INTO lab.agent_runs
       (run_id, patient_id, run_patient_id, agent_id, seq, system_prompt, prompt_version,
        input, output_raw, output_parsed, status, error_message, tokens_in, tokens_out,
        latency_ms, model, rerun_of, attempt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [a.runId, a.patientId, a.runPatientId || null, a.agentId, a.seq || 0,
     a.systemPrompt || null, a.promptVersion || null, JSON.stringify(a.input || {}),
     a.outputRaw || null, a.outputParsed == null ? null : JSON.stringify(a.outputParsed),
     a.status || 'ok', a.errorMessage || null, a.tokensIn || null, a.tokensOut || null,
     a.latencyMs || null, a.model || null, a.rerunOf || null, a.attempt || 1]
  );
  return r.id;
}

export const getAgentRun = (id) => one(`SELECT * FROM lab.agent_runs WHERE id=$1`, [id]);

/** Most recent attempt for a given (run, patient, agent) — the row to replay. */
export const latestAgentRun = (runId, patientId, agentId) =>
  one(`SELECT * FROM lab.agent_runs WHERE run_id=$1 AND patient_id=$2 AND agent_id=$3
       ORDER BY attempt DESC, id DESC LIMIT 1`, [runId, patientId, agentId]);

export const getRun = (id) => one(`SELECT * FROM lab.runs WHERE id=$1`, [id]);
export const getPatient = (id) => one(`SELECT * FROM lab.patients WHERE id=$1`, [id]);
export const getRunPatient = (runId, patientId) =>
  one(`SELECT * FROM lab.run_patients WHERE run_id=$1 AND patient_id=$2`, [runId, patientId]);

export const latestRun = () =>
  one(`SELECT id, run_no, label FROM lab.runs ORDER BY run_no DESC LIMIT 1`);

/** patient ids that have a record in this run (for rerun-on-run). */
export const patientsOfRun = (runId) =>
  query(`SELECT DISTINCT patient_id FROM lab.run_patients WHERE run_id=$1 ORDER BY patient_id`, [runId]);

// ── metrics ────────────────────────────────────────────────────────────────
/** metrics: { section_coverage: 0.8, qa_accuracy_score: 4.2, ... } */
export async function upsertMetrics({ runId, patientId, runPatientId, metrics }) {
  const entries = Object.entries(metrics || {}).filter(([, v]) => typeof v === 'number' && isFinite(v));
  if (!entries.length) return 0;
  await tx(async (client) => {
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO lab.metrics (run_id, patient_id, run_patient_id, metric_key, metric_value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (run_patient_id, metric_key) DO UPDATE SET metric_value=EXCLUDED.metric_value`,
        [runId, patientId, runPatientId, key, value]
      );
    }
  });
  return entries.length;
}

// ── dashboard reads ──────────────────────────────────────────────────────────
export const trendByRun = () =>
  query(`SELECT r.run_no, r.label, m.metric_key, avg(m.metric_value) AS value
         FROM lab.runs r JOIN lab.metrics m ON m.run_id=r.id
         GROUP BY r.run_no, r.label, m.metric_key ORDER BY r.run_no`);

export const metricsForRun = (runId) =>
  query(`SELECT p.slug, p.name, m.metric_key, m.metric_value
         FROM lab.metrics m JOIN lab.patients p ON p.id=m.patient_id
         WHERE m.run_id=$1 ORDER BY p.slug, m.metric_key`, [runId]);

export const agentStats = (runId) =>
  query(`SELECT agent_id, calls, errors, avg_latency_ms, avg_tokens_in, avg_tokens_out
         FROM lab.v_agent_stats WHERE run_id=$1 ORDER BY agent_id`, [runId]);

export const heatmap = (runId) =>
  query(`SELECT p.slug, p.name, m.metric_key, m.metric_value, rp.status, rp.id AS run_patient_id
         FROM lab.run_patients rp
         JOIN lab.patients p ON p.id=rp.patient_id
         LEFT JOIN lab.metrics m ON m.run_patient_id=rp.id
         WHERE rp.run_id=$1 ORDER BY p.slug, m.metric_key`, [runId]);

export const agentRunsFor = (runId, patientId) =>
  query(`SELECT id, agent_id, seq, status, latency_ms, tokens_in, tokens_out,
                attempt, rerun_of, created_at, output_parsed
         FROM lab.agent_runs WHERE run_id=$1 AND patient_id=$2 ORDER BY seq, attempt`, [runId, patientId]);
