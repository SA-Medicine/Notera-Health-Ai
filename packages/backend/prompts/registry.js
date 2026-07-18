// ─────────────────────────────────────────────────────────────────────────────
// Notera Prompt Registry — modular, versioned prompt store for pipeline agents.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STORE = path.join(HERE, 'store');

const _cache = new Map();

function readJsonCached(absPath) {
  try {
    const st = fs.statSync(absPath);
    const hit = _cache.get(absPath);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    _cache.set(absPath, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch { return null; }
}

function substitute(text, vars) {
  if (!vars || typeof text !== 'string') return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
}

/** Return the published systemInstruction for a prompt id, or the fallback. */
export function loadPrompt(id, fallback, vars) {
  const rec = readJsonCached(path.join(STORE, `${id}.json`));
  if (!rec || !rec.publishedVersion) return substitute(fallback, vars);
  const ver = readJsonCached(path.join(STORE, id, `v${rec.publishedVersion}.json`));
  if (!ver || typeof ver.systemInstruction !== 'string') return substitute(fallback, vars);
  return substitute(ver.systemInstruction, vars);
}

/**
 * Per-prompt runtime config (editable from the admin dashboard):
 *  - freeform:        drop the fixed responseSchema so the prompt controls output
 *  - maxOutputTokens: override the model's max output tokens
 *  - schema:          an output-schema block auto-appended to the bottom of the call
 */
export function loadPromptConfig(id) {
  const rec = readJsonCached(path.join(STORE, `${id}.json`)) || {};
  return {
    freeform: rec.freeform === true,
    maxOutputTokens: (typeof rec.maxOutputTokens === 'number' && rec.maxOutputTokens > 0) ? rec.maxOutputTokens : null,
    schema: (typeof rec.schema === 'string') ? rec.schema : '',
  };
}

/** List all registry records (metadata only). Used by the admin server. */
export function listPrompts() {
  let files = [];
  try { files = fs.readdirSync(STORE).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJsonCached(path.join(STORE, f))).filter(Boolean);
}
