import { describe, expect, it } from 'bun:test';
import { developed } from '../developed';

describe('developed', () => {
  it('leaves an unedited photo at the camera exposure', () => {
    expect(developed(null).exposure).toBeNull();
  });

  // A prepare for an editor previewing a Detail or dust setting it has not saved: those run before
  // the samples cross, so they come from the preview, and everything else from the last save.
  it('takes what the reader is previewing over the stored document, and keeps the rest', () => {
    const stored = JSON.stringify({ version: 1, exposure: 1.5, sharpening: 20 });
    const job = developed(stored, {
      luminanceNoise: 30,
      colourNoise: null,
      denoiser: 'galosh',
      sharpening: 80,
      dustRemoval: false,
      dustSensitivity: 25,
      dustIntensity: 100,
    });
    expect(job.sharpen).toBeCloseTo(0.8);
    expect(job.denoiseLuminance).toBe(30);
    expect(job.dust.enabled).toBe(false);
    expect(job.exposure).toBe(1.5);
    expect(developed(stored).sharpen).toBeCloseTo(0.2);
  });
});
