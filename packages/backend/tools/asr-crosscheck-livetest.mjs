#!/usr/bin/env node
// Live check of the chain with the second opinion ON, on the first minutes of a benchmark recording (real engines, default settings).
//   docker exec -w /app/packages/backend notera-lab node tools/asr-crosscheck-livetest.mjs /lab-data/audio/CAR0002.mp3 180
// Prints the engine that answered, the second opinion's statistics and the wall time. No transcript text is printed.
import fs from 'node:fs';
import { transcodePcm16k } from '../src/asr/audio.js';
import { transcribeWithChain, getSettings } from '../src/asr/engines.js';
const [file, secs] = [process.argv[2] || '/lab-data/audio/CAR0002.mp3', Number(process.argv[3]) || 180];
const pcm = (await transcodePcm16k(fs.readFileSync(file))).subarray(0, 32000 * secs);
console.log('settings:', JSON.stringify(await getSettings()));
const t0 = Date.now(); const logs = []; const r = await transcribeWithChain(pcm, { log: (l) => logs.push(l) });
console.log('engine=' + r.engine, 'fellBack=' + !!r.fellBack, 'words=' + r.text.split(/\s+/).filter(Boolean).length, 'ms=' + (Date.now() - t0), 'consensus=' + JSON.stringify(r.consensus || null));
console.log(logs.filter((l) => /asr:|chirp v2/.test(l)).join('\n'));
process.exit(0);
