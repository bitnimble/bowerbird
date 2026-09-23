import { describe, expect, it } from 'bun:test';
import { encoderQuality, type QualityTarget } from '../quality';

const TARGETS: QualityTarget[] = ['avif-sdr', 'avif-hdr', 'jpeg', 'jxl'];

describe('encoderQuality', () => {
  it('lands the defaults on the IQ quantizers matched to them', () => {
    expect(encoderQuality('avif-sdr', 80)).toBe(18);
    expect(encoderQuality('avif-sdr', 88)).toBe(11);
    expect(encoderQuality('avif-hdr', 80)).toBe(4);
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
