import test from 'node:test';
import assert from 'node:assert/strict';
import { remapCoverageRaw, ledgerShim, issuesOf } from '../src/orchestrator/gapEarly.js';

const note = (issues, extra = {}) => ({ metadata: {}, subjective: { hpi_details: 'Cough:\n- Dry cough for 3 days, worse at night' }, past_medical_history: {}, objective: {}, assessment_and_plan: issues.map((i) => ({ issue: i, treatment_planned: '' })), ...extra });
const F = (o) => ({ id: 'F001', type: 'symptom', text: '', importance: 'major', confidence: 0.9, medication: '', medication_status: '', dose: '', frequency: '', value: '', unit: '', negative: false, render_required: true, quote: 'q', grounded: true, ...o });

test('plan numbers of an early coverage answer follow the problems by title; a problem that is gone becomes "no problem" with its title', () => {
  const asked = ['Hip pain', 'Cough', 'Eczema']; const now = note(['Cough', 'Eczema']);   // "Hip pain" was merged away meanwhile
  const raw = JSON.stringify({ items: [{ section: 'plan', n: 2, field: 'advice', text: 'Rest', evidence: 'rest it' }, { section: 'plan', n: 1, field: 'advice', text: 'Ice', evidence: 'use ice' }, { section: 'subjective', topic: 'Cough', text: 'No fever', evidence: 'no fever' }] });
  const out = JSON.parse(remapCoverageRaw(raw, asked, now)).items;
  assert.equal(out[0].n, 1, 'Cough is problem 1 now'); assert.equal(out[1].n, 0); assert.equal(out[1].topic, 'Hip pain'); assert.equal(out[2].section, 'subjective');
  assert.deepEqual(issuesOf(now), ['Cough', 'Eczema']); assert.equal(remapCoverageRaw(null, asked, now), null);
});

test('the ledger stand-in answers with the early answer, rewritten for the current note', async () => {
  const graph = { facts: [F({ id: 'F001', type: 'symptom', text: 'Dry cough for 3 days', importance: 'major' }), F({ id: 'F002', type: 'symptom', text: 'Sleeps with extra pillows nightly', importance: 'major' })] };
  const cur = note(['Cough'], { subjective: { hpi_details: 'Cough:\n- Cough since Monday, worse at night\n- Needs extra pillows' } });
  const early = { graph, foundIds: new Set(['F002']), askedIds: new Set(['F001']), issues: ['Cough'], answer: { raw: JSON.stringify({ entries: [{ fact: 'F001', found_in: 'Cough since Monday, worse at night, tried honey' }] }) } };
  const raw = JSON.parse(await ledgerShim(early, cur).generateContent());
  const byFact = Object.fromEntries(raw.entries.map((e) => [e.fact, e]));
  assert.equal(byFact.F001.found_in, 'Cough since Monday, worse at night', 'the early claim now names the matching line of the current note');
  assert.equal(byFact.F002.found_in, 'Needs extra pillows', 'a fact the code found before the story, reworded since, points at its best current line');
});
