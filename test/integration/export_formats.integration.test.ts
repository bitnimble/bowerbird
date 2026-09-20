// The export encoders across the FFI (DESIGN §10.5.1).
//
// Each encoder is pinned in Rust against its own synthetic frame; what is only reachable from
// here is the seam - the format name, the argument order, and that a distance reaches libjxl as
// a float rather than as whatever the next parameter happened to be. A wrong name returns -1 and
// throws, and a wrong order writes a file that is not the format asked for, so the magic bytes
// are the assertion.
//
//   docker exec bowerbird-dev bun test test/integration/export_formats
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportStill } from '../../src/services/processing/rawshim/rawshim_job';
import { _for_testing_encodeHdr } from '../../src/services/processing/rawshim/rawshim_for_testing';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

function rendered(directory: string): string {
  const out = path.join(directory, 'render.avif');
  _for_testing_encodeHdr(
    FIXTURE,
    {
      outputPath: out,
      peakNits: 1000,
      referenceWhiteNits: 203,
      whiteQuantile: 0.999,
      crf: 20,
      preset: 8,
      maxEdge: 512,
    },
    { decodeSize: 1024 },
  );
  return out;
}

// A codestream begins `FF 0A` bare, or with the ISOBMFF signature box in a container.
function isJxl(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 12));
  return head.subarray(0, 2).equals(Buffer.from([0xff, 0x0a])) || head.subarray(0, 8).equals(Buffer.from('\0\0\0\x0cJXL ', 'binary'));
}

for (const format of ['jxl', 'jxl-hdr'] as const) {
  test(`an export writes ${format}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'bb-export-'));
    try {
      const file = exportStill(rendered(directory), format, 1.5);
      expect(isJxl(file)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
}

// Distance is the one argument that would be silently ignored rather than refused: a JXL written
// at whatever libjxl defaults to is a valid file, and only its size says the number never arrived.
test('a JXL export spends the distance it was given', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bb-export-'));
  try {
    const source = rendered(directory);
    const coarse = exportStill(source, 'jxl', 6);
    const fine = exportStill(source, 'jxl', 0.5);
    expect(fine.byteLength).toBeGreaterThan(coarse.byteLength);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
