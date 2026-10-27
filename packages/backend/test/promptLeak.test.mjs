import test from 'node:test';
import assert from 'node:assert/strict';
import { stripPromptLeak } from '../src/asr/promptLeak.js';
const LEAK = 'Transcribe this recorded medical consultation word for word, in English, as plain text without speaker labels. Write numbers, doses and drug names exactly as spoken. Do not summarise, correct, explain or add anything. If there is no speech, output nothing.';
test('removes the whole instruction from the middle of a transcript', () => {
  assert.equal(stripPromptLeak(`What happened? ${LEAK} The pressure is fine, 137 over 77.`), 'What happened? The pressure is fine, 137 over 77.');
});
test('removes a partial instruction and leaves clean text alone', () => {
  assert.equal(stripPromptLeak('Take one a day. If there is no speech, output nothing. Okay.'), 'Take one a day. Okay.');
  const clean = 'Transcribe is not a word the doctor said. Metformin 500 mg twice a day.';
  assert.equal(stripPromptLeak(clean), clean);
  assert.equal(stripPromptLeak(''), '');
});
