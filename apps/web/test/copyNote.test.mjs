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

test('plain text has no markdown symbols, headings like the preferred note, plan without bullets', () => {
  const { text } = noteToClipboard(NOTE);
  assert.ok(!/[#*_`]/.test(text), text);
  assert.match(text, /^Subjective:\n/);
  assert.match(text, /\nObjective:\n/);
  assert.match(text, /\nAssessment & Plan:\n/);
  assert.match(text, /\n• Cough for 3 days with mild fever\n/);       // Subjective is shown with bullets, so it keeps them
  assert.match(text, /\n1\. Acute bronchitis\n/);
  assert.match(text, /\n   Diagnosis: Acute bronchitis\n/);            // the plan is shown without bullets, so it copies without; each problem's lines sit indented under it
  assert.match(text, /\n      Started: Amoxicillin 500 mg three times daily for 5 days\n/);
  assert.ok(!/•[^\n]*(Diagnosis|Started|Advice)/.test(text));
  assert.ok(!/\n\n\n/.test(text));
});

test('html is formatted: bold headings, bold labels, bullets in the history, plan as plain paragraphs, escaped text', () => {
  const { html } = noteToClipboard(NOTE);
  assert.match(html, /<p [^>]*><b>Subjective:<\/b><\/p>/);
  assert.match(html, /<strong>mild fever<\/strong>/);
  assert.match(html, /<ul /);
  assert.match(html, /<p [^>]*><strong>Diagnosis:<\/strong> Acute bronchitis<\/p>/);
  assert.match(html, /<p [^>]*margin:0 0 2pt 28pt[^>]*><strong>Started:<\/strong> Amoxicillin/);
  assert.match(html, /<p [^>]*><b>1\. Acute bronchitis<\/b><\/p>/);
  assert.match(html, /rest &lt;24 h/);
  assert.ok(!/\*\*|###/.test(html.replace(/<[^>]+>/g, '')), 'no markdown left in the visible text');
  assert.match(html, /^<meta charset="utf-8">/);
  for (const tag of ['ul', 'li', 'p', 'b', 'strong', 'div']) {
    const open = (html.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length, close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    assert.equal(open, close, tag);
  }
});

test('empty and odd input does not throw', () => {
  assert.equal(noteToClipboard('').text, '');
  const r = noteToClipboard('Just a line with **bold** and `code`\r\n\r\n- one');
  assert.equal(r.text, 'Just a line with bold and code\n• one');
});

test('a blank line and a real spacer paragraph separate the problems of the plan (EMR editors drop margins)', () => {
  const { text, html } = noteToClipboard(NOTE);
  assert.ok(text.includes('Follow-up: Review in 1 week\n\n2. Hypertension\n'), text);
  assert.match(html, /&nbsp;<\/p><p [^>]*><b>2\. Hypertension<\/b><\/p>/);
  assert.match(html, /&nbsp;<\/p><p [^>]*><b>Objective:<\/b><\/p>/);
  assert.ok(!/^<meta charset="utf-8"><div [^>]*><p [^>]*>&nbsp;/.test(html), 'no spacer before the first heading');
});

test('a blank line between two groups of Subjective bullets stays as one gap (plain text and html), the plan is unchanged', () => {
  const md = '### Subjective\n- Cough for 3 days\n- No fever\n\n- Weight 190 lb, wants to lose 20 lb\n- Walks 30 minutes daily\n\n### Assessment & Plan\n1. **Cough**\n   - Rest\n';
  const { text, html } = noteToClipboard(md);
  assert.match(text, /• No fever\n\n• Weight 190 lb/);
  assert.doesNotMatch(text, /\n\n\n/);
  assert.match(html, /<\/ul><p style="margin:0;[^"]*font-size:6pt[^"]*">&nbsp;<\/p><ul/);
  // no gap when the bullets are in one run
  assert.doesNotMatch(noteToClipboard('### Subjective\n- A\n- B\n').text, /\n\n•/);
});
