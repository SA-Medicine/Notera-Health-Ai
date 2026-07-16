// ─────────────────────────────────────────────────────────────────────────────
// Backfill on-disk data → Postgres: prompt registry, eval runs/fixtures/metrics,
// sessions, and run logs. Idempotent (upserts). Runs against DATABASE_URL.
//   DATABASE_URL=... node db/backfill_files.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const url = process.env.DATABASE_URL;
if (!url) { console.error('✗ DATABASE_URL is not set'); process.exit(1); }

const client = new pg.Client({ connectionString: url });
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const numericLeaves = (obj, prefix = '', out = {}) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (typeof v === 'number' && isFinite(v)) out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) numericLeaves(v, key, out);
  }
  return out;
};

async function backfillPrompts() {
  const STORE = path.join(ROOT, 'backend', 'prompts', 'store');
  let files = []; try { files = fs.readdirSync(STORE).filter((f) => f.endsWith('.json')); } catch { return; }
  let nP = 0, nV = 0;
  for (const f of files) {
    const rec = readJson(path.join(STORE, f)); if (!rec) continue;
    await client.query(
      `INSERT INTO ops.prompts (id, agent, file, label, stage, description, kind, vars, active, sort_order,
                                freeform, max_output_tokens, schema, published_version, draft, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'agent'),COALESCE($8,'[]')::jsonb,COALESCE($9,false),$10,
               COALESCE($11,false),$12,$13,$14,$15::jsonb,COALESCE($16,now()))
       ON CONFLICT (id) DO UPDATE SET
         agent=EXCLUDED.agent, file=EXCLUDED.file, label=EXCLUDED.label, stage=EXCLUDED.stage,
         description=EXCLUDED.description, kind=EXCLUDED.kind, vars=EXCLUDED.vars, active=EXCLUDED.active,
         sort_order=EXCLUDED.sort_order, freeform=EXCLUDED.freeform, max_output_tokens=EXCLUDED.max_output_tokens,
         schema=EXCLUDED.schema, published_version=EXCLUDED.published_version, draft=EXCLUDED.draft, updated_at=EXCLUDED.updated_at`,
      [rec.id, rec.agent || null, rec.file || null, rec.label || null, rec.stage || null, rec.description || null,
       rec.kind || null, JSON.stringify(rec.vars || []), rec.active === true, (typeof rec.order === 'number' ? rec.order : null),
       rec.freeform === true, (typeof rec.maxOutputTokens === 'number' ? rec.maxOutputTokens : null),
       (typeof rec.schema === 'string' ? rec.schema : null), rec.publishedVersion || null,
       rec.draft ? JSON.stringify(rec.draft) : null, rec.updatedAt || null]
    ); nP++;
    const vdir = path.join(STORE, rec.id);
    let vfiles = []; try { vfiles = fs.readdirSync(vdir).filter((x) => /^v\d+\.json$/.test(x)); } catch {}
    for (const vf of vfiles) {
      const v = readJson(path.join(vdir, vf)); if (!v) continue;
      await client.query(
        `INSERT INTO ops.prompt_versions (prompt_id, version, system_instruction, note, author, created_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,now())) ON CONFLICT (prompt_id, version) DO NOTHING`,
        [rec.id, v.version, v.systemInstruction || '', v.note || null, v.author || null, v.createdAt || null]
      ); nV++;
    }
  }
  console.log(`  prompts: ${nP} records, ${nV} versions`);
}

