// Computes the fingerprint of the doctor-approved Style Spec v1: every prompt the pipeline ships, the shipped defaults of every
// spec-shaping setting, and the code that enforces the format (guards, renderer, reference names). Used by
// scripts/spec-lock.mjs (check | write) and test/specLock.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
export const LOCK_FILE = path.join(HERE, 'LOCK.json');
const sha = (t) => crypto.createHash('sha256').update(String(t).replace(/\r\n/g, '\n')).digest('hex');

export const LOCKED_FILES = [
  'prompts/writer-v5.txt',
  'src/orchestrator/postGuards.js',
  'src/orchestrator/renderMarkdown.js',
  'src/orchestrator/refNames.js',
  'src/orchestrator/specLock.js',
  'src/orchestrator/planJoin.js',
  'src/orchestrator/planSweep.js',
  'src/orchestrator/qualityGuards.js',
  'src/orchestrator/laterality.js',
  'src/orchestrator/adviceLines.js',
  'src/orchestrator/writerGuard.js',
  'src/orchestrator/topicGroup.js',
  'src/orchestrator/groundingAgent.js',
  'src/orchestrator/conditionGuard.js',
];

export async function computeFingerprint() {
  const files = {};
  for (const f of LOCKED_FILES) files[f] = sha(fs.readFileSync(path.join(BACKEND, f), 'utf8'));
  const { PROMPT_REGISTRY } = await import('../src/orchestrator/generateNoteV2.js');
  const { REGISTRY, } = await import('../src/orchestrator/runtimeConfig.js');
  const { isLockedKey } = await import('../src/orchestrator/specLock.js');
  const prompts = {}; for (const [name, reg] of Object.entries(PROMPT_REGISTRY)) prompts[name] = sha(reg.default());
  const defaults = {}; for (const [k, m] of Object.entries(REGISTRY)) if (isLockedKey(k)) defaults[k] = m.def();
  return { files, prompts, configDefaults: sha(JSON.stringify(defaults)), configDefaultValues: defaults };
}
export function readLock() { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); }

/** Differences between the stored lock and the current code (empty = identical). */
export function diffLock(lock, now) {
  const out = [];
  for (const [f, h] of Object.entries(lock.files)) if (now.files[f] !== h) out.push(`file changed: ${f}`);
  for (const [n, h] of Object.entries(lock.prompts)) if (now.prompts[n] !== h) out.push(`prompt changed: ${n}`);
  for (const n of Object.keys(now.prompts)) if (!(n in lock.prompts)) out.push(`prompt added: ${n}`);
  if (lock.configDefaults !== now.configDefaults) {
    const keys = new Set([...Object.keys(lock.configDefaultValues || {}), ...Object.keys(now.configDefaultValues)]);
    for (const k of keys) if (JSON.stringify((lock.configDefaultValues || {})[k]) !== JSON.stringify(now.configDefaultValues[k])) out.push(`setting default changed: ${k} (${JSON.stringify((lock.configDefaultValues || {})[k])} -> ${JSON.stringify(now.configDefaultValues[k])})`);
  }
  return out;
}
