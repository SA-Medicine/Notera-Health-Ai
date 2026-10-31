// Local test only (2026-11-01): extra writer rules for the clinician's preferred note layout, read from prompts/writer-template-addendum.txt.
// Off by default: WRITER_TEMPLATE=1 appends them to whichever writer prompt is active. The locked writer-v5.txt is not touched.
import fs from 'fs';

let _txt = null;
export function templateAddendum() {
  if (process.env.WRITER_TEMPLATE !== '1') return '';
  if (_txt === null) { try { _txt = fs.readFileSync(new URL('../../prompts/writer-template-addendum.txt', import.meta.url), 'utf8').replace(/\r/g, ''); } catch { _txt = ''; } }
  return _txt;
}
