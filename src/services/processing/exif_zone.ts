import { open } from 'node:fs/promises';

// EXIF 2.31 (2016) added the tags that say what zone a capture time was written
// in. LibRaw exposes none of them - it hands back a `time_t` and nothing else
// (DESIGN §11.1) - so they are read here, straight out of the TIFF header the
// RAW already is. Bodies older than the spec write no offset at all, which is
// why the result is nullable rather than a default of UTC.
const OFFSET_TIME_ORIGINAL = 0x9011;
const OFFSET_TIME = 0x9010;
const EXIF_IFD_POINTER = 0x8769;
const ASCII = 2;

// The header, not the file: a RAW is 25MB of sensor data behind a few KB of
// tags, and every offset that matters points inside the first chunk. A pointer
// past the window reads as "not recorded", which is the same answer as a body
// that never wrote one.
const WINDOW_BYTES = 256 * 1024;

// "+11:00" or "-08:00". Anything else is a camera writing junk into the tag,
// which is likelier than it sounds: the field is blank-filled ("      ") on some
// bodies when the clock has no zone set.
const OFFSET = /^[+-]\d{2}:\d{2}$/;

function ascii(view: DataView, at: number, count: number): string {
  let out = '';
  for (let i = 0; i < count && at + i < view.byteLength; i++) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

// Both offset tags, so a body that writes only the generic one is still read.
// OffsetTimeOriginal wins: it is the one that belongs to DateTimeOriginal, which
// is the timestamp `date_taken` comes from.
function readIfd(view: DataView, little: boolean, ifdAt: number, depth: number): string | null {
  if (depth > 4 || ifdAt <= 0 || ifdAt + 2 > view.byteLength) return null;
  const entries = view.getUint16(ifdAt, little);
  let fallback: string | null = null;

  for (let i = 0; i < entries; i++) {
    const entry = ifdAt + 2 + i * 12;
    if (entry + 12 > view.byteLength) return fallback;
    const tag = view.getUint16(entry, little);

    if (tag === EXIF_IFD_POINTER) {
      const nested = readIfd(view, little, view.getUint32(entry + 8, little), depth + 1);
      if (nested != null) return nested;
      continue;
    }
    if (tag !== OFFSET_TIME_ORIGINAL && tag !== OFFSET_TIME) continue;
    if (view.getUint16(entry + 2, little) !== ASCII) continue;

    const count = view.getUint32(entry + 4, little);
    // A value of four bytes or fewer sits in the entry itself; anything longer
    // is a pointer. An offset is seven with its terminator, so it is always a
    // pointer in practice - but the rule is the format's, not this tag's.
    const at = count <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    const value = ascii(view, at, count).trim();
    if (!OFFSET.test(value)) continue;
    if (tag === OFFSET_TIME_ORIGINAL) return value;
    fallback = value;
  }
  return fallback;
}

// Exported for tests: the file read is the only part that needs a disk.
export function parseCaptureOffset(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) return null; // not a TIFF, so not a RAW we can read
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) return null;
  return readIfd(view, little, view.getUint32(4, little), 0);
}

// The camera's UTC offset for this frame, as EXIF wrote it, or null when the
// body recorded none.
export async function readCaptureOffset(filePath: string): Promise<string | null> {
  const file = await open(filePath, 'r');
  try {
    const bytes = new Uint8Array(WINDOW_BYTES);
    const { bytesRead } = await file.read(bytes, 0, WINDOW_BYTES, 0);
    return parseCaptureOffset(bytes.subarray(0, bytesRead));
  } catch {
    return null; // an unreadable header is not a reason to fail the whole scan
  } finally {
    await file.close();
  }
}
