import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isSupportedFile, listSupportedFiles, moveIntoDir } from '../files';

function withRoot(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-files-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('isSupportedFile', () => {
  it('matches .arw case-insensitively and rejects others', () => {
    expect(isSupportedFile('IMG_0001.ARW')).toBe(true);
    expect(isSupportedFile('IMG_0001.arw')).toBe(true);
    expect(isSupportedFile('IMG_0001.jpg')).toBe(false);
    expect(isSupportedFile('noext')).toBe(false);
  });
});

describe('listSupportedFiles', () => {
  it('returns supported files with forward-slash relative paths and skips non-raw', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    writeFileSync(path.join(root, 'b.jpg'), '');
    mkdirSync(path.join(root, 'Day1'));
    writeFileSync(path.join(root, 'Day1', 'c.ARW'), '');

    const found = await listSupportedFiles(root, path.join(root, '.bowerbird'));
    expect(found.map((f) => f.relPath).sort()).toEqual(['Day1/c.ARW', 'a.arw']);
  }));

  it('skips excluded dirs (dotfolders, Bin) and the data dir', withRoot(async (root) => {
    mkdirSync(path.join(root, '.bowerbird'));
    writeFileSync(path.join(root, '.bowerbird', 'hidden.arw'), '');
    mkdirSync(path.join(root, 'Bin'));
    writeFileSync(path.join(root, 'Bin', 'deleted.arw'), '');
    mkdirSync(path.join(root, 'data'));
    writeFileSync(path.join(root, 'data', 'inside.arw'), '');
    writeFileSync(path.join(root, 'keep.arw'), '');

    const found = await listSupportedFiles(root, path.join(root, 'data'));
    expect(found.map((f) => f.relPath)).toEqual(['keep.arw']);
  }));

  it('does not loop on a symlink cycle', withRoot(async (root) => {
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'x.arw'), '');
    symlinkSync(root, path.join(root, 'sub', 'loop')); // sub/loop -> root

    const found = await listSupportedFiles(root, path.join(root, '.bowerbird'));
    expect(found.map((f) => f.relPath)).toEqual(['sub/x.arw']);
  }));
});

describe('moveIntoDir', () => {
  it('moves the file into the target dir keeping its name', withRoot(async (root) => {
    const src = path.join(root, 'a.arw');
    writeFileSync(src, 'data');
    const dir = path.join(root, 'dest');
    mkdirSync(dir);

    const dest = await moveIntoDir(src, dir, 'a.arw');
    expect(dest).toBe(path.join(dir, 'a.arw'));
    expect(await readFile(dest, 'utf8')).toBe('data');
  }));

  it('appends a numeric suffix on name collision', withRoot(async (root) => {
    const dir = path.join(root, 'dest');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'a.arw'), 'existing');
    const src = path.join(root, 'a.arw');
    writeFileSync(src, 'new');

    const dest = await moveIntoDir(src, dir, 'a.arw');
    expect(dest).toBe(path.join(dir, 'a_1.arw'));
    expect(await readFile(path.join(dir, 'a.arw'), 'utf8')).toBe('existing');
    expect(await readFile(dest, 'utf8')).toBe('new');
  }));
});
