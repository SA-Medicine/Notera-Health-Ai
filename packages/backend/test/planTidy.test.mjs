import test from 'node:test';
import assert from 'node:assert/strict';
import { planTidy } from '../src/orchestrator/planTidy.js';

const MD = `### Subjective
- increased appetite

### Assessment & Plan
1. **Weight management.**
   - increased appetite
   - Arrange blood test
   - arrange blood test.
   - Continue Wegovy 1 mg weekly
2. **Insomnia**
   - Arrange blood test
`;

test('plan tidy: Objective gets capitals and a glued second finding on its own bullet, words kept', () => {
  const md = '### Objective\n- hemoglobin: fine\n- LDL 2.5 mmol/L (increased from 2.2). Abdominal wall ultrasound: hernias, largest 9.2 cm\n- BP 120/80 mmHg (clinic). Weight 185 lbs\n';
  const r = planTidy(md);
  assert.equal(r.md, '### Objective\n- Hemoglobin: fine\n- LDL 2.5 mmol/L (increased from 2.2).\n- Abdominal wall ultrasound: hernias, largest 9.2 cm\n- BP 120/80 mmHg (clinic). Weight 185 lbs\n');
  assert.equal(r.splitO, 1);
});

test('plan tidy: title full stop, capital letter, repeat inside one problem; other sections and other problems untouched', () => {
  const r = planTidy(MD);
  assert.equal(r.titles, 1); assert.equal(r.dupes, 1); assert.equal(r.caps, 1);
  assert.match(r.md, /- increased appetite\n\n### Assessment/);   // Subjective is not touched
  assert.match(r.md, /1\. \*\*Weight management\*\*\n   - Increased appetite\n   - Arrange blood test\n   - Continue Wegovy 1 mg weekly\n2\. \*\*Insomnia\*\*\n   - Arrange blood test\n$/);
  assert.equal(planTidy('### Subjective\n- a\n').md, '### Subjective\n- a\n');
});
