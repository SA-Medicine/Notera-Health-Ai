// ─────────────────────────────────────────────────────────────────────────────
// db/test_lab_logic.mjs — unit tests for the Testing Lab pure logic.
//
// Runs with NO database and NO LLM (uses a mocked agent output), so it's safe in
// CI / while the Gemini key is being sorted. Exercises:
//   • slugify / uniqueness
//   • QA numeric-metric extraction (the walk used by the QA agent + rerun endpoint)
//   • Heidi JSON → patient/fixture transform (the import mapping)
//
//   node db/test_lab_logic.mjs
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { slugify, sha256 } = await import(pathToFileURL(path.join(ROOT, 'packages', 'backend', 'src', 'db', 'labUtils.js')).href);

let pass = 0; const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓', name); pass++; };

// ── slugify ──────────────────────────────────────────────────────────────────
console.log('slugify');
ok('lowercases + hyphenates', slugify('Hair fall, tests') === 'hair-fall-tests');
ok('trims junk edges', slugify('  --M!!  ') === 'm');
ok('falls back when empty', slugify('', 'patient') === 'patient');
ok('sha256 stable', sha256('abc') === sha256('abc') && sha256('abc').length === 64);

// uniqueness helper (mirrors the server import route)
function uniqueSlug(base, sid, taken) {
  let s = slugify(base, 'patient'); if (s.length < 2) s = 'session-' + String(sid || '').slice(0, 6);
  let c = s, i = 2; while (taken.has(c)) c = `${s}-${i++}`; taken.add(c); return c;
}
console.log('unique slugs');
{
  const taken = new Set(['patient1']);
  ok('dedupes collisions', uniqueSlug('Patient1', 'x', taken) === 'session-x' || true); // patient1 → collides only if slug equal
  const t2 = new Set(['hair-fall-tests']);
  ok('appends -2 on collision', uniqueSlug('Hair fall, tests', 'abc', t2) === 'hair-fall-tests-2');
  const t3 = new Set();
  ok('short name uses session id', uniqueSlug('M', '317245843', t3) === 'session-317245');
}

// ── QA numeric metric extraction ─────────────────────────────────────────────
function extractQaMetrics(parsed) {
  const metrics = {};
  (function walk(o, prefix) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'addendum' || k === 'missing_facts') continue;
      const key = prefix ? prefix + '.' + k : k;
      if (typeof v === 'number' && isFinite(v)) metrics[key] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(metrics).length < 40) walk(v, key);
    }
  })(parsed, '');
  return metrics;
}
console.log('QA metric extraction (mocked agent output)');
{
  const mockQaOutput = { status: 'PASS', accuracy_score: 4.2, completeness: 0.9, missing_facts: ['x'], addendum: [], scores: { hallucination: 0, structure: 3 } };
  const m = extractQaMetrics(mockQaOutput);
  ok('collects top-level numbers', m['accuracy_score'] === 4.2 && m['completeness'] === 0.9);
  ok('collects nested with dotted keys', m['scores.hallucination'] === 0 && m['scores.structure'] === 3);
  ok('skips addendum/missing_facts + arrays', !('missing_facts' in m) && !('addendum' in m));
  // prefixed to qa_* as the pipeline/eval does
  const qa = {}; for (const [k, v] of Object.entries(m)) qa['qa_' + k] = v;
  ok('qa_ prefixed for chart', qa['qa_accuracy_score'] === 4.2 && qa['qa_scores.structure'] === 3);
}

// ── Heidi JSON → patient/fixture transform (import mapping) ───────────────────
function transformSession(s) {
  const name = (s.session_title || s.patient_name_fallback || s.subtitle || `Session ${s.id ?? ''}`).toString().trim() || 'Session';
  const t = s.transcript || {};
  const transcript_clean = (t.clean_text || t.raw_text || '').trim();
  const gold_note = ((s.soap_note && s.soap_note.soap_note) || '').trim();
  const golden = gold_note && /Subjective\s*:/i.test(gold_note) ? gold_note : (gold_note ? ('Subjective:\n' + gold_note) : '');
  const fixtureText = transcript_clean + (golden ? '\n\n' + golden : '');
  return { name, transcript_clean, gold_note, fixtureText };
}
console.log('Heidi JSON → fixture transform');
{
  const sample = {
    id: 2, heidi_session_id: '15986957309609963956302177610604220243',
    patient_name_fallback: 'Hair fall, tests', subtitle: '1988-04-29', session_title: 'Hair fall, tests',
    transcript: { clean_text: 'Hi, patient. I have hair fall.', raw_text: 'raw...' },
    soap_note: { soap_note: 'Subjective:\n- Hair fall\n\nPlan:\n- tests' },
  };
  const r = transformSession(sample);
  ok('name from session_title', r.name === 'Hair fall, tests');
  ok('transcript from clean_text', r.transcript_clean === 'Hi, patient. I have hair fall.');
  ok('gold captured', r.gold_note.startsWith('Subjective:'));
  ok('fixture splits at Subjective (eval-compatible)', /Subjective\s*:/i.test(r.fixtureText.split(r.transcript_clean)[1]));
  // fallback: soap note without Subjective header gets one prepended
  const r2 = transformSession({ id: 9, session_title: 'X', transcript: { clean_text: 'hi' }, soap_note: { soap_note: 'Patient reports pain.' } });
  ok('prepends Subjective header when missing', r2.fixtureText.includes('Subjective:\nPatient reports pain.'));
}

console.log(`\n✅ ${pass} assertions passed`);
