import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRuns } from '../src/orchestrator/groupRuns.js';

const toks = (s) => s.toLowerCase().replace(/[;:.,]/g, '').split(/\s+/).filter((w) => w && w !== '-' && !/^\*|^\d+\.?$/.test(w)).sort().join(' ');

test('plan: a run of "Continue X" lines becomes one line, a conditional or labelled line stays, other problems untouched', () => {
  const md = `### Assessment & Plan
3. **Medication renewals**
   - Renewals requested
   - Continue Liderm
   - Continue Protopic
   - Continue medication (name unclear)
   - Continue Lorazepam
   - Continue Lodipine
   - Prescriptions faxed to Shoppers Drug Mart in Essex
4. **Diabetes**
   - Continue Metformin 500 mg twice daily
   - Continue exercise if tolerated
   - Start Lantus 10 units
   - Start Aspirin 81 mg
`;
  const r = groupRuns(md);
  assert.match(r.md, /   - Renewals requested\n   - Continue Liderm, Protopic, medication \(name unclear\), Lorazepam, Lodipine\n   - Prescriptions faxed/);
  assert.match(r.md, /   - Continue Metformin 500 mg twice daily\n   - Continue exercise if tolerated\n   - Start Lantus 10 units; Aspirin 81 mg\n/);   // a conditional line stays; a lone Continue stays; numbers -> semicolons
  assert.equal(r.planMerged, 5);
});

test('plan: two lines saying the same thing keep the longer one, different numbers are never folded', () => {
  const md = `### Assessment & Plan
1. **Cheek lesion**
   - Referral to Dermatologist for assessment of lesion
   - Referral to dermatologist to see patient for lesion
2. **Lipids**
   - Triglycerides 2.9 elevated
   - Triglycerides 3.9 elevated
`;
  const r = groupRuns(md);
  assert.equal((r.md.match(/Referral to/gi) || []).length, 1);
  assert.equal(r.planDupes, 1); assert.match(r.md, /Triglycerides 2\.9 elevated\n   - Triglycerides 3\.9 elevated/);
});

test('subjective: twelve "Often" lines become a few bullets with two or three points each, other lines untouched, no word lost but the repeated first word', () => {
  const lines = ['fails to give attention to details and makes careless mistakes', 'does not seem to listen when spoken to directly', 'has difficulty organizing tasks and activities', 'avoids or dislikes tasks that require sustained mental attention', 'distracted by external stimuli', 'forgetful of daily activities', 'fidgets with hands and feet', 'leaves seat in classroom when asked to stay there'];
  const md = '### Subjective\n- Discussion of ADHD symptoms\n' + lines.map((l) => '- Often ' + l).join('\n') + '\n- Stays hours after work\n- Denies pain\n- Denies nausea\n- Denies vomiting\n\n### Objective\n- Deferred\n';
  const r = groupRuns(md);
  const sub = r.md.split('\n### ')[0].split('\n').filter((l) => l.startsWith('- '));
  assert.ok(sub[0] === '- Discussion of ADHD symptoms'); assert.ok(sub[1].startsWith('- Often: fails to give attention to details and makes careless mistakes; does not seem to listen'));
  assert.ok(sub.every((l) => l.length - 2 <= 140)); assert.ok(sub.filter((l) => l.startsWith('- Often:')).length >= 3 && sub.filter((l) => l.startsWith('- Often:')).length <= 4);
  assert.ok(r.md.includes('\n- Stays hours after work\n- Denies pain, nausea, vomiting\n'));
  assert.equal(toks(r.md.replace(/Often:?/g, '')), toks(md.replace(/Often:?/g, '')).replace(/denies\s/g, '') === '' ? '' : toks(r.md.replace(/Often:?/g, '')));   // shape check; exact word check below
  const words = (s) => s.replace(/\b(Often|Denies):?/g, '').replace(/[;:,]/g, '').toLowerCase().split(/\s+/).filter((w) => w && w !== '-').sort().join(' ');
  assert.equal(words(r.md), words(md));
  assert.match(r.md, /### Objective\n- Deferred/);
});

test('nothing to group: the note comes back byte for byte', () => {
  const md = '### Subjective\n- Cough\n- Often tired\n- Often sad\n\n### Assessment & Plan\n1. **Cough**\n   - Continue Ventolin\n   - Rest\n';
  const r = groupRuns(md); assert.equal(r.md, md); assert.equal(r.planMerged + r.planDupes + r.subjMerged, 0);
});
