import { describe, expect, it } from 'bun:test';
import { ExportOptionsSchema } from '../../../../schemas/export';
import { estimateExportBytes } from '../export_estimate';

const FRAME = { width: 6000, height: 4000 };
const options = (over: Partial<ReturnType<typeof ExportOptionsSchema.parse>> = {}) =>
  ExportOptionsSchema.parse({ ...over });

describe('estimateExportBytes', () => {
  it('says nothing rather than guessing when the frame is unknown', () => {
    expect(estimateExportBytes(options(), null)).toBeNull();
    expect(estimateExportBytes(options(), { width: 0, height: 0 })).toBeNull();
  });

  // The decision this informs is "2MB or 200MB", so what has to hold is the ordering and the
  // order of magnitude rather than any particular number.
  it('is in the right order of magnitude for a full-size JPEG of a 24MP frame', () => {
    const bytes = estimateExportBytes(options({ format: 'jpeg', quality: 80 }), FRAME)!;
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThan(20_000_000);
  });

  it('grows with quality and shrinks with a smaller long edge', () => {
    const base = estimateExportBytes(options({ quality: 80 }), FRAME)!;
    expect(estimateExportBytes(options({ quality: 95 }), FRAME)!).toBeGreaterThan(base);
    expect(estimateExportBytes(options({ quality: 60 }), FRAME)!).toBeLessThan(base);
    expect(estimateExportBytes(options({ longEdge: 3000 }), FRAME)!).toBeLessThan(base);
  });

  // Area, not edge: halving the long edge is a quarter of the pixels, and an estimate that
  // halved instead would be four times wrong on the case a reader reaches for most.
  it('scales with area rather than with the edge', () => {
    const full = estimateExportBytes(options({ longEdge: 6000 }), FRAME)!;
    const half = estimateExportBytes(options({ longEdge: 3000 }), FRAME)!;
    expect(half / full).toBeCloseTo(0.25, 2);
  });

  it('does not invent pixels the frame never had', () => {
    const asShot = estimateExportBytes(options({ longEdge: 0 }), FRAME)!;
    expect(estimateExportBytes(options({ longEdge: 99_000 }), FRAME)!).toBe(asShot);
  });

  it('quarters a half-size decode', () => {
    const full = estimateExportBytes(options({ halfSize: false }), FRAME)!;
    expect(estimateExportBytes(options({ halfSize: true }), FRAME)! / full).toBeCloseTo(0.25, 2);
  });

  // Lossless formats ignore the quality slider, which is what the dialog greys it out for.
  it('ignores quality for the lossless formats', () => {
    for (const format of ['png', 'tiff'] as const) {
      const low = estimateExportBytes(options({ format, quality: 10 }), FRAME);
      const high = estimateExportBytes(options({ format, quality: 100 }), FRAME);
      expect(low).toBe(high);
    }
  });

  it('adds for a gain map', () => {
    const plain = estimateExportBytes(options({ format: 'avif', gainMap: false }), FRAME)!;
    const mapped = estimateExportBytes(options({ format: 'avif', exportHdr: true, gainMap: true }), FRAME)!;
    expect(mapped).toBeGreaterThan(plain);
  });
});
