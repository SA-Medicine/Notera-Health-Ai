// Last layout steps on the finished note markdown (both off by default, switched on by env):
//   REPEAT_TRIM=1       repeatTrim.js: exact repeats inside a line or between problems, plan actions told as story in Subjective
//   NOTE_FORMAT=template  templateFormat.js: the layout of the clinician's preferred note (flat lists, plain plan lines, one last Follow-up item)
'use strict';
import { trimRepeats } from './repeatTrim.js';
import { toTemplateFormat } from './templateFormat.js';

export function finishLayout(md, log = () => {}) {
  let out = md;
  if (process.env.REPEAT_TRIM === '1') { try { const r = trimRepeats(out); out = r.md; if (r.removed.length) log(`[v2:repeatTrim] removed ${r.removed.length}: ` + r.removed.map((x) => `${x.kind}: "${String(x.line).slice(0, 60)}"`).join(' | ')); } catch (e) { log(`[v2:repeatTrim] skipped — ${e.message}`); } }
  if (process.env.NOTE_FORMAT === 'template') { try { out = toTemplateFormat(out); } catch (e) { log(`[v2:template] skipped — ${e.message}`); } }
  return out;
}
