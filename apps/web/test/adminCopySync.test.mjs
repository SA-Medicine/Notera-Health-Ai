// node --test apps/web/test/adminCopySync.test.mjs  (Node 22.18+ / 24)
// The admin site's copy code is generated from the app's (scripts/sync-admin-copy.mjs). This fails when someone edits the app's copy code and forgets to regenerate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { generate } = await import(pathToFileURL(path.join(root, 'scripts/sync-admin-copy.mjs')).href);

test('the admin copy files match the app source', () => {
  for (const [name, body] of Object.entries(generate())) {
    const cur = readFileSync(path.join(root, 'apps/admin-site/public/noteclip', name), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(cur, body, `${name} is out of date: run node scripts/sync-admin-copy.mjs`);
  }
});

test('the admin copy produces the same clipboard output as the app', async () => {
  const app = await import(pathToFileURL(path.join(root, 'apps/web/app/(app)/app/copyNote.ts')).href);
  const adm = await import(pathToFileURL(path.join(root, 'apps/admin-site/public/noteclip/copyNote.js')).href);
  const md = '### Subjective\n- Cough\n\n### Assessment & Plan\n1. **Cough**\n   - Advice: Rest\n2. **Follow-up**\n   - 2 weeks\n';
  assert.deepEqual(adm.noteToClipboard(md), app.noteToClipboard(md));
});
