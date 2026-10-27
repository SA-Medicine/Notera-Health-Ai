// A small streaming ZIP writer ("stored", no compression: the recordings are already compressed). Entries are written one after another with a data descriptor, so a file never has to
// be held in memory; the central directory is written at the end. Plain ZIP (not zip64): fine below 4 GB per file and in total.
'use strict';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (buf, crc = 0) => { let c = (crc ^ 0xffffffff) >>> 0; for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function dosTime(d) { return { time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff }; }

/** @param write function(Buffer) that sends bytes (awaitable) */
export function zipWriter(write) {
  const entries = []; let offset = 0;
  const out = async (b) => { offset += b.length; await write(b); };
  return {
    /** chunks: async iterable of Buffers */
    async add(name, chunks, when = new Date()) {
      const nameBuf = Buffer.from(name, 'utf8'); const { time, date } = dosTime(when); const start = offset;
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt16LE(nameBuf.length, 26);
      await out(Buffer.concat([lh, nameBuf]));
      let crc = 0, size = 0;
      for await (const c of chunks) { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); crc = crc32(b, crc); size += b.length; await out(b); }
      const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12); await out(dd);
      entries.push({ nameBuf, crc, size, start, time, date });
    },
    async finish() {
      const cdStart = offset;
      for (const e of entries) {
        const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14);
        h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.size, 20); h.writeUInt32LE(e.size, 24); h.writeUInt16LE(e.nameBuf.length, 28); h.writeUInt32LE(e.start, 42);
        await out(Buffer.concat([h, e.nameBuf]));
      }
      const cdSize = offset - cdStart; const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
      await out(end); return entries.length;
    },
  };
}
