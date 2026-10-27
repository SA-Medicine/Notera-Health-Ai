import test from 'node:test';
import assert from 'node:assert/strict';
import { zipWriter, crc32 } from '../src/admin/zipStream.js';

test('crc32 of "123456789" is cbf43926', () => assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926'));

test('writes a readable zip: end record, central directory, names, sizes and checksums', async () => {
  const parts = []; const z = zipWriter(async (b) => { parts.push(b); });
  async function* gen(...bs) { for (const b of bs) yield Buffer.from(b); }
  await z.add('a.webm', gen('hello ', 'world'));
  await z.add('b/ü.webm', gen('xyz'));
  assert.equal(await z.finish(), 2);
  const zip = Buffer.concat(parts); const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50); assert.equal(zip.readUInt16LE(eocd + 10), 2);
  let p = zip.readUInt32LE(eocd + 16); const seen = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const crc = zip.readUInt32LE(p + 16), size = zip.readUInt32LE(p + 20), nl = zip.readUInt16LE(p + 28), lo = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nl).toString('utf8');
    assert.equal(zip.readUInt32LE(lo), 0x04034b50);
    const data = zip.subarray(lo + 30 + zip.readUInt16LE(lo + 26), lo + 30 + zip.readUInt16LE(lo + 26) + size);
    assert.equal(crc32(data), crc); seen.push([name, data.toString()]); p += 46 + nl;
  }
  assert.deepEqual(seen, [['a.webm', 'hello world'], ['b/ü.webm', 'xyz']]);
});
