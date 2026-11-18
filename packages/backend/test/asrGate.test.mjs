import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAsrText, trimSilentTail, stockTail, verifyTail, cutSentences } from '../src/asr/asrGate.js';

const SR = 16000;
// seconds of 16-bit mono PCM: noise at `amp` (a crude stand-in for speech or for room noise)
function seg(seconds, amp) { const b = Buffer.alloc(seconds * SR * 2); for (let i = 0; i < seconds * SR; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i * 2); return b; }
const cat = (...p) => Buffer.concat(p);

test('trimSilentTail cuts a long quiet ending and keeps a pad after the last speech', () => {
  const pcm = cat(seg(30, 6000), seg(20, 40));
  const t = trimSilentTail(pcm);
  assert.ok(t.trimmedS > 15 && t.trimmedS < 19, `trimmed ${t.trimmedS}`);
  assert.ok(t.pcm.length / (SR * 2) >= 31 && t.pcm.length / (SR * 2) <= 33);
});

test('trimSilentTail keeps quiet speech (the far speaker) as speech', () => {
  const pcm = cat(seg(20, 8000), seg(15, 600), seg(2, 30));   // 600 amplitude is about -31 dBFS peak: quiet but well above the noise
  const t = trimSilentTail(pcm);
  assert.equal(t.trimmedS, 0);   // the 2 s of silence is under the 5 s threshold
  const t2 = trimSilentTail(cat(seg(20, 8000), seg(15, 600), seg(10, 30)));
  assert.ok(t2.pcm.length / (SR * 2) >= 36, 'quiet speech must not be cut');
});

test('trimSilentTail leaves a recording that ends in speech alone, and never amplifies', () => {
  const pcm = cat(seg(20, 30), seg(30, 7000));
  const t = trimSilentTail(pcm);
  assert.equal(t.trimmedS, 0);
  assert.equal(t.pcm, pcm);
});

test('trimSilentTail leaves short clips and pure silence alone', () => {
  assert.equal(trimSilentTail(seg(6, 5000)).trimmedS, 0);
  assert.equal(trimSilentTail(seg(40, 20)).trimmedS, 0);
});

test('cleanAsrText drops bare timestamps and sound words, keeps real times and speech', () => {
  assert.equal(cleanAsrText('00:00'), '');
  assert.equal(cleanAsrText('cough'), '');
  assert.equal(cleanAsrText('Okay, bye. Bye. 00:00'), 'Okay, bye. Bye.');
  assert.equal(cleanAsrText('Thank you [laughter] so much (cough)'), 'Thank you so much');
  assert.equal(cleanAsrText('I take it around 8:30-9:00 in the morning.'), 'I take it around 8:30-9:00 in the morning.');
  assert.equal(cleanAsrText('Mhm.'), 'Mhm.');
  assert.equal(cleanAsrText('I have a bad cough since Monday.'), 'I have a bad cough since Monday.');
});

test('cleanAsrText drops a stray timestamp at the start or after a finished sentence, keeps a time inside a sentence', () => {
  assert.equal(cleanAsrText('0:00 my my friend Kathy this little week.'), 'my my friend Kathy this little week.');
  assert.equal(cleanAsrText('And if you are ready, Bethel will stop by and pick it up in a day or so. 10:57'), 'And if you are ready, Bethel will stop by and pick it up in a day or so.');
  assert.equal(cleanAsrText('10:57'), '');
  assert.equal(cleanAsrText('I got up at around 10:00. Then I ate.'), 'I got up at around 10:00. Then I ate.');
  assert.equal(cleanAsrText("It's not 12:00 yet."), "It's not 12:00 yet.");
  assert.equal(cleanAsrText('The appointment is at 10:30.'), 'The appointment is at 10:30.');
});

