import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isSupportedFile, uniqueDestPath } from '../files';

describe('isSupportedFile', () => {
  it('matches .arw case-insensitively and rejects others', () => {
    expect(isSupportedFile('IMG_0001.ARW')).toBe(true);
    expect(isSupportedFile('IMG_0001.arw')).toBe(true);
    expect(isSupportedFile('IMG_0001.jpg')).toBe(false);
    expect(isSupportedFile('noext')).toBe(false);
  });
});

describe('uniqueDestPath', () => {
  it('appends a numeric suffix before the extension on collision', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      expect(uniqueDestPath(dir, 'IMG_0001.ARW')).toBe(path.join(dir, 'IMG_0001.ARW'));

      writeFileSync(path.join(dir, 'IMG_0001.ARW'), '');
      expect(uniqueDestPath(dir, 'IMG_0001.ARW')).toBe(path.join(dir, 'IMG_0001_1.ARW'));

      writeFileSync(path.join(dir, 'IMG_0001_1.ARW'), '');
      expect(uniqueDestPath(dir, 'IMG_0001.ARW')).toBe(path.join(dir, 'IMG_0001_2.ARW'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
