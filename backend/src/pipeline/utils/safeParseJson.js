/**
 * Repair a truncated/unterminated JSON string by trimming to the last complete
 * value and closing any still-open brackets. This salvages a usable object/array
 * when an LLM response is cut off mid-stream (e.g. max output tokens reached),
 * instead of hard-crashing the whole pipeline.
 *
 * Strategy: scan once, tracking string state and the stack of open brackets.
 * Remember the position (and bracket stack) right after every completed value
 * (a closed string, `}`, or `]`). Truncate to the last such "safe" point, drop a
 * trailing comma, then append the matching closers for whatever remains open.
 */
function repairTruncatedJson(input) {
  let s = String(input).replace(/```json\n?|```/g, '').trim();
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  s = s.slice(start);

  const stack = [];          // pending closing chars, e.g. ['}', ']']
  let inStr = false, esc = false;
  let lastGood = -1;         // index of last char that completed a value
  let lastGoodStack = null;  // bracket stack snapshot at that point

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') { inStr = false; lastGood = i; lastGoodStack = stack.slice(); }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      // Only a closed structure is a safe truncation point — a closed *string* may be
      // an object key with no value yet, which would produce invalid JSON if we cut there.
      stack.pop();
      lastGood = i;
      lastGoodStack = stack.slice();
    }
  }

  if (lastGood < 0 || !lastGoodStack) return null;

  let repaired = s.slice(0, lastGood + 1).replace(/[\s,]*$/, '');
  for (let i = lastGoodStack.length - 1; i >= 0; i--) repaired += lastGoodStack[i];

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

export function safeParseJson(jsonString) {
  // Defensive sanitization for LLM outputs that contain invalid escape sequences.
  // 1. Fix bad unicode escapes: \u not followed by 4 hex digits becomes \\u
  let sanitized = jsonString.replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u');
  // 2. Fix bad hex escapes: \x is not valid in JSON strings, escape it
  sanitized = sanitized.replace(/\\x/g, '\\\\x');

  try {
    const cleanJson = sanitized.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    // Fallback 1: bracket-aware repair of a truncated/unterminated response. Runs
    // first so the outer container type (object vs array) is preserved when salvaging.
    const repaired = repairTruncatedJson(sanitized);
    if (repaired !== null && repaired !== undefined) {
      console.warn("[safeParseJson] Recovered from truncated JSON via salvage repair.");
      return repaired;
    }

    // Fallback 2: extract the outermost object/array and parse it directly.
    try {
      const match = sanitized.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (match) {
        return JSON.parse(match[0]);
      }
    } catch (fallbackErr) {
      console.warn("Regex JSON parse fallback also failed.", fallbackErr?.message);
    }

    throw new Error("Failed to parse output as JSON: " + err.message);
  }
}