// ── typing gate ──
import { clickRate, typingLikely, overlapShare, noiseGate } from '../src/asr/asrGate.js';
// room hush with a hard 8 ms tap every `everyMs` (a keyboard)
function typing(seconds, everyMs = 140) {
  const b = Buffer.alloc(seconds * SR * 2); for (let i = 0; i < seconds * SR; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 40), i * 2);
  for (let t = 300; t < seconds * 1000; t += everyMs + ((t / 7) % 40)) { const s0 = Math.floor(t * SR / 1000); for (let j = 0; j < 130; j++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 9000 * Math.exp(-j / 60)), (s0 + j) * 2); }
  return b;
}
// a voice stand-in: noise whose loudness swells and falls about four times a second (syllables), no hard attacks
function voice(seconds) { const b = Buffer.alloc(seconds * SR * 2); for (let i = 0; i < seconds * SR; i++) { const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * i / SR); b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 5000 * env), i * 2); } return b; }
const runner = (text) => ({ v2: async () => ({ text }) });
// loud typing (a laptop on the desk next to the microphone): the whole segment is loud enough to look like speech to a simple loudness check
function loudTyping(seconds) {
  const b = Buffer.alloc(seconds * SR * 2); for (let i = 0; i < seconds * SR; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 1300), i * 2);
  for (let t = 300; t < seconds * 1000; t += 130 + ((t / 7) % 40)) { const s0 = Math.floor(t * SR / 1000); for (let j = 0; j < 130; j++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 16000 * Math.exp(-j / 60)), (s0 + j) * 2); }
  return b;
}

import { stripVocabLeak } from '../src/asr/promptLeak.js';
import { transcribeWithChain, validateSettings, speechLike } from '../src/asr/engines.js';

test('stripVocabLeak removes the phrase-hint list Chirp writes on noise, nothing else', () => {
  const leak = 'epigastric,Pap smear,mammogram,Cipralex,melanoma,oxazepam,elbow,cephalexin,osteoporosis,letrozole,sinusitis,clonazepam,otitis,temazepam,melatonin,Zyrtec,tonsillitis,fluconazole,';
  assert.equal(stripVocabLeak(leak), '');
  assert.equal(stripVocabLeak(`Okay, so how is the cough? ${leak} Any fever?`), 'Okay, so how is the cough? Any fever?');
  assert.equal(stripVocabLeak('We talked about aspirin, statins, and a Pap smear, and the mammogram, then colonoscopy.'), 'We talked about aspirin, statins, and a Pap smear, and the mammogram, then colonoscopy.');
  assert.equal(stripVocabLeak('red,blue,green,yellow,orange,purple'), 'red,blue,green,yellow,orange,purple');   // a list with no medical words is left alone
  assert.equal(stripVocabLeak('No commas here.'), 'No commas here.');
});

test('the chain does not hand loud typing to a fallback engine when the primary heard nothing', async () => {
  const pcm = loudTyping(20); assert.equal(speechLike(pcm), true, 'the test audio must look like speech to the loudness check');
  let fallbackCalls = 0;
  const runners = { gemini: async () => ({ text: '', windows: 1, failedWindows: 0 }), v2: async () => { fallbackCalls++; return { text: 'Hello. has history of COVID', windows: 1, failedWindows: 0 }; }, v1: async () => { fallbackCalls++; return { text: 'invented', windows: 1, failedWindows: 0 }; } };
  const settings = validateSettings({ primary: 'gemini-3.5-flash', fallbacks: ['chirp_2', 'latest_long'], crossCheck: false });
  const r = await transcribeWithChain(pcm, { runners, settings });
  assert.equal(r.text, ''); assert.equal(fallbackCalls, 0);
});

