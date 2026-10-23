// A finished recording must be a playable file before it is uploaded. MediaRecorder hands over the audio in one-second pieces; only the FIRST piece
// carries the file header. A stray piece from an earlier recorder in front of it made six stored recordings unplayable (one extra second, 16 439
// bytes, then the real header and a perfectly good recording). This keeps each recorder's pieces apart, and before upload cuts anything in front of
// the header and refuses a file that has none.

const EBML = [0x1a, 0x45, 0xdf, 0xa3];   // WebM / Matroska
const SCAN = 512 * 1024;                  // a stray piece is one second, ~16 KB; look this far for the real header

const at = (b: Uint8Array, i: number, sig: number[]) => sig.every((v, k) => b[i + k] === v);
const ascii = (b: Uint8Array, i: number, s: string) => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0));

/** Where the file really begins, or -1 when no known audio header is found. 0 = already fine. */
export function headerOffset(head: Uint8Array): number {
  if (head.length >= 4 && at(head, 0, EBML)) return 0;
  if (head.length >= 8 && ascii(head, 4, 'ftyp')) return 0;   // MP4 / M4A (Safari)
  if (head.length >= 4 && (ascii(head, 0, 'OggS') || ascii(head, 0, 'RIFF'))) return 0;
  for (let i = 1; i + 4 <= head.length; i++) if (at(head, i, EBML)) return i;
  return -1;
}

export type Sealed = { blob: Blob | null; trimmed: number; ok: boolean };

/** Join one recorder's pieces into the file to keep. `ok:false` = no audio header anywhere near the start: do not upload it. */
export async function sealRecording(chunks: Blob[], mime: string): Promise<Sealed> {
  if (!chunks.length) return { blob: null, trimmed: 0, ok: false };
  const whole = new Blob(chunks, { type: mime });
  const head = new Uint8Array(await whole.slice(0, Math.min(SCAN, whole.size)).arrayBuffer());
  const off = headerOffset(head);
  if (off < 0) return { blob: whole, trimmed: 0, ok: false };
  return { blob: off === 0 ? whole : whole.slice(off, whole.size, mime), trimmed: off, ok: true };
}
