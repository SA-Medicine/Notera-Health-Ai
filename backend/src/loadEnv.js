// Dependency-free .env loader. Imported FIRST in server.js so process.env is
// populated before config.js reads it. Looks for the repo-root .env (../.env
// from backend/) then backend/.env. Existing env vars always win.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(__dirname, '..', '..', '.env'), // repo root
  path.resolve(__dirname, '..', '.env'),        // backend/
];

for (const file of candidates) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* file absent — fine */ }
}
