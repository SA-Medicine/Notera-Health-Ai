#!/usr/bin/env node
// Measure every stored recording that has not been measured yet (length, loudness, words, "look at" flags) into ops.audio_review.
//   docker exec -w /app/packages/backend notera-backend node tools/audio-analyse.mjs
// Same code the admin console's "Measure new" button runs. Prints counts only, never recording names or content.
import { analyseBatch } from '../src/admin/audioLibrary.js';
let total = 0;
for (let i = 0; i < 50; i++) { const r = await analyseBatch({ limit: 8, log: (l) => console.log('  ' + l) }); total += r.done; console.log(`measured ${total}, ${r.remaining} left`); if (!r.remaining || !r.done) break; }
process.exit(0);
