import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { avifToMp4 } from '../src/index';

// 64x64, 10-bit 4:2:0, tagged BT.2020 + PQ, from `avifenc --cicp 9/16/9`. Small enough
// to read by hand and structurally identical to a 24MP one.
const still = new Uint8Array(readFileSync(new URL('./still.avif', import.meta.url)));

test('the configuration record carries the sequence header, which the AVIF does not', () => {
  // The failure this guards is silent: an av1C with no configuration OBUs still plays,
  // and the frame still decodes - it just reaches the compositor with no colour
  // description, which is the whole difference between HDR and a flat picture. The
  // AVIF's own record is the four bytes below and nothing else, because AVIF leaves the
  // sequence header in the item data.
  const record = find(avifToMp4(still), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'av01', 'av1C']);
  expect(record.length).toBeGreaterThan(4);
  expect(record[0]).toBe(0x81); // marker and version 1
  // An OBU header: type in bits 3-6, and 1 is a sequence header.
  expect(((record[4] ?? 0) >> 3) & 0xf).toBe(1);
});

test("the sample is the still's own frame, less the temporal delimiter", () => {
  const frame = itemData(still);
  const sample = find(avifToMp4(still), ['mdat']);
  // An MP4 sample may not hold a temporal delimiter and AVIF item data opens with one,
  // so the sample is the rest of the frame exactly.
  expect(frame.subarray(0, 2)).toEqual(new Uint8Array([0x12, 0x00]));
  expect(sample).toEqual(frame.subarray(2));
});

test('the sample table points at the sample', () => {
  // `stco` is an absolute file offset written before the box holding it has been laid
  // out, so it is the one number here that a plausible-looking layout can get wrong.
  const mp4 = avifToMp4(still);
  const stco = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
  const at = new DataView(stco.buffer, stco.byteOffset, stco.byteLength).getUint32(8);
  expect(mp4.subarray(at, at + 4)).toEqual(find(mp4, ['mdat']).subarray(0, 4));

  const stsz = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
  const size = new DataView(stsz.buffer, stsz.byteOffset, stsz.byteLength).getUint32(4);
  expect(size).toBe(find(mp4, ['mdat']).length);
});

test('the colour signalling comes across', () => {
  // Without it the video is BT.709 by default and Firefox composites it SDR, which is
  // the state this whole package exists to get out of.
  const colr = find(avifToMp4(still), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'av01', 'colr']);
  const view = new DataView(colr.buffer, colr.byteOffset, colr.byteLength);
  expect(String.fromCharCode(...colr.subarray(0, 4))).toBe('nclx');
  expect(view.getUint16(4)).toBe(9); // BT.2020 primaries
  expect(view.getUint16(6)).toBe(16); // PQ
  expect(view.getUint16(8)).toBe(9); // BT.2020 non-constant luminance
});

test('the picture keeps its size', () => {
  const entry = find(avifToMp4(still), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'av01']);
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  expect([view.getUint16(24), view.getUint16(26)]).toEqual([64, 64]);
});

test('something that is not an AVIF is refused rather than half-read', () => {
  expect(() => avifToMp4(new Uint8Array(64))).toThrow();
  expect(() => avifToMp4(still.subarray(0, 40))).toThrow();
});

// A box walker of its own, rather than the one under test: a parser that agrees with
// itself proves nothing.

/** What sits between a box's payload and the child boxes inside it. */
const FIXED_FIELDS: Record<string, number> = {
  // A version, flags and an entry count.
  stsd: 8,
  // A VisualSampleEntry's fixed fields.
  av01: 78,
};

/** The payload of a box, by the path of types leading to it. */
function find(bytes: Uint8Array, path: string[]): Uint8Array {
  let [start, end] = [0, bytes.length];
  for (const [depth, type] of path.entries()) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = start;
    let found: [number, number] | null = null;
    while (at + 8 <= end) {
      const size = view.getUint32(at);
      if (size < 8) throw new Error(`a box at ${at} claims ${size} bytes`);
      if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === type) {
        found = [at + 8, at + size];
        break;
      }
      at += size;
    }
    if (found == null) throw new Error(`no ${path.slice(0, depth + 1).join('/')} in the file`);
    [start, end] = depth === path.length - 1 ? found : [found[0] + (FIXED_FIELDS[type] ?? 0), found[1]];
  }
  return bytes.subarray(start, end);
}

/**
 * The primary item's bytes, read straight out of `mdat`.
 *
 * The fixture has one item, so the whole payload is the frame and no `iloc` walk is
 * needed to say so.
 */
function itemData(avif: Uint8Array): Uint8Array {
  return find(avif, ['mdat']);
}
