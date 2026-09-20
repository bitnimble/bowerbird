import { describe, expect, it } from 'bun:test';
import { encoderQuality, perceivedQuality, type QualityTarget } from '../quality';

const TARGETS: QualityTarget[] = ['avif-sdr', 'avif-hdr', 'jpeg', 'jxl'];

describe('encoderQuality', () => {
  // A library re-renders at a different quality on its next build if these move, so the
  // values the settings shipped with are what the scale has to land on.
  it('lands the anchors on the values the settings shipped with', () => {
    expect(encoderQuality('avif-sdr', 80)).toBe(13);
    expect(encoderQuality('avif-sdr', 88)).toBe(8);
    expect(encoderQuality('avif-hdr', 80)).toBe(3);
    expect(encoderQuality('avif-hdr', 88)).toBe(1);
  });

  it('is monotonic in perceived quality, whichever way the encoder counts', () => {
    for (const target of TARGETS) {
      const better = (a: number, b: number): boolean =>
        target === 'jpeg' ? a <= b : a >= b;
      for (let quality = 1; quality <= 100; quality++) {
        const worse = encoderQuality(target, quality - 1);
        const now = encoderQuality(target, quality);
        expect(better(worse, now)).toBe(true);
      }
    }
  });

  it('clamps rather than extrapolating past either end', () => {
    for (const target of TARGETS) {
      expect(encoderQuality(target, -20)).toBe(encoderQuality(target, 0));
      expect(encoderQuality(target, 150)).toBe(encoderQuality(target, 100));
    }
  });

  // A PQ frame needs a tighter quantizer than an sRGB one for the same picture, so the two
  // AVIF curves cannot be the same curve - which is the reason this module exists at all.
  it('asks more of the encoder for HDR than for SDR at the same quality', () => {
    for (let quality = 10; quality < 100; quality++) {
      expect(encoderQuality('avif-hdr', quality)).toBeLessThan(encoderQuality('avif-sdr', quality));
    }
  });
});

describe('perceivedQuality', () => {
  // What the settings migration reads a tuned value back as. The anchors have to come back
  // exactly, or upgrading re-renders every library at a quality nobody asked for.
  it('reads the anchors back as themselves', () => {
    expect(perceivedQuality('avif-sdr', 13)).toBe(80);
    expect(perceivedQuality('avif-sdr', 8)).toBe(88);
    expect(perceivedQuality('avif-hdr', 3)).toBe(80);
    expect(perceivedQuality('avif-hdr', 1)).toBe(88);
  });

  // The property the migration actually needs, and it is not that the number comes back:
  // a quality read off an old setting has to *encode* to the setting it was read from. Where
  // the curve is steep a quantizer step is worth more than two quality points, so the number
  // itself can move by that much while the picture does not.
  it('reads back to a quality that encodes to the same value', () => {
    for (const target of TARGETS) {
      for (let quality = 0; quality <= 100; quality++) {
        const encoded = encoderQuality(target, quality);
        expect(encoderQuality(target, perceivedQuality(target, encoded))).toBe(encoded);
      }
    }
  });

  it('pins a value off the end of the table to the nearer extreme', () => {
    expect(perceivedQuality('avif-sdr', 63)).toBe(0);
    expect(perceivedQuality('avif-sdr', 200)).toBe(0);
    expect(perceivedQuality('avif-sdr', -5)).toBe(100);
  });
});
