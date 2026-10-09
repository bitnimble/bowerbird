import { describe, expect, it } from 'bun:test';
import { IDENTITY_TONE_CURVE } from '../../../../schemas/photo_edits';
import { developed } from '../developed';

describe('developed', () => {
  it('leaves an unedited photo at the camera exposure', () => {
    expect(developed(null, 'galosh').exposure).toBeNull();
  });

  it('grades a document at its own values, zeros included', () => {
    const job = developed(JSON.stringify({}), 'galosh');
    expect(job.exposure).toBe(0);
    expect(job.adjust).toMatchObject({ saturation: 0, toneCurve: IDENTITY_TONE_CURVE });
  });

  it("grades a merge's document at the camera's until the camera match is written in", () => {
    const job = developed(JSON.stringify({ awaitsCameraMatch: true, contrast: 10 }), 'galosh');
    expect(job.exposure).toBeNull();
    expect(job.adjust).toMatchObject({ contrast: 10, saturation: null, toneCurve: null });
  });

  // A prepare for an editor previewing a Detail or dust setting it has not saved: those run before
  // the samples cross, so they come from the preview, and everything else from the last save.
  it('takes what the reader is previewing over the stored document, and keeps the rest', () => {
    const stored = JSON.stringify({ version: 1, exposure: 1.5, sharpening: 20 });
    const job = developed(stored, 'galosh', {
      luminanceNoise: 30,
      colourNoise: null,
      denoiser: 'galosh',
      highlightRecovery: 40,
      sharpening: 80,
      dustRemoval: false,
      dustSensitivity: 25,
      dustIntensity: 100,
    });
    expect(job.sharpen).toBeCloseTo(0.8);
    expect(job.denoiseLuminance).toBe(30);
    expect(job.highlightRecovery).toBe(40);
    expect(developed(stored, 'galosh').highlightRecovery).toBe(100);
    expect(job.dust.enabled).toBe(false);
    expect(job.exposure).toBe(1.5);
    expect(developed(stored, 'galosh').sharpen).toBeCloseTo(0.2);
  });

  it("denoises with the library's filter unless the edit names one", () => {
    expect(developed(null, 'pmrid').denoiser).toBe('pmrid');
    expect(developed(JSON.stringify({ exposure: 1 }), 'pmrid').denoiser).toBe('pmrid');
    expect(developed(JSON.stringify({ denoiser: 'galosh' }), 'pmrid').denoiser).toBe('galosh');
    expect(developed(JSON.stringify({ denoiser: 'pmrid' }), 'galosh').denoiser).toBe('pmrid');
  });

  it("sharpens an unmoved slider at the effective denoiser's default", () => {
    expect(developed(JSON.stringify({ denoiser: 'upscaler' }), 'galosh').sharpen).toBeCloseTo(0.35);
    expect(developed(JSON.stringify({ sharpening: null }), 'upscaler').sharpen).toBeCloseTo(0.35);
    expect(developed(null, 'upscaler').sharpen).toBeCloseTo(0.35);
    expect(developed(JSON.stringify({ denoiser: 'galosh' }), 'upscaler').sharpen).toBeCloseTo(0.5);
    expect(developed(JSON.stringify({ sharpening: 60 }), 'upscaler').sharpen).toBeCloseTo(0.6);
  });
});
