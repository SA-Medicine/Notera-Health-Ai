// node --test apps/web/test/copyNote.test.mjs  (needs Node 22.18+ / 24, which runs .ts files directly)
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteToClipboard } from '../app/(app)/app/copyNote.ts';

const NOTE = `### Subjective
**Presenting Complaint:**
- Cough for 3 days with **mild fever**
- No chest pain
**Associated Symptoms**
- Sore throat

### Objective
**Vital Signs**
- BP 130/80 mmHg, pulse 78
**Examination**
- Chest clear

### Assessment & Plan
1. **Acute bronchitis**
   - Diagnosis: Acute bronchitis
   - Treatment planned:
     - Started: Amoxicillin 500 mg three times daily for 5 days
     - Continued: Paracetamol 500 mg as needed
   - Advice: Drink plenty of fluids & rest <24 h
   - Follow-up: Review in 1 week
2. **Hypertension**
   - Diagnosis: Hypertension
`;

test('plain text has no markdown symbols and keeps the structure', () => {
  const { text } = noteToClipboard(NOTE);
  assert.ok(!/[#*_`]/.test(text), text);
  assert.ok(!/\*\*/.test(text));
  assert.match(text, /^SUBJECTIVE\n/);
  assert.match(text, /\nOBJECTIVE\n/);
  assert.match(text, /\nASSESSMENT & PLAN\n/);
  assert.match(text, /\n• Cough for 3 days with mild fever\n/);
  assert.match(text, /\n1\. Acute bronchitis\n/);
  assert.match(text, /\n   • Diagnosis: Acute bronchitis\n/);
  assert.match(text, /\n      – Started: Amoxicillin 500 mg three times daily for 5 days\n/);
  assert.ok(!/\n\n\n/.test(text));
});

test('html is formatted: headings, bold, lists, bold plan labels, escaped text', () => {
  const { html } = noteToClipboard(NOTE);
  assert.match(html, /<p [^>]*><b>Subjective<\/b><\/p>/);
  assert.match(html, /<strong>mild fever<\/strong>/);
  assert.match(html, /<ul /);
  assert.match(html, /<strong>Diagnosis:<\/strong> Acute bronchitis/);
  assert.match(html, /<strong>Started:<\/strong> Amoxicillin/);
  assert.match(html, /<p [^>]*><b>1\. Acute bronchitis<\/b><\/p>/);
  assert.match(html, /rest &lt;24 h/);
  assert.ok(!/\*\*|###/.test(html.replace(/<[^>]+>/g, '')), 'no markdown left in the visible text');
  assert.match(html, /^<meta charset="utf-8">/);
});

test('sub-points are nested inside their parent bullet and every tag is balanced', () => {
  const { html } = noteToClipboard(NOTE);
  assert.match(html, /<strong>Treatment planned:<\/strong> <ul [^>]*><li [^>]*><strong>Started:/);
  for (const tag of ['ul', 'li', 'p', 'b', 'strong', 'div']) {
    const open = (html.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length, close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    assert.equal(open, close, tag);
  }
});

test('empty and odd input does not throw', () => {
  assert.deepEqual(noteToClipboard(''), { html: '<meta charset="utf-8"><div style="font-family:Calibri,Arial,Helvetica,sans-serif;color:#000;font-size:11pt;"></div>', text: '' });
  const r = noteToClipboard('Just a line with **bold** and `code`\r\n\r\n- one');
  assert.equal(r.text, 'Just a line with bold and code\n• one');
});
