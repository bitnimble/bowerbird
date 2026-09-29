import { describe, it, expect } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { moveIntoDir } from '../files';
import { scanLibraryTree } from '../scan';
import { scope, withRoot } from './library_tree_test_helpers';

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

    const both = await scanLibraryTree(scope(root, { includeNonRaw: true }));
    expect(both.files.map((f) => f.relPath).sort()).toEqual(['Day1/c.ARW', 'Day1/e.cr2', 'a.arw', 'b.jpg', 'd.CR3']);
  }));

  it('does not loop on a symlink cycle', withRoot(async (root) => {
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'x.arw'), '');
    symlinkSync(root, path.join(root, 'sub', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');

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
