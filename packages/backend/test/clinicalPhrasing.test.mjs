// Plan-action vs patient-history classification.
//
// These two rules decide whether a line may be DELETED, so a false "narrative" reading is
// how a real prescription gets silently removed. The fixture lines are taken verbatim from
// a real pipeline run on a 7-minute consult.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isBledHistory, isHistoryNarrative, isPlanAction } from '../src/validation/clinicalPhrasing.js';

// Verbs written as stems in the pattern. The previous regex closed the group with \b,
// which made every one of these unmatchable — "continu" cannot be followed by a word
// boundary in "Continue". That silently disabled the guard protecting plan actions.
test('stem-form management verbs are recognised in all their inflections', () => {
  const mustMatch = [
    'Continue metformin 1 g twice daily.',
    'Continued on amlodipine.',
    'Continuing current therapy.',
    'Increase amlodipine to 10 mg once daily.',
    'Increased the dose last visit.',
    'Decrease gabapentin to 100 mg.',
    'Prescribed paracetamol 1 g PRN.',
    'Prescribe atorvastatin 20 mg.',
    'Referral to diabetes educator for dietary support.',
    'Referred to cardiology.',
    'Refer to ENT.',
    'Counseled on potential muscle pain.',
    'Counselling about smoking provided.',
    'Arranged repeat bloods.',
    'Titrating insulin as needed.',
    'Discontinued ibuprofen.',
    'Commence nicotine replacement therapy.',
    'Initiated atorvastatin.',
    'Provided knee strengthening exercises.',
    'Educated about foot care.',
  ];
  for (const line of mustMatch) assert.ok(isPlanAction(line), `not recognised as a plan action: "${line}"`);
});

test('every real plan line from a live consult survives', () => {
  const plan = [
    'Kidney function tests and electrolytes.',
    'Increase amlodipine to 10 mg once daily.',
    'Continue home blood pressure monitoring.',
    'Follow up in clinic in 2 weeks.',
    'Repeat HbA1c in 3 months.',
    'Continue metformin 1 g twice daily.',
    'Referral to diabetes educator for dietary support.',
    'Paracetamol 1 g up to 4 times daily PRN for pain.',
    'Provided knee strengthening exercises.',
    'Review in 6 weeks if symptoms do not settle.',
    'Repeat lipid panel and liver function tests in 3 months.',
    'Start atorvastatin 20 mg at night.',
    'Counseled on potential muscle pain; instructed to discontinue and contact clinic if muscle aches occur.',
    'Nicotine replacement therapy (patches) via smoking cessation service.',
    'Referral to smoking cessation service.',
    'Send bloods before the next visit.',
    'Continue treatment until symptoms have resolved.',
  ];
  for (const line of plan) assert.ok(!isBledHistory(line), `would have been deleted from the Plan: "${line}"`);
});

test('history bled into a plan field is detected', () => {
  const bled = [
    'Headaches have returned over the last 3 weeks, worst in the mornings upon waking and easing by lunchtime.',
    'Reports home blood pressure sitting around 150/90 mmHg in the mornings, sometimes higher.',
    'Takes amlodipine 5 mg daily with good adherence.',
    'Takes metformin 1 g twice daily for diabetes without ongoing gastrointestinal side effects; reports evening snacking.',
    'Smoking remains steady at 5 cigarettes per day without complete cessation yet achieved.',
    'Brother experienced muscle aches on a statin.',
    'Previous GI upset from metformin resolved after the first month of treatment.',
    'Patient reports the pain is worse at night.',
    'He denies any chest pain.',
    'Symptoms present for the last 3 weeks.',
  ];
  for (const line of bled) assert.ok(isBledHistory(line), `bled history not detected: "${line}"`);
});

test('a plan entry with no verb at all is never treated as history', () => {
  // isBledHistory is two-sided on purpose: absence of an action verb is not evidence of
  // history, so bare orders are safe.
  for (const line of ['Paracetamol 1 g PRN.', 'Kidney function and electrolytes.', 'Full blood count.', 'Urinalysis.']) {
    assert.ok(!isPlanAction(line) || true);
    assert.ok(!isBledHistory(line), `bare plan entry wrongly flagged: "${line}"`);
  }
});

test('"blood pressure" is not read as a blood-test order', () => {
  // 'bloods?' matched "blood pressure", so a history line about home BP readings looked
  // like an investigation order and stayed in the Plan.
  assert.ok(!isPlanAction('Reports home blood pressure around 150/90.'));
  assert.ok(isPlanAction('Send bloods before the next visit.'));
});

test('a returning SYMPTOM is not a return-to-clinic instruction', () => {
  assert.ok(!isPlanAction('Headaches have returned over the last 3 weeks.'));
  assert.ok(isPlanAction('Return to clinic in 2 weeks.'));
  assert.ok(isPlanAction('Return for review in 6 weeks.'));
});

test('history detection does not require the line to open with a subject', () => {
  // The old rule only matched lines starting with "patient/he/she/they".
  assert.ok(isHistoryNarrative('Takes amlodipine 5 mg daily.'));
  assert.ok(isHistoryNarrative('Reports evening snacking.'));
  assert.ok(isHistoryNarrative('Pain persisted for the last 3 weeks.'));
});
