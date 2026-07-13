// ─────────────────────────────────────────────────────────────────────────────
// Notera Prompt Registry — modular, versioned prompt store for pipeline agents.
//   • loadPrompt(id, fallback, vars) returns the PUBLISHED systemInstruction for
//     an agent prompt, falling back to the inline literal if the registry has no
//     entry (so nothing breaks on a fresh clone / empty registry).
//   • {{var}} tokens in a stored prompt are substituted from `vars`.
//   • Reads are cached by file mtime → editing+publishing a prompt hot-reloads
//     into the running pipeline on the next agent invocation.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STORE = path.join(HERE, 'store');

const _cache = new Map(); // absPath -> { mtimeMs, data }

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

/**
 * Return the published systemInstruction for a prompt id, or the fallback.
 */
export function loadPrompt(id, fallback, vars) {
  const rec = readJsonCached(path.join(STORE, `${id}.json`));
  if (!rec || !rec.publishedVersion) return substitute(fallback, vars);
  const ver = readJsonCached(path.join(STORE, id, `v${rec.publishedVersion}.json`));
  if (!ver || typeof ver.systemInstruction !== 'string') return substitute(fallback, vars);
  return substitute(ver.systemInstruction, vars);
}

/**
 * Per-prompt runtime config (editable from the admin dashboard):
 *  - freeform:        drop the agent's fixed responseSchema so the PROMPT fully
 *                     controls the output shape (for experimenting / custom rubrics)
 *  - maxOutputTokens: override the model's max output tokens for this agent
 */
export function loadPromptConfig(id) {
  const rec = readJsonCached(path.join(STORE, `${id}.json`)) || {};
  return {
    freeform: rec.freeform === true,
    maxOutputTokens: (typeof rec.maxOutputTokens === 'number' && rec.maxOutputTokens > 0) ? rec.maxOutputTokens : null,
  };
}

/** List all registry records (metadata only). Used by the admin server. */
export function listPrompts() {
  let files = [];
  try { files = fs.readdirSync(STORE).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJsonCached(path.join(STORE, f))).filter(Boolean);
}
