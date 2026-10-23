import test from 'node:test';
import assert from 'node:assert/strict';
import { overlapWindows, keepWordsByTime, mergeOverlapText, offsetSeconds, planWindows, _BYTES_PER_SECOND as BPS } from '../src/asr/googleSpeech.js';
import { medicalPhrases, MEDICAL_TERMS } from '../src/asr/medicalVocab.js';
import { reconcile, shouldSwap, alignTokens } from '../src/asr/consensus.js';

test('overlap windows hear their neighbours but keep their own span; the first and last windows are not widened outward', () => {
  const sec = (s) => s * BPS; const base = [{ start: 0, end: sec(50) }, { start: sec(50), end: sec(100) }, { start: sec(100), end: sec(120) }];
  const w = overlapWindows(base, sec(120), 3);
  assert.deepEqual(w.map((x) => [x.start / BPS, x.end / BPS]), [[0, 53], [47, 103], [97, 120]]);
  assert.deepEqual(w.map((x) => [x.keepFrom / BPS, x.keepTo / BPS]), [[0, 50], [50, 100], [100, 120]]);
  assert.ok(w.every((x) => (x.end - x.start) / BPS <= 58), 'a window stays under the 60 s synchronous limit');
  assert.equal(overlapWindows(base, sec(120), 0)[1].start, sec(50));
});
test('every word is kept by exactly one window: the one whose span holds its start time', () => {
  const words = (list) => [{ alternatives: [{ words: list.map(([word, s]) => ({ word, startOffset: { seconds: Math.floor(s), nanos: (s % 1) * 1e9 } })) }] }];
  // window 2 starts at 47 s (own span 50-100); it hears "any signs of" at 48-49.9 (before its span) and "concern" at 50.2
  const w2 = keepWordsByTime(words([['any', 1.0], ['signs', 2.0], ['of', 2.8], ['concern', 3.2], ['that', 4.0]]), { winStartSec: 47, keepFromSec: 50, keepToSec: 100 });
  assert.equal(w2.text, 'concern that'); assert.ok(w2.hadWords);
  const w1 = keepWordsByTime(words([['so', 45.0], ['any', 48.0], ['signs', 49.0], ['of', 49.8], ['concern', 50.2]]), { winStartSec: 0, keepFromSec: -1, keepToSec: 50 });
  assert.equal(w1.text, 'so any signs of');   // "concern" starts after the cut and belongs to the next window: nothing lost, nothing twice
  assert.equal(keepWordsByTime([{ alternatives: [{ transcript: 'plain text' }] }], { winStartSec: 0, keepFromSec: 0, keepToSec: 10 }).hadWords, false);
  assert.equal(offsetSeconds('1.5s'), 1.5); assert.equal(offsetSeconds({ seconds: '2', nanos: 5e8 }), 2.5); assert.ok(Number.isNaN(offsetSeconds(undefined)));
});
test('overlap merged by text when no word times come back', () => {
  assert.equal(mergeOverlapText('we talked about the swelling in', 'about the swelling in your ankles'), 'we talked about the swelling in your ankles');
  assert.equal(mergeOverlapText('one two', 'three four'), 'one two three four');   // no overlap found: plain join, nothing dropped
});
test('the vocabulary holds the words the comparison got wrong, within the phrase limit', () => {
  const p = medicalPhrases(); assert.ok(p.length > 200 && p.length <= 700); assert.ok(p.every((x) => x.value && x.boost >= 0 && x.boost <= 20));
  for (const w of ['calf', 'ankles', 'lightheadedness', 'palpitations', 'estrogel', 'prometrium', 'progesterone', 'testosterone']) assert.ok(MEDICAL_TERMS.has(w), w);
  assert.equal(medicalPhrases({ boost: 4 })[0].boost, 4); assert.equal(new Set(p.map((x) => x.value.toLowerCase())).size, p.length);
});
test('a medical word one engine heard replaces a look-alike ordinary word; ordinary speech is never rewritten', () => {
  const chirp = 'If you have class tenderness that is the bad sign. Then I notice my uncle sometimes swells and I felt lightheaded.';
  const gem = 'If you have calf tenderness that is the bad sign. Then I notice my ankles sometimes swell and I felt lightheaded.';
  const r = reconcile(chirp, gem);
  assert.match(r.text, /calf tenderness/); assert.match(r.text, /my ankles sometimes swells/); assert.deepEqual(r.swaps.map((s) => s.to), ['calf', 'ankles']);
  assert.match(r.text, /^If you have calf tenderness that is the bad sign\./);   // punctuation and capital letters of the original are kept
  assert.equal(reconcile('I take the pill daily', 'I take a pill daily').text, 'I take the pill daily');   // "the" -> "a": neither is medical
  assert.equal(shouldSwap('the', 'thigh'), false); assert.equal(shouldSwap('zzz', 'calf'), false);   // a function word or an unrelated sound never swaps
  assert.equal(shouldSwap('class', 'calf'), true); assert.equal(shouldSwap('calf', 'calves'), false);   // the first is already a medical word
});
test('a sentence only the other engine heard is added; a short disagreement is not', () => {
  const chirp = 'Why do you not continue and if still concerned come and see me in person';
  const gem = 'Why do you not continue and any signs of concern that I should be watching for and if still concerned come and see me in person';
  const r = reconcile(chirp, gem); assert.match(r.text, /signs of concern that I should be watching for/); assert.match(r.text, /come and see me in person$/); assert.equal(r.fills.length, 1); assert.ok(r.fills[0] >= 10);
  assert.deepEqual(reconcile('see me in person soon', 'see me in person very soon').fills, []);
  assert.equal(reconcile('', 'x y z').text, ''); assert.equal(reconcile('only primary here', '').text, 'only primary here');
});
test('alignment pairs equal words and marks the rest', () => {
  assert.deepEqual(alignTokens(['a', 'b', 'c'], ['a', 'x', 'c']).map((o) => o[0]), ['m', 's', 'm']);
  assert.deepEqual(alignTokens(['a', 'c'], ['a', 'b', 'c']).map((o) => o[0]), ['m', 'i', 'm']);
});
test('windows still tile the audio with no overlap in the plan itself (the overlap is added on top)', () => {
  const pcm = Buffer.alloc(130 * BPS); const plan = planWindows(pcm, {});
  assert.equal(plan[0].start, 0); assert.equal(plan.at(-1).end, pcm.length); for (let i = 1; i < plan.length; i++) assert.equal(plan[i].start, plan[i - 1].end);
});