test('the chain still falls back when the primary returns nothing for loud audio that is NOT typing', async () => {
  const pcm = voice(20); assert.equal(speechLike(pcm), true);
  const runners = { gemini: async () => ({ text: '', windows: 1, failedWindows: 0 }), v2: async () => ({ text: 'a real sentence from the second engine', windows: 1, failedWindows: 0 }), v1: async () => ({ text: 'x', windows: 1, failedWindows: 0 }) };
  const settings = validateSettings({ primary: 'gemini-3.5-flash', fallbacks: ['chirp_2'], crossCheck: false });
  const r = await transcribeWithChain(pcm, { runners, settings });
  assert.equal(r.text, 'a real sentence from the second engine');
});

test('the chain removes a short invented text from a typing segment, keeps it when the second engine hears it, and strips a leaked word list', async () => {
  const pcm = loudTyping(20);
  const mk = (gem, chirp) => ({ gemini: async () => ({ text: gem, windows: 1, failedWindows: 0 }), v2: async () => ({ text: chirp, windows: 1, failedWindows: 0 }), v1: async () => ({ text: '', windows: 1, failedWindows: 0 }) });
  const settings = validateSettings({ primary: 'gemini-3.5-flash', fallbacks: ['chirp_2'], crossCheck: false });
  const gone = await transcribeWithChain(pcm, { runners: mk('Hello.', ''), settings }); assert.equal(gone.text, ''); assert.equal(gone.noise.result, 'removed');
  const kept = await transcribeWithChain(pcm, { runners: mk('has history of COVID', 'she has a history of covid'), settings }); assert.equal(kept.text, 'has history of COVID');
  const leakOnly = await transcribeWithChain(pcm, { runners: { ...mk('', ''), gemini: async () => ({ text: 'epigastric,Pap smear,mammogram,Cipralex,melanoma,oxazepam,elbow,', windows: 1, failedWindows: 0 }) }, settings }); assert.equal(leakOnly.text, '');
});

test('clickRate: typing is many clicks a second, a voice is almost none, silence is none', () => {
  assert.ok(clickRate(typing(20)) > 3, `typing ${clickRate(typing(20))}`);
  assert.ok(clickRate(voice(20)) < 0.3, `voice ${clickRate(voice(20))}`);
  assert.equal(clickRate(seg(20, 30)), 0);
  assert.equal(typingLikely(typing(20)).likely, true);
  assert.equal(typingLikely(voice(20)).likely, false);
  assert.equal(typingLikely(typing(2)).likely, false);       // too short to judge
  assert.equal(typingLikely(typing(100)).likely, false);     // a whole recording is not judged this way
});

test('overlapShare: share of the first text found in the second (exact or first four letters)', () => {
  assert.equal(overlapShare('Hello.', 'hello'), 1);
  assert.ok(overlapShare('has history of COVID', 'blah blah') < 0.1);
  assert.ok(overlapShare('The blood pressure was good', 'the blood pressures were good today') >= 0.8);
  assert.equal(overlapShare('', 'anything'), 1);
});

test('noiseGate removes a short text from a typing segment when the second engine does not hear it', async () => {
  const r = await noiseGate({ text: 'has history of COVID', pcm: typing(20), runners: runner('') });
  assert.equal(r.text, ''); assert.equal(r.meta.result, 'removed');
  const r2 = await noiseGate({ text: 'Hello.', pcm: typing(20), runners: runner('I I') });
  assert.equal(r2.text, '');
});

test('noiseGate keeps real speech heard over typing, and never touches long text, voice audio, or a failed second engine', async () => {
  const said = 'This is crazy my husband will not even let me drive the car';
  const kept = await noiseGate({ text: said, pcm: typing(20), runners: runner(said.toLowerCase()) });
  assert.equal(kept.text, said); assert.equal(kept.meta.result, 'heard by a second engine');
  let called = 0; const spy = { v2: async () => { called++; return { text: '' }; } };
  const long = await noiseGate({ text: 'word '.repeat(25), pcm: typing(20), runners: spy }); assert.equal(long.text.trim().length > 0, true); assert.equal(called, 0);
  const calm = await noiseGate({ text: 'Okay, thank you.', pcm: voice(20), runners: spy }); assert.equal(calm.text, 'Okay, thank you.'); assert.equal(called, 0);
  const boom = await noiseGate({ text: 'Hello.', pcm: typing(20), runners: { v2: async () => { throw new Error('quota'); } } });
  assert.equal(boom.text, 'Hello.'); assert.match(boom.meta.result, /^unverified/);
  const none = await noiseGate({ text: 'Hello.', pcm: typing(20), runners: {} }); assert.equal(none.text, 'Hello.');
});

