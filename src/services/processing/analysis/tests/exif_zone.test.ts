import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCaptureOffset, readCaptureOffset } from '../exif_zone';

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

// A CR3's shape around the tags: `moov` → `uuid` (16 bytes of identifier first)
// → `CMT1`, then `CMT2` holding the Exif IFD as a TIFF of its own. The real files
// nest exactly this way; the box sizes here are the only thing scaled down.
function cr3(exif: Uint8Array, { cmt2 = true }: { cmt2?: boolean } = {}): Uint8Array {
  const ident = new Uint8Array(16).fill(0xa5);
  const cmt1 = box('CMT1', new Uint8Array(8)); // IFD0, and not where the tags are
  const inner = box(cmt2 ? 'CMT2' : 'CMT3', exif);
  const uuid = box('uuid', concat(ident, cmt1, inner));
  return concat(box('ftyp', new Uint8Array([0x63, 0x72, 0x78, 0x20])), box('moov', uuid));
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
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

  it('reaches the Exif block of a CR3, which is not a TIFF at all', () => {
    expect(parseCaptureOffset(cr3(tiff()))).toBe('+11:00');
    expect(parseCaptureOffset(cr3(tiff({ value: '-08:00' })))).toBe('-08:00');
  });

  it('answers null when the box tree holds no Exif block', () => {
    // CMT3 is Canon's own makernote, not the Exif IFD: finding a TIFF in the tree
    // is not enough, it has to be the right box.
    expect(parseCaptureOffset(cr3(tiff(), { cmt2: false }))).toBeNull();
  });

  it("reaches a JPEG's APP1 segment, which holds the same TIFF behind a marker", () => {
    expect(parseCaptureOffset(jpeg(tiff()))).toBe('+11:00');
    // A JPEG with no APP1 at all: the walk stops at the first scan rather than reading into
    // the entropy-coded data and finding a TIFF magic by accident.
    expect(parseCaptureOffset(jpeg(null))).toBeNull();
  });

  it("reaches a PNG's eXIf chunk", () => {
    expect(parseCaptureOffset(png(tiff({ value: '-08:00' })))).toBe('-08:00');
    expect(parseCaptureOffset(png(null))).toBeNull();
  });
});

/// A JPEG's header segments, with the Exif block in an APP1 where a camera writes it.
function jpeg(exif: Uint8Array | null): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (exif != null) {
    const body = concat(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), exif);
    const header = new Uint8Array(4);
    header.set([0xff, 0xe1]);
    new DataView(header.buffer).setUint16(2, body.length + 2, false);
    parts.push(header, body);
  }
  // A start-of-scan and a byte of "image", so the walk has an end to find.
  parts.push(new Uint8Array([0xff, 0xda, 0x00, 0x02, 0x00]));
  return concat(...parts);
}

/// A PNG's chunks, with the Exif block in the `eXIf` chunk the spec puts it in.
function png(exif: Uint8Array | null): Uint8Array {
  const chunk = (type: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, payload.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out; // the CRC is never checked by the walk, so it is left zero
  };
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', new Uint8Array(13)),
  ];
  if (exif != null) parts.push(chunk('eXIf', exif));
  parts.push(chunk('IDAT', new Uint8Array(4)), chunk('IEND', new Uint8Array(0)));
  return concat(...parts);
}

describe('readCaptureOffset', () => {
  it('reads the header off disk, and answers null rather than throwing when it cannot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-exif-'));
    try {
      // Well under the read window, so the short-file path is what runs here.
      const raw = path.join(dir, 'a.arw');
      writeFileSync(raw, tiff());
      expect(await readCaptureOffset(raw)).toBe('+11:00');

      expect(await readCaptureOffset(path.join(dir, 'gone.arw'))).toBeNull();
      writeFileSync(path.join(dir, 'empty.arw'), '');
      expect(await readCaptureOffset(path.join(dir, 'empty.arw'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
