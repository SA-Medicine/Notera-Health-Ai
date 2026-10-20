import test from 'node:test';
import assert from 'node:assert/strict';
import { countWords, wordsPerMinute, looksIncomplete, worthReplacing, MIN_SECONDS, LOW_WPM } from '../../../apps/web/app/(app)/app/transcriptDensity.ts';

test('words are counted the same way the checker reasons about them', () => { assert.equal(countWords("Doctor: I've had pain for 3 weeks, okay?"), 8); assert.equal(countWords(''), 0); });
test('the completeness check: the 12.7-minute consult that stored 44 words a minute is flagged; normal consults are not', () => {
  assert.equal(looksIncomplete(555, 12.7 * 60), true, 'the real under-transcribed consult');
  for (const [words, minutes] of [[1167, 11.1], [421, 3.8], [861, 7.7], [750, 5.2], [334, 2.1]]) assert.equal(looksIncomplete(words, minutes * 60), false, `${words} words in ${minutes} min is normal speech density`);
});
test('short recordings are never judged (a quick renewal can be mostly silence)', () => { assert.equal(looksIncomplete(10, MIN_SECONDS - 1), false); assert.equal(looksIncomplete(10, MIN_SECONDS), true); assert.ok(LOW_WPM >= 60 && LOW_WPM <= 90); assert.equal(Math.round(wordsPerMinute(555, 762)), 44); });
test('a re-transcript replaces the old one only when it holds clearly more speech', () => {
  assert.equal(worthReplacing(555, 1093), true); assert.equal(worthReplacing(555, 600), false, 'about the same: keep the original'); assert.equal(worthReplacing(555, 635), false); assert.equal(worthReplacing(555, 640), true); assert.equal(worthReplacing(0, 10), false, 'too little to matter');
});
