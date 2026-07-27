import { describe, it, expect } from 'bun:test';
import { parseCaptureOffset } from '../exif_zone';

// A TIFF header with one IFD0 entry pointing at an Exif IFD, which holds the
// offset tags. Built rather than read from a file: the fixture RAW is from a
// 2016 body that predates the tags, and the shape is what is being tested.
function tiff({
  little = true,
  tag = 0x9011,
  value = '+11:00',
  type = 2,
  nested = true,
}: { little?: boolean; tag?: number; value?: string; type?: number; nested?: boolean } = {}): Uint8Array {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, little ? 0x4949 : 0x4d4d, false);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little); // IFD0 at byte 8

  const valueAt = 200;
  for (let i = 0; i < value.length; i++) bytes[valueAt + i] = value.charCodeAt(i);

  const entry = (at: number, id: number, entryType: number, count: number, payload: number): void => {
    view.setUint16(at, id, little);
    view.setUint16(at + 2, entryType, little);
    view.setUint32(at + 4, count, little);
    view.setUint32(at + 8, payload, little);
  };

  if (nested) {
    view.setUint16(8, 1, little); // IFD0: one entry, the Exif pointer
    entry(10, 0x8769, 4, 1, 30);
    view.setUint32(22, 0, little); // no next IFD
    view.setUint16(30, 1, little); // Exif IFD: one entry, the offset tag
    entry(32, tag, type, value.length + 1, valueAt);
    view.setUint32(44, 0, little);
  } else {
    view.setUint16(8, 1, little);
    entry(10, tag, type, value.length + 1, valueAt);
    view.setUint32(22, 0, little);
  }
  return bytes;
}

describe('parseCaptureOffset', () => {
  it('reads OffsetTimeOriginal out of the Exif IFD, either byte order', () => {
    expect(parseCaptureOffset(tiff())).toBe('+11:00');
    expect(parseCaptureOffset(tiff({ little: false }))).toBe('+11:00');
    expect(parseCaptureOffset(tiff({ value: '-08:00' }))).toBe('-08:00');
  });

  it('falls back to OffsetTime for a body that writes only that one', () => {
    expect(parseCaptureOffset(tiff({ tag: 0x9010 }))).toBe('+11:00');
  });

  it('ignores a tag the camera left blank or filled with junk', () => {
    // Sony writes spaces when the body's clock has no zone set, which is not the
    // same as UTC and must not be read as +00:00.
    expect(parseCaptureOffset(tiff({ value: '      ' }))).toBeNull();
    expect(parseCaptureOffset(tiff({ value: '+1100' }))).toBeNull();
    expect(parseCaptureOffset(tiff({ type: 3 }))).toBeNull(); // SHORT, not ASCII
  });

  it('returns null for anything that is not a TIFF header', () => {
    expect(parseCaptureOffset(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0]))).toBeNull();
    expect(parseCaptureOffset(new Uint8Array(4))).toBeNull();
  });

  it('reads a tag written straight into IFD0, without an Exif pointer', () => {
    expect(parseCaptureOffset(tiff({ nested: false }))).toBe('+11:00');
  });
});
