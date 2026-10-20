// Live check of the engine chain with real engines on a 25-second clip of a benchmark recording. Prints which engine answered. No transcript text is printed.
import fs from 'node:fs';
import { transcodePcm16k } from '../src/asr/audio.js';
import { transcribeWithChain, getSettings, resetHealth, healthSnapshot } from '../src/asr/engines.js';
const mp3 = fs.readFileSync(process.env.CLIP || '/tmp/audio-bench/CAR0001.mp3'); const pcm = (await transcodePcm16k(mp3)).subarray(32000 * 60, 32000 * 85);   // 25 s from the middle
const show = (label, r) => console.log(label.padEnd(34), 'engine=' + r.engine, 'fellBack=' + !!r.fellBack, 'words=' + r.text.split(/\s+/).filter(Boolean).length, 'tried=' + r.tried.map((t) => `${t.engine}:${t.ok ? 'ok' : t.empty ? 'empty' : 'FAIL'}`).join(','));
console.log('built-in/stored settings:', JSON.stringify(await getSettings()));
resetHealth(); show('1. normal request', await transcribeWithChain(pcm, { log: () => {} }));
process.env.ASR_V2_LOCATION = 'no-such-region';          // makes Chirp 2 fail for real (unknown endpoint)
show('2. Chirp 2 broken -> fallback', await transcribeWithChain(pcm, { log: () => {} }));
show('3. Chirp 2 AND Gemini broken', await transcribeWithChain(pcm, { settings: { primary: 'chirp_2', fallbacks: ['gemini-bogus', 'latest_long'], timeoutMs: 60000, breakerFailures: 3, breakerCooldownMs: 300000, speechCheck: true }, log: () => {} }).catch((e) => ({ engine: 'ERROR ' + e.message.slice(0, 80), fellBack: false, text: '', tried: [] })));
console.log('health:', JSON.stringify(Object.fromEntries(Object.entries(healthSnapshot()).filter(([, h]) => h.calls).map(([k, h]) => [k, { ok: h.ok, fail: h.fail, fallbackServed: h.fallbackServed }]))));
process.exit(0);
