import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moveIntoDir } from '../files';
import { isSupportedFile, rawMediaType, scanLibraryTree } from '../scan';
import { libraryScope, type LibraryScope } from '../scope';

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
  it('matches every supported extension case-insensitively and rejects others', () => {
    expect(isSupportedFile('IMG_0001.ARW')).toBe(true);
    expect(isSupportedFile('IMG_0001.arw')).toBe(true);
    expect(isSupportedFile('IMG_0001.CR2')).toBe(true);
    expect(isSupportedFile('IMG_0001.cr2')).toBe(true);
    expect(isSupportedFile('IMG_0001.CR3')).toBe(true);
    expect(isSupportedFile('IMG_0001.cr3')).toBe(true);
    expect(isSupportedFile('IMG_0001.jpg')).toBe(false);
    expect(isSupportedFile('IMG_0001.cr')).toBe(false);
    expect(isSupportedFile('noext')).toBe(false);
  });
});

describe('rawMediaType', () => {
  it('names each format, and refuses to guess at one it does not scan', () => {
    expect(rawMediaType('IMG_0001.ARW')).toBe('image/x-sony-arw');
    expect(rawMediaType('IMG_0001.cr2')).toBe('image/x-canon-cr2');
    expect(rawMediaType('IMG_0001.cr3')).toBe('image/x-canon-cr3');
    expect(rawMediaType('IMG_0001.dng')).toBe('application/octet-stream');
  });
});

function scope(
  root: string,
  over: { dataPath?: string; includeSubfolders?: boolean; excluded?: Set<string> } = {},
): LibraryScope {
  return libraryScope(
    { root_path: root, include_subfolders: over.includeSubfolders ?? true },
    over.dataPath ?? path.join(root, '.bowerbird'),
    over.excluded ?? new Set<string>(),
  );
}

describe('scanLibraryTree', () => {
  it('returns supported files with forward-slash relative paths and skips non-raw', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    writeFileSync(path.join(root, 'b.jpg'), '');
    writeFileSync(path.join(root, 'd.CR3'), '');
    mkdirSync(path.join(root, 'Day1'));
    writeFileSync(path.join(root, 'Day1', 'c.ARW'), '');
    writeFileSync(path.join(root, 'Day1', 'e.cr2'), '');

    const { files, dirs } = await scanLibraryTree(scope(root));
    expect(files.map((f) => f.relPath).sort()).toEqual(['Day1/c.ARW', 'Day1/e.cr2', 'a.arw', 'd.CR3']);
    // The folder identities relocation reads (§9.4.1).
    expect(dirs.map((d) => d.relPath)).toEqual(['Day1']);
    expect(dirs[0]?.ino).toBeGreaterThan(0);
  }));

  it('skips excluded dirs (dotfolders, Bin) and the data dir', withRoot(async (root) => {
    mkdirSync(path.join(root, '.bowerbird'));
    writeFileSync(path.join(root, '.bowerbird', 'hidden.arw'), '');
    mkdirSync(path.join(root, 'Bin'));
    writeFileSync(path.join(root, 'Bin', 'deleted.arw'), '');
    mkdirSync(path.join(root, 'data'));
    writeFileSync(path.join(root, 'data', 'inside.arw'), '');
    writeFileSync(path.join(root, 'keep.arw'), '');

    const { files } = await scanLibraryTree(scope(root, { dataPath: path.join(root, 'data') }));
    expect(files.map((f) => f.relPath)).toEqual(['keep.arw']);
  }));

  it('stays at the root when the library does not include subfolders', withRoot(async (root) => {
    writeFileSync(path.join(root, 'top.arw'), '');
    mkdirSync(path.join(root, 'Day1'));
    writeFileSync(path.join(root, 'Day1', 'deep.arw'), '');

    const { files, dirs } = await scanLibraryTree(scope(root, { includeSubfolders: false }));
    expect(files.map((f) => f.relPath)).toEqual(['top.arw']);
    expect(dirs).toEqual([]);
  }));

  // Subtree-wide by construction: an unwalked folder has no children to consider.
  it('skips an excluded folder and everything under it', withRoot(async (root) => {
    writeFileSync(path.join(root, 'keep.arw'), '');
    mkdirSync(path.join(root, 'Rejects', 'Deeper'), { recursive: true });
    writeFileSync(path.join(root, 'Rejects', 'a.arw'), '');
    writeFileSync(path.join(root, 'Rejects', 'Deeper', 'b.arw'), '');

    const { files } = await scanLibraryTree(scope(root, { excluded: new Set(['Rejects']) }));
    expect(files.map((f) => f.relPath)).toEqual(['keep.arw']);
  }));

  it('does not loop on a symlink cycle', withRoot(async (root) => {
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'x.arw'), '');
    symlinkSync(root, path.join(root, 'sub', 'loop')); // sub/loop -> root

    const { files } = await scanLibraryTree(scope(root));
    expect(files.map((f) => f.relPath)).toEqual(['sub/x.arw']);
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
