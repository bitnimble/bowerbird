import { describe, it, expect } from 'bun:test';
import { computeFileHash } from '../hash';
import type { FileMetadata } from '../../services/processing/metadata';

const meta: FileMetadata = {
  width: 6000,
  height: 4000,
  colorSpace: 'sRGB',
  orientation: 0,
  dateTaken: null,
  latitude: null,
  longitude: null,
  iso: null,
  shutterSpeed: null,
  aperture: null,
  focalLength: null,
  cameraMake: null,
  cameraModel: null,
  lensModel: null,
  mtime: '2024-01-01T00:00:00.000Z',
  fileSize: 1234,
};

describe('computeFileHash', () => {
  it('produces a 40-char hex sha1 and ignores the path (ext lowercased)', () => {
    const a = computeFileHash('/library/IMG_0001.ARW', meta);
    const b = computeFileHash('/elsewhere/IMG_0001.arw', meta);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(a).toBe(b);
  });

  it('changes when any hashed field changes', () => {
    const base = computeFileHash('/l/a.arw', meta);
    expect(computeFileHash('/l/a.arw', { ...meta, mtime: '2025-01-01T00:00:00.000Z' })).not.toBe(base);
    expect(computeFileHash('/l/a.arw', { ...meta, orientation: 6 })).not.toBe(base);
    expect(computeFileHash('/l/a.arw', { ...meta, fileSize: 9999 })).not.toBe(base);
    expect(computeFileHash('/l/a.arw', { ...meta, width: 6001 })).not.toBe(base);
  });

  it('does not change when a non-hashed field changes (e.g. GPS)', () => {
    const base = computeFileHash('/l/a.arw', meta);
    expect(computeFileHash('/l/a.arw', { ...meta, latitude: 12.3, longitude: 45.6 })).toBe(base);
    expect(computeFileHash('/l/a.arw', { ...meta, dateTaken: '2020-01-01T00:00:00.000Z' })).toBe(base);
  });
});
