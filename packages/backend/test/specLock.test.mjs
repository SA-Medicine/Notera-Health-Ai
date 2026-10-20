import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint, diffLock, readLock } from '../spec/computeLock.mjs';

test('the doctor-approved Style Spec v1 has not drifted (prompts, guards, renderer, shipped settings)', async () => {
  const diff = diffLock(readLock(), await computeFingerprint());
  assert.deepEqual(diff, [], 'STYLE SPEC v1 IS LOCKED BY THE OWNER. Differences:\n  ' + diff.join('\n  ') + '\nDo not edit these files to "improve" notes. Only after the owner approves a new spec: node scripts/spec-lock.mjs write <version>');
});
test('the lock covers every v2 prompt and the key behaviour switches', async () => {
  const lock = readLock();
  for (const n of ['v2-writer', 'v2-story', 'v2-editor', 'v2-checklist', 'v2-verifier']) assert.ok(lock.prompts[n], `prompt ${n} is fingerprinted`);
  for (const k of ['story.enabled', 'editor.enabled', 'guards.template', 'guards.placement', 'ref.enabled', 'writer.model', 'writer.fewShot']) assert.ok(k in lock.configDefaultValues, `setting ${k} is fingerprinted`);
  assert.equal(lock.configDefaultValues['story.enabled'], true); assert.equal(lock.configDefaultValues['editor.enabled'], true);
});