async function backfillEval() {
  const RESULTS = path.join(ROOT, 'eval', 'results');
  let dirs = []; try { dirs = fs.readdirSync(RESULTS).filter((d) => /^run_/.test(d) && fs.statSync(path.join(RESULTS, d)).isDirectory()); } catch { return; }
  // map admin runs.json (command/status/timestamps) by resultDir
  const runsMeta = {}; for (const r of (readJson(path.join(ROOT, 'admin', 'data', 'runs.json')) || [])) if (r.resultDir) runsMeta[r.resultDir] = r;
  let nR = 0, nF = 0, nM = 0, nL = 0;
  for (const dir of dirs) {
    const summary = readJson(path.join(RESULTS, dir, '_summary.json'))?.summary || {};
    const meta = runsMeta[dir] || {};
    await client.query(
      `INSERT INTO ops.eval_runs (run_id, command, status, started_at, finished_at, summary)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'{}')::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET command=EXCLUDED.command, status=EXCLUDED.status,
         started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at, summary=EXCLUDED.summary`,
      [dir, meta.command || null, meta.status || null, meta.startedAt || null, meta.finishedAt || null, JSON.stringify(summary)]
    ); nR++;
    // run-level metric points from summary
    for (const [k, v] of Object.entries(numericLeaves(summary))) {
      await client.query(`INSERT INTO ops.eval_metric_points (run_id, fixture_id, metric_key, value) VALUES ($1,NULL,$2,$3)`, [dir, k, v]); nM++;
    }
    // per-fixture results + metric points
    let fjson = []; try { fjson = fs.readdirSync(path.join(RESULTS, dir)).filter((x) => x.endsWith('.json') && !x.startsWith('_')); } catch {}
    for (const fj of fjson) {
      const d = readJson(path.join(RESULTS, dir, fj)); if (!d) continue;
      const fixtureId = fj.replace(/\.json$/, '');
      const score = d.score || {};
      const qa = {}; for (const [k, v] of Object.entries(score)) if (k.startsWith('qa_') && typeof v === 'number') qa[k] = v;
      await client.query(
        `INSERT INTO ops.eval_fixture_results (run_id, fixture_id, score, note, rendered_note, flags, qa_metrics)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,COALESCE($6,'[]')::jsonb,COALESCE($7,'{}')::jsonb)
         ON CONFLICT (run_id, fixture_id) DO UPDATE SET score=EXCLUDED.score, note=EXCLUDED.note,
           rendered_note=EXCLUDED.rendered_note, flags=EXCLUDED.flags, qa_metrics=EXCLUDED.qa_metrics`,
        [dir, fixtureId, JSON.stringify(score), JSON.stringify(d.note ?? null), d.renderedNote || null,
         JSON.stringify(d.flags || []), JSON.stringify(qa)]
      ); nF++;
      for (const [k, v] of Object.entries(numericLeaves(score))) {
        await client.query(`INSERT INTO ops.eval_metric_points (run_id, fixture_id, metric_key, value) VALUES ($1,$2,$3,$4)`, [dir, fixtureId, k, v]); nM++;
      }
    }
    // pipeline log → run_logs
    const plog = path.join(RESULTS, dir, '_pipeline.log');
    if (fs.existsSync(plog)) {
      await client.query(`INSERT INTO ops.run_logs (run_id, source, log) VALUES ($1,'pipeline',$2)`, [dir, fs.readFileSync(plog, 'utf8')]); nL++;
    }
  }
  console.log(`  eval: ${nR} runs, ${nF} fixtures, ${nM} metric points, ${nL} pipeline logs`);
}

async function backfillAdminLogs() {
  const LOGDIR = path.join(ROOT, 'admin', 'data', 'logs');
  let files = []; try { files = fs.readdirSync(LOGDIR).filter((f) => f.endsWith('.log')); } catch { return; }
  let n = 0;
  for (const f of files) {
    await client.query(`INSERT INTO ops.run_logs (run_id, source, log) VALUES ($1,'admin',$2)`, [f.replace(/\.log$/, ''), fs.readFileSync(path.join(LOGDIR, f), 'utf8')]); n++;
  }
  console.log(`  admin logs: ${n}`);
}

async function backfillSessions() {
  const SDIR = path.join(ROOT, 'admin', 'data', 'sessions');
  let files = []; try { files = fs.readdirSync(SDIR).filter((f) => f.endsWith('.json')); } catch { return; }
  let n = 0;
  for (const f of files) {
    const arr = readJson(path.join(SDIR, f)); const list = Array.isArray(arr) ? arr : (arr ? [arr] : []);
    for (const s of list) {
      if (!s || !s.id) continue;
      await client.query(
        `INSERT INTO ops.sessions (id, heidi_session_id, session_title, subtitle, session_date, session_time,
                                   language, duration, tags, source_url, transcript, soap_note, artifacts, audits, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'[]')::jsonb,$10,$11::jsonb,$12::jsonb,COALESCE($13,'[]')::jsonb,COALESCE($14,'[]')::jsonb,$15,$16)
         ON CONFLICT (id) DO UPDATE SET session_title=EXCLUDED.session_title, transcript=EXCLUDED.transcript,
           soap_note=EXCLUDED.soap_note, artifacts=EXCLUDED.artifacts, audits=EXCLUDED.audits, updated_at=EXCLUDED.updated_at`,
        [s.id, s.heidi_session_id || null, s.session_title || null, s.subtitle || null,
         (s.session_date && /^\d{4}-\d{2}-\d{2}/.test(s.session_date)) ? s.session_date.slice(0, 10) : null,
         s.session_time || null, s.language || null, s.duration || null, JSON.stringify(s.tags || []), s.source_url || null,
         JSON.stringify(s.transcript ?? null), JSON.stringify(s.soap_note ?? null), JSON.stringify(s.artifacts || []),
         JSON.stringify(s.audits || []), s.created_at || null, s.updated_at || null]
      ); n++;
    }
  }
  console.log(`  sessions: ${n}`);
}

try {
  await client.connect();
  console.log('Backfilling files → Postgres…');
  await backfillPrompts();
  await backfillEval();
  await backfillAdminLogs();
  await backfillSessions();
  console.log('✅ file backfill complete');
} catch (e) {
  console.error('✗ backfill failed:', e.message || e.code || String(e));
  if (e.code) console.error('   code:', e.code);
  if (e.errors) for (const sub of e.errors) console.error('   -', sub.code || sub.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
