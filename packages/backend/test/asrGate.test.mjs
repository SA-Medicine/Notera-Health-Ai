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
