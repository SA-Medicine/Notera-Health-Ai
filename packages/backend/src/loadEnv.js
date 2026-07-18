// Dependency-free .env loader. Imported FIRST in server.js so process.env is
// populated before config.js reads it. Looks for the repo-root .env (../.env
// from backend/) then backend/.env. Existing env vars always win.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/backend/src → repo root is three up. Keep the older candidates as fallback.
const candidates = [
  path.resolve(__dirname, '..', '..', '..', '.env'), // repo root (monorepo)
  path.resolve(__dirname, '..', '..', '.env'),        // legacy repo root
  path.resolve(__dirname, '..', '.env'),              // package-local
];

for (const file of candidates) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) {
        const v = m[2].replace(/^["']|["']$/g, '').replace(/[\r\n]+$/, '').trim();
        // Override undefined OR empty so a stale empty shell var can't win.
        if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
      }
    }
  } catch { /* file absent — fine */ }
}
