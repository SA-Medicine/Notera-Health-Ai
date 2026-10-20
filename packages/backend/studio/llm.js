// Small helper: one JSON-returning model call, with a tolerant parser. Studio uses it for evaluation, evidence, teaching and edit learning.
'use strict';

import { createGeminiService } from '../src/services/LLMService.js';

export function parseJson(raw) {
  const s = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch { /* try to cut to the outermost braces */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

export const MODELS = {
  judge: () => process.env.STUDIO_JUDGE_MODEL || 'gemini-2.5-pro',
  fast: () => process.env.STUDIO_FAST_MODEL || 'gemini-2.5-flash',
};

/** → parsed JSON object or throws. `llm` is injectable for tests: { generateContent(system, user, schema, opts) }. */
export async function askJson({ llm, model, agent = 'studio', system, user, maxOutputTokens = 6000, thinkingBudget = 0, timeoutMs = 120000 }) {
  const svc = llm || await createGeminiService(null, { model: model || MODELS.fast() });
  if (svc && 'object' === typeof svc) svc._agent = agent;
  const raw = await svc.generateContent(system, user, null, { maxOutputTokens, temperature: 0, responseMimeType: 'application/json', timeoutMs, retries: 1, thinkingBudget, hedgeMs: 0 });
  const out = parseJson(raw);
  if (!out) throw new Error(`${agent}: the model did not return valid JSON`);
  return out;
}
