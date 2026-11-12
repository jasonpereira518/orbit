/**
 * A JPEG's pixel size, read from its start-of-frame (SOF) marker in plain JS.
 *
 * Not sharp: sharp is bundled only into `/api/avatars/encode` on Vercel (see
 * `src/lib/avatar-encode.ts`), so anything that runs elsewhere has to read the header itself.
 * Walks the marker segments from the start of the file and stops at the first frame header,
 * so a prefix of the file is enough: the SOF of an encoder's output is within the first few
 * hundred bytes, after any EXIF/ICC segments that precede it.
 *
 * Null when the bytes are not a JPEG, the header is cut off before the frame, or the stream
 * is malformed. Callers treat null as "cannot say", never as a size.
 */
export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null; // lost sync: not a marker where one must be
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte before a marker
      continue;
    }
    // Markers with no length field: SOI, TEM, RSTn.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // End of image / start of scan with no frame header before it.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}
