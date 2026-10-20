// Is the transcript far too short for the recording? Conversation runs at roughly 100–160 words a minute (measured on real consults: 105–161);
// one real 12.7-minute consult came back at 44. Below this level the app offers to re-transcribe from the saved recording.
// Pure functions with no browser dependencies, so they are unit-tested from the backend test suite.

export const MIN_SECONDS = 120;        // shorter recordings vary too much (a quick renewal can be mostly silence)
export const LOW_WPM = 75;             // under this many words a minute the transcript looks incomplete
export const MIN_GAIN = 1.15;          // after a re-transcribe the new text must hold at least 15 % more words to replace the old one

export function countWords(text: string): number {
  return (String(text || '').toLowerCase().match(/[a-z0-9']+/g) || []).length;
}

export function wordsPerMinute(words: number, seconds: number): number {
  return seconds > 0 ? words / (seconds / 60) : 0;
}

/** True when the recording is long enough to judge and the transcript is below normal speech density. */
export function looksIncomplete(words: number, seconds: number): boolean {
  return seconds >= MIN_SECONDS && wordsPerMinute(words, seconds) < LOW_WPM;
}

/** Keep the new transcript only when it clearly holds more speech than the old one. */
export function worthReplacing(oldWords: number, newWords: number): boolean {
  return newWords >= Math.max(20, oldWords * MIN_GAIN);
}
