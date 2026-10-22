import { describe, it, expect } from 'bun:test';
import { computeFileHash } from '../hash';

const stat = { mtime: '2024-01-01T00:00:00.000Z', fileSize: 1234 };

describe('computeFileHash', () => {
  it('produces a 40-char hex sha1 and ignores the path (ext lowercased)', () => {
    const a = computeFileHash('/library/IMG_0001.ARW', stat);
    const b = computeFileHash('/elsewhere/IMG_0001.arw', stat);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(a).toBe(b);
  });

  it('changes when any hashed field changes', () => {
    const base = computeFileHash('/l/a.arw', stat);
    expect(computeFileHash('/l/a.arw', { ...stat, mtime: '2025-01-01T00:00:00.000Z' })).not.toBe(
      base,
    );
    expect(computeFileHash('/l/a.arw', { ...stat, fileSize: 9999 })).not.toBe(base);
    expect(computeFileHash('/l/a.dng', stat)).not.toBe(base);
  });
});