test('noiseGate can be switched off with ASR_NOISE_GATE=0', async () => {
  process.env.ASR_NOISE_GATE = '0';
  try { const r = await noiseGate({ text: 'Hello.', pcm: typing(20), runners: runner('') }); assert.equal(r.text, 'Hello.'); }
  finally { delete process.env.ASR_NOISE_GATE; }
});

const REAL_END = 'Okay, I will see you in three weeks. Thank you. Bye.';
const STOCK = ' I am going to give you a prescription for 20 milligrams of Prednisone. You are going to take two tablets by mouth once a day for five days. I am also going to give you an inhaler called Albuterol.';

test('stockTail finds the invented prescription ending and the drugs named', () => {
  const st = stockTail(`Cough since Monday. ${REAL_END}${STOCK}`);
  assert.ok(st);
  assert.deepEqual(st.drugs.sort(), ['albuterol', 'prednisone']);
  assert.equal(st.drop.length, 3);
});

test('stockTail ignores an ordinary "I will give you a prescription" in the middle of a visit and a sentence with no drug', () => {
  const mid = `I'm going to give you a prescription for the cream. ${'We talked about many things at length. '.repeat(30)}Bye.`;
  assert.equal(stockTail(mid), null);   // too far from the end
  const st = stockTail('Everything looks fine. I am going to give you a prescription for that.');
  assert.deepEqual(st.drugs, []);
});

test('cutSentences removes only the statement', () => {
  const t = `Cough since Monday. ${REAL_END}${STOCK}`; const st = stockTail(t);
  assert.equal(cutSentences(t, st.sents, st.drop), `Cough since Monday. ${REAL_END}`);
});

const pcm = seg(100, 5000);
test('verifyTail cuts the ending when the second engine does not hear the drug', async () => {
  const runners = { v2: async () => ({ text: 'Okay I will see you in three weeks. Thank you. Bye.' }) };
  const r = await verifyTail({ text: `Cough since Monday. ${REAL_END}${STOCK}`, pcm, runners });
  assert.equal(r.text, `Cough since Monday. ${REAL_END}`);
  assert.equal(r.meta.result, 'cut');
});

test('verifyTail keeps the statement when the second engine hears the drug', async () => {
  const runners = { v2: async () => ({ text: 'I am writing you a prescription for prednisone, take it for five days.' }) };
  const t = `Cough since Monday. ${REAL_END}${STOCK}`;
  const r = await verifyTail({ text: t, pcm, runners });
  assert.equal(r.text, t);
  assert.match(r.meta.result, /confirmed/);
});

test('verifyTail never deletes when the second engine fails, times out or hears nothing', async () => {
  const t = `Cough since Monday. ${REAL_END}${STOCK}`;
  for (const run of [async () => { throw new Error('boom'); }, async () => ({ text: '' }), () => new Promise(() => {})]) {
    const r = await verifyTail({ text: t, pcm, runners: { v2: run }, timeoutMs: 50 });
    assert.equal(r.text, t); assert.match(r.meta.result, /unverified/);
  }
});

test('verifyTail does nothing and costs nothing on a transcript with no such ending', async () => {
  let calls = 0;
  const r = await verifyTail({ text: 'Cough since Monday. Okay, see you in three weeks.', pcm, runners: { v2: async () => { calls++; return { text: 'x' }; } } });
  assert.equal(calls, 0); assert.equal(r.meta.checked, false);
});
