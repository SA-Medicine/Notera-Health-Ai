/**
 * Repair a truncated/unterminated JSON string by trimming to a complete value and
 * closing any still-open brackets. Salvages a usable object/array when an LLM
 * response is cut off (e.g. max output tokens reached) instead of crashing.
 *
 * Robust strategy: record EVERY safe truncation point (right after a closed string,
 * `}`, or `]`, with a snapshot of the open-bracket stack). Then try to rebuild+parse
 * from the LATEST safe point backward until one parses — so we always recover at
 * least the complete leading entities even from a huge truncated array.
 */
function repairTruncatedJson(input) {
  let s = String(input).replace(/```json\n?|```/g, '').trim();
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  s = s.slice(start);

  const stack = [];
  let inStr = false, esc = false;
  const safePoints = []; // [{ index, stack: [...] }] — index is the last char of a completed value

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') { inStr = false; safePoints.push({ index: i, stack: stack.slice() }); }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      safePoints.push({ index: i, stack: stack.slice() });
    }
  }

  // Try each safe point newest → oldest; return the first that parses.
  for (let p = safePoints.length - 1; p >= 0; p--) {
    const { index, stack: st } = safePoints[p];
    let repaired = s.slice(0, index + 1).replace(/[\s,]*$/, '');
    for (let i = st.length - 1; i >= 0; i--) repaired += st[i];
    try {
      const parsed = JSON.parse(repaired);
      if (p < safePoints.length - 1) console.warn(`[safeParseJson] Salvaged truncated JSON at safe point ${p + 1}/${safePoints.length}.`);
      return parsed;
    } catch { /* try an earlier safe point */ }
  }
  return null;
}

export function safeParseJson(jsonString) {
  // Defensive sanitization for LLM outputs with invalid escape sequences.
  let sanitized = jsonString.replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u');
  sanitized = sanitized.replace(/\\x/g, '\\\\x');

  try {
    const cleanJson = sanitized.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    // Fallback 1: bracket-aware salvage of a truncated/unterminated response.
    const repaired = repairTruncatedJson(sanitized);
    if (repaired !== null && repaired !== undefined) {
      console.warn('[safeParseJson] Recovered from truncated JSON via salvage repair.');
      return repaired;
    }
    // Fallback 2: extract the outermost object/array and parse it directly.
    try {
      const match = sanitized.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
    } catch (fallbackErr) {
      console.warn('Regex JSON parse fallback also failed.', fallbackErr?.message);
    }
    throw new Error('Failed to parse output as JSON: ' + err.message);
  }
}
