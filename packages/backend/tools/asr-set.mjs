#!/usr/bin/env node
// Change the speech-to-text settings the same way the admin console does (ops.asr_settings, validated, live within 30 s).
//   node tools/asr-set.mjs <base64 of a JSON patch> [who]      e.g. {"primary":"gemini-2.5-flash","fallbacks":["chirp_2","latest_long"],"crossCheck":false}
// Prints the settings before and after. Run inside the lab or backend container (they hold the database access).
import { getSettings, saveSettings, clearAsrSettingsCache } from '../src/asr/engines.js';
const patch = process.argv[2] ? JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')) : {};
const who = process.argv[3] || 'ops-tool';
clearAsrSettingsCache(); const before = await getSettings();
const after = Object.keys(patch).length ? await saveSettings({ ...before, ...patch }, who) : before;
console.log(JSON.stringify({ changed: Object.keys(patch).length > 0, before, after }, null, 1));
process.exit(0);
