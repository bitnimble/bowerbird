import { describe, it, expect } from 'bun:test';
import { framePrepared, type PreparedFrame, type PreparedHeader } from '../rawshim_edit';

// A matched frame's description, at the shape the fitter actually produces: three
// `BINS`-sample curves and a 5x5x4 lattice of four-component nodes. The size is the point
// of these tests, so it is built to size rather than mocked small.
function prepared(matched: boolean, pixels = 4): PreparedFrame {
  const ramp = (n: number): number[] => Array.from({ length: n }, (_, i) => i / n + 0.123456789);
  const header: PreparedHeader = {
    ok: true,
    width: pixels,
    height: 1,
    white: 1000,
    peak: 4000,
    grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
    strengths: { luma: 1, chroma: 1, sharpen: 1, defringe: 1 },
    matched,
    colour: matched
      ? {
          curves: [ramp(256), ramp(256), ramp(256)] as [number[], number[], number[]],
          matrix: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          saturation: 1,
          trustCeiling: 0.9,
          chroma: {
            nodes: ramp(5 * 5 * 4 * 4),
            chromaCount: 5,
            levelCount: 4,
            chromaLow: -0.5,
            chromaScale: 4,
            levelScale: 3,
          },
        }
      : null,
    samplesLen: pixels * 3 * 2,
  };
  const samples = new Uint16Array(pixels * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = i * 1000 + 7;
  return { header, samples };
}

/** The reader in `raw_edit_presenter.fetchPrepared`, which is the other half of the pin. */
function unframe(bytes: Uint8Array): { header: PreparedHeader; samples: Uint16Array; at: number } {
  const described = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    true,
  );
  const at = bytes.byteOffset + 4 + described;
  return {
    header: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + described))),
    samples: new Uint16Array(bytes.buffer, at, (bytes.byteLength - 4 - described) >> 1),
    at,
  };
}

describe('framePrepared', () => {
  it('round-trips the header and the samples', () => {
    const frame = prepared(true);
    const read = unframe(framePrepared(frame));

    expect(read.header.width).toBe(frame.header.width);
    expect(read.header.matched).toBe(true);
    expect(read.header.colour?.curves[0]).toHaveLength(256);
    expect(read.header.colour?.chroma?.nodes).toHaveLength(400);
    expect([...read.samples]).toEqual([...frame.samples]);
  });

  // The reason the description is in the body at all: as an `X-Prepared` response header it
  // was 11KB, and nginx answers 502 rather than forward one past its 4KB buffer. A test at
  // a bounded `longEdge` would not have caught it, because an unmatched frame's is 247.
  it('carries a description too large to have been a response header', () => {
    const framed = framePrepared(prepared(true));
    const described = new DataView(framed.buffer, framed.byteOffset).getUint32(0, true);
    expect(described).toBeGreaterThan(4096);
  });

  // What the header bought by being outside the body, kept now that it is inside it: the
  // samples land where a `Uint16Array` maps over them rather than copying 361MB.
  it('leaves the samples four-byte aligned, whatever the description weighs', () => {
    for (const matched of [true, false]) {
      for (const pixels of [1, 2, 3, 5, 7]) {
        const framed = framePrepared(prepared(matched, pixels));
        const read = unframe(framed);
        expect(read.at % 4).toBe(0);
        expect([...read.samples]).toEqual([...prepared(matched, pixels).samples]);
      }
    }
  });

  // The padding has to be JSON's own whitespace, because the reader hands the whole padded
  // span to `JSON.parse` rather than trimming it: a NUL is "Unrecognized token" there, and
  // would fail every open whose header does not already land on a multiple of four. Swept
  // across widths so all four remainders are covered - at one width it is a coin toss
  // whether any padding is emitted at all, which is how a wrong byte survives a green run.
  it('pads to four with whitespace JSON accepts, at every remainder', () => {
    const seen = new Set<number>();
    for (let pixels = 1; pixels <= 24; pixels++) {
      const frame = prepared(pixels % 2 === 0, pixels);
      const json = new TextEncoder().encode(JSON.stringify(frame.header));
      seen.add(json.byteLength % 4);

      const framed = framePrepared(frame);
      const described = new DataView(framed.buffer, framed.byteOffset).getUint32(0, true);
      expect(described % 4).toBe(0);
      expect(described).toBeGreaterThanOrEqual(json.byteLength);

      const text = new TextDecoder().decode(framed.subarray(4, 4 + described));
      expect(text.slice(json.byteLength)).toMatch(/^ *$/);
      expect(JSON.parse(text).ok).toBe(true);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
});
