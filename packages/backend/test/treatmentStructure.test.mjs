import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, bare, structureTreatment } from '../src/orchestrator/treatmentStructure.js';
import { splitAdviceLines } from '../src/orchestrator/adviceLines.js';
import { noteToMarkdown } from '../src/orchestrator/renderMarkdown.js';

test('parts are sorted into what was started, changed, stopped, continued, given today and the rest', () => {
  assert.equal(classify('Start Lyrica (pregabalin) 75 mg twice daily'), 'Started'); assert.equal(classify('Lyrica 75 mg twice daily'), 'Other', 'no action word: not assumed started');
  assert.equal(classify('Discontinue naproxen'), 'Stopped'); assert.equal(classify('Do not take Percocet'), 'Stopped');
  assert.equal(classify('Continue Tylenol (acetaminophen) as needed'), 'Continued'); assert.equal(classify('Refill amlodipine 5 mg daily'), 'Continued');
  assert.equal(classify('Increase trazodone to 100 mg at bedtime'), 'Changed');
  assert.equal(classify('Influenza vaccine administered'), 'Given today'); assert.equal(classify('Dressing applied'), 'Given today');
  assert.equal(classify('Leave open to air'), 'Other');
});
test('the verb moves into the label; the drug, dose and reason stay exactly as written', () => {
  assert.equal(bare('Start Lyrica (pregabalin) 75 mg twice daily for pain', 'Started'), 'Lyrica (pregabalin) 75 mg twice daily for pain');
  assert.equal(bare('Discontinue naproxen', 'Stopped'), 'Naproxen'); assert.equal(bare('Continue Tylenol as needed', 'Continued'), 'Tylenol as needed');
});
test('a treatment line with several parts becomes sub-points in a fixed order; a single plain item is left alone', () => {
  const md = '### Assessment & Plan\n1. **Left hip pain**\n   - Investigations planned: X-ray pelvis\n   - Treatment planned: Continue Tylenol as needed; Start Lyrica 75 mg twice daily; Discontinue naproxen; Influenza vaccine administered\n   - Advice: Weight check at every visit\n2. **Burn**\n   - Treatment planned: Leave open to air\n';
  const out = structureTreatment(md);
  assert.match(out, /   - Treatment planned:\n     - Started: Lyrica 75 mg twice daily\n     - Stopped: Naproxen\n     - Continued: Tylenol as needed\n     - Given today: Influenza vaccine administered\n   - Advice:/);
  assert.match(out, /2\. \*\*Burn\*\*\n   - Treatment planned: Leave open to air/);
  assert.equal(structureTreatment('### Subjective\n- Treatment planned: not touched'), '### Subjective\n- Treatment planned: not touched');
});
test('works after the Advice / Follow-up split on a rendered note', () => {
  const note = { metadata: {}, subjective: { hpi_details: 'Hip pain' }, assessment_and_plan: [{ issue: 'Hip pain', treatment_planned: 'Start Lyrica 75 mg twice daily; Discontinue naproxen; Advised weight check at every visit; Rtc: 2 weeks' }] };
  const md = structureTreatment(splitAdviceLines(noteToMarkdown(note)));
  assert.match(md, /Treatment planned:\n     - Started: Lyrica 75 mg twice daily\n     - Stopped: Naproxen\n   - Advice: Weight check at every visit\n   - Follow-up: 2 weeks/);
});
test('Objective: labelled groups, and Deferred when nothing was measured, examined or reviewed', () => {
  const full = noteToMarkdown({ metadata: {}, subjective: { hpi_details: 'Cough' }, objective: { vital_signs: 'BP 150/80', examination: 'Chest clear', completed_investigations: 'Chest x-ray: clear' }, assessment_and_plan: [{ issue: 'Cough' }] });
  assert.match(full, /### Objective\n\*\*Vital Signs\*\*\n- BP 150\/80\n\n\*\*Examination\*\*\n- Chest clear\n\n\*\*Investigations\*\*\n- Chest x-ray: clear/);
  const none = noteToMarkdown({ metadata: {}, subjective: { hpi_details: 'Cough for 3 days' }, assessment_and_plan: [{ issue: 'Cough', treatment_planned: 'Rest' }] });
  assert.match(none, /### Objective\n- Deferred\n\n### Assessment & Plan/);
  assert.equal(noteToMarkdown({ metadata: {} }), '', 'an empty note stays empty');
});
