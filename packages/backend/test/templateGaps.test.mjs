import test from 'node:test';
import assert from 'node:assert/strict';
import { toTemplateFormat } from '../src/orchestrator/templateFormat.js';

const MD = `### Subjective
**Presenting Complaint:**
- Weight check
- Medication refill

**Weight Management:**
- Weight 190 lb, wants to lose 20 lb
- Walks 30 minutes daily
- Cut out sugary drinks

**Mood:**
- Sleeping poorly

**Back Pain:**
- Right low back pain for 2 weeks

### Objective
**Vital Signs**
- BP 120/80
**Examination**
- Chest clear

### Assessment & Plan
1. **Weight**
   - Treatment planned: Continue diet
`;

test('topic headings go, one blank line stays between topic groups, no gap between two lone lines in a row', () => {
  const out = toTemplateFormat(MD);
  const subj = out.split('### Objective')[0];
  assert.doesNotMatch(subj, /Weight Management|Mood:|Back Pain:|Presenting Complaint/);
  assert.match(subj, /- Medication refill\n\n- Weight 190 lb/);        // group of 2 then group of 3: gap
  assert.match(subj, /- Cut out sugary drinks\n\n- Sleeping poorly/);   // group of 3 then a lone line: gap
  assert.match(subj, /- Sleeping poorly\n- Right low back pain/);       // two lone lines in a row: together
  assert.doesNotMatch(out, /\u0001/);
  assert.doesNotMatch(out, /\n\n\n/);
});

test('every line survives, Objective stays flat, no gap right under the heading or before the next section', () => {
  const out = toTemplateFormat(MD);
  const bullets = (s) => s.split('\n').filter((l) => /^\s*-\s/.test(l)).map((l) => l.trim()).sort().join('|');
  const before = MD.split('### Assessment')[0].replace(/\*\*[^*]+\*\*\n/g, '').split('\n').filter((l) => /^- /.test(l)).sort().join('|');
  assert.equal(bullets(out.split('### Assessment')[0]), before);
  assert.match(out, /### Subjective\n- Weight check/);
  assert.match(out, /### Objective\n- BP 120\/80\n- Chest clear/);
  assert.match(out, /Rest|Continue diet/);
});
