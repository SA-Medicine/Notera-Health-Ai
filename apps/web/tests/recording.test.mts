// Run: node apps/web/tests/recording.test.mts
import assert from 'node:assert/strict';
import { headerOffset, sealRecording } from '../app/(app)/app/recording.ts';

const bytes = (...n: number[]) => new Uint8Array(n);
const HDR = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01);
const stray = new Uint8Array(16439).fill(0x55); stray[0] = 0x43; stray[1] = 0xb6; stray[2] = 0x75; stray[16438] = 0x1f;   // what the six damaged files started with

assert.equal(headerOffset(HDR), 0, 'a file that starts with the header is fine');
assert.equal(headerOffset(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70)), 0, 'an MP4 recording (Safari) is fine');
assert.equal(headerOffset(bytes(0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0)), 0, 'Ogg is fine');
assert.equal(headerOffset(new Uint8Array(100).fill(7)), -1, 'no header at all');
const glued = new Uint8Array(stray.length + HDR.length); glued.set(stray); glued.set(HDR, stray.length);
assert.equal(headerOffset(glued), 16439, 'one stray second in front: the real file starts at the header');

// good recording: nothing changes
let s = await sealRecording([new Blob([HDR]), new Blob([bytes(1, 2, 3)])], 'audio/webm');
assert.deepEqual([s.ok, s.trimmed, s.blob?.size], [true, 0, HDR.length + 3]);
// the damaged shape: the stray piece arrived first, then the real first piece
s = await sealRecording([new Blob([stray]), new Blob([HDR]), new Blob([bytes(1, 2, 3)])], 'audio/webm');
assert.deepEqual([s.ok, s.trimmed, s.blob?.size, s.blob?.type], [true, 16439, HDR.length + 3, 'audio/webm']);
assert.deepEqual([...new Uint8Array(await s.blob!.slice(0, 4).arrayBuffer())], [0x1a, 0x45, 0xdf, 0xa3]);
// nothing usable: not uploaded
s = await sealRecording([new Blob([new Uint8Array(500).fill(9)])], 'audio/webm'); assert.equal(s.ok, false);
s = await sealRecording([], 'audio/webm'); assert.deepEqual([s.ok, s.blob], [false, null]);
console.log('recording.test.mts: ok');
