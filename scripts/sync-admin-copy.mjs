// The admin site is plain JavaScript with no build step, but its Copy button and its Ctrl+C on a selected note must behave exactly like the app's.
// The code lives once, in apps/web/app/(app)/app/{copyNote,noteRender,selectionCopy}.ts. This script strips the types and writes the same files
// to apps/admin-site/public/noteclip/*.js.
//   node scripts/sync-admin-copy.mjs           writes the files
//   node scripts/sync-admin-copy.mjs --check   exits 1 when they are out of date (used by apps/web/test/adminCopySync.test.mjs)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'apps/web/app/(app)/app');
const OUT = path.join(root, 'apps/admin-site/public/noteclip');
const FILES = ['copyNote', 'noteRender', 'selectionCopy'];

export function generate() {
  const out = {};
  for (const f of FILES) {
    const ts = readFileSync(path.join(SRC, f + '.ts'), 'utf8').replace(/\r\n/g, '\n');
    let js = stripTypeScriptTypes(ts, { mode: 'strip' }).replace(/^(import .* from )'\.\/(\w+)';/gm, "$1'./$2.js';");
    out[f + '.js'] = `// GENERATED from apps/web/app/(app)/app/${f}.ts by scripts/sync-admin-copy.mjs. Do not edit here.\n` + js;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = generate(); let stale = 0;
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(OUT, name);
    const cur = existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;
    if (process.argv.includes('--check')) { if (cur !== body) { stale++; console.error('out of date: ' + name); } continue; }
    mkdirSync(OUT, { recursive: true }); writeFileSync(p, body); console.log('wrote ' + path.relative(root, p));
  }
  if (stale) process.exit(1);
}
