import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAdviceLines, classify } from '../src/orchestrator/adviceLines.js';
import { layout } from '../lab/formatMetrics.js';

const MD = `### Subjective\n- x\n\n### Assessment & Plan\n1. **Anxiety**\n   - Diagnosis: Anxiety\n   - Investigations planned: TSH\n   - Treatment planned: Continue Cipralex 10mg daily; Advised to increase water intake; Return if symptoms worsen; Rtc: 4 weeks\n   - Referrals: Psychiatry\n2. **Hypertension**\n   - Treatment planned: Continue candesartan\n3. **Back pain**\n   - Treatment planned: Counselled on lifting; Follow-up: 2 weeks with imaging`;
test('classification', () => { assert.equal(classify('Rtc: 4 weeks'), 'follow'); assert.equal(classify('Return to clinic in 1 month'), 'follow'); assert.equal(classify('Return if worse'), 'advice'); assert.equal(classify('Advised to rest'), 'advice'); assert.equal(classify('Continue Cipralex 10mg'), 'treat'); assert.equal(classify('Discontinue ashwagandha'), 'treat'); });
test('advice and follow-up move to their own lines; treatment and other problems are untouched', () => {
  const o = splitAdviceLines(MD);
  assert.match(o, /Treatment planned: Continue Cipralex 10mg daily\n/); assert.match(o, /Referrals: Psychiatry\n   - Advice: Advised to increase water intake; Return if symptoms worsen\n   - Follow-up: 4 weeks\n2\. /);
  assert.match(o, /2\. \*\*Hypertension\*\*\n   - Treatment planned: Continue candesartan\n3\./);
  assert.match(o, /3\. \*\*Back pain\*\*\n   - Advice: Counselled on lifting\n   - Follow-up: 2 weeks with imaging$/, 'a problem with only advice and follow-up loses its empty Treatment line');
  assert.equal(o.split('Treatment planned:').length - 1, 2); assert.ok(o.startsWith('### Subjective\n- x'));
});
test('nothing to move means the text is returned unchanged', () => { const plain = '### Assessment & Plan\n1. **A**\n   - Treatment planned: Start X; Stop Y'; assert.equal(splitAdviceLines(plain), plain); });
test('the format metrics see the new lines', () => { const l = layout(splitAdviceLines(MD)); assert.equal(l.counsellingLines, 2); assert.equal(l.followUpLines, 2); });
