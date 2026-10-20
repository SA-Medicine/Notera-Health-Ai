// End-to-end check of POST /api/asr?rerun=1 against the running backend: mints a session cookie, uploads a whole recording and reports engine, time and word counts.
import fs from 'node:fs';
import path from 'node:path';
import { makeSession } from '../src/admin/session.js';
const DATA = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const S = makeSession(DATA); const cookie = `${S.COOKIE}=${S.issue({ id: process.env.USER_ID || 'livetest', email: 'livetest@example.com', role: 'admin' })}`;
const audio = fs.readFileSync(process.env.CLIP || '/tmp/audio-bench/CAR0001.mp3');
const words = (t) => (String(t).toLowerCase().match(/[a-z0-9']+/g) || []).length;
for (const [label, q] of [['normal  (/api/asr)', ''], ['re-run  (/api/asr?rerun=1)', '?rerun=1']]) {
  const t0 = Date.now(); const r = await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/api/asr${q}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/mpeg' }, body: audio });
  const j = await r.json().catch(() => ({})); console.log(label.padEnd(28), 'HTTP', r.status, 'engine=' + j.engine, 'seconds=' + ((Date.now() - t0) / 1000).toFixed(1), 'audio=' + (j.durationSeconds || 0).toFixed(0) + 's', 'words=' + words(j.text), j.error ? 'error=' + j.error : '');
}
process.exit(0);
