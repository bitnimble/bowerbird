import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moveIntoDir } from '../files';
import { importsFormat, isOriginal, isStrayOriginal, originalMediaType, scanLibraryTree } from '../scan';
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

describe('importsFormat', () => {
  it('matches every RAW extension case-insensitively and rejects others', () => {
    const raws = scope('/x');
    expect(importsFormat(raws, 'IMG_0001.ARW')).toBe(true);
    expect(importsFormat(raws, 'IMG_0001.arw')).toBe(true);
    expect(importsFormat(raws, 'IMG_0001.CR2')).toBe(true);
    expect(importsFormat(raws, 'IMG_0001.cr2')).toBe(true);
    expect(importsFormat(raws, 'IMG_0001.CR3')).toBe(true);
    expect(importsFormat(raws, 'IMG_0001.cr3')).toBe(true);
    expect(importsFormat(raws, 'IMG_0001.cr')).toBe(false);
    expect(importsFormat(raws, 'noext')).toBe(false);
  });

  it('takes the rendered formats only where the library asked for them', () => {
    const raws = scope('/x');
    const everything = scope('/x', { includeNonRaw: true });
    for (const name of ['a.jpg', 'a.JPEG', 'a.png', 'a.heic', 'a.heif', 'a.HIF', 'a.avif']) {
      expect(importsFormat(raws, name)).toBe(false);
      expect(importsFormat(everything, name)).toBe(true);
    }
    // Still not ours either way.
    expect(importsFormat(everything, 'a.tiff')).toBe(false);
    expect(importsFormat(everything, 'a.xmp')).toBe(false);
  });
});

describe('isOriginal', () => {
  // The deletion guards ask this, and they must answer for a library other than
  // the one being swept: a HEIC is an original whether or not this library takes
  // them.
  it('covers every format the app can hold, whatever a library imports', () => {
    expect(isOriginal('a.arw')).toBe(true);
    expect(isOriginal('a.heic')).toBe(true);
    expect(isOriginal('a.avif')).toBe(true);
    expect(isOriginal('a.txt')).toBe(false);
  });

  // The one extension the app writes itself, so under a data directory it is a
  // rendition rather than a photograph.
  it('reads an .avif under a data directory as a rendition of ours', () => {
    expect(isStrayOriginal('a.avif')).toBe(false);
    expect(isStrayOriginal('a.heic')).toBe(true);
    expect(isStrayOriginal('a.arw')).toBe(true);
  });
});

describe('originalMediaType', () => {
  it('names each format, and refuses to guess at one it does not scan', () => {
    expect(originalMediaType('IMG_0001.ARW')).toBe('image/x-sony-arw');
    expect(originalMediaType('IMG_0001.cr2')).toBe('image/x-canon-cr2');
    expect(originalMediaType('IMG_0001.cr3')).toBe('image/x-canon-cr3');
    expect(originalMediaType('IMG_0001.HEIC')).toBe('image/heic');
    expect(originalMediaType('IMG_0001.hif')).toBe('image/heif');
    expect(originalMediaType('IMG_0001.dng')).toBe('image/x-adobe-dng');
    expect(originalMediaType('IMG_0001.nef')).toBe('application/octet-stream');
  });
});

function scope(
  root: string,
  over: { includeSubfolders?: boolean; includeNonRaw?: boolean; excluded?: Set<string> } = {},
): LibraryScope {
  return libraryScope(
    {
      root_path: root,
      include_subfolders: over.includeSubfolders ?? true,
      include_non_raw: over.includeNonRaw ?? false,
      bin_name: 'Bin',
    },
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

    const both = await scanLibraryTree(scope(root, { includeNonRaw: true }));
    expect(both.files.map((f) => f.relPath).sort()).toEqual(['Day1/c.ARW', 'Day1/e.cr2', 'a.arw', 'b.jpg', 'd.CR3']);
  }));

  it('skips excluded dirs (dotfolders, Bin)', withRoot(async (root) => {
    mkdirSync(path.join(root, '.cache'));
    writeFileSync(path.join(root, '.cache', 'hidden.arw'), '');
    mkdirSync(path.join(root, 'Bin'));
    writeFileSync(path.join(root, 'Bin', 'deleted.arw'), '');
    writeFileSync(path.join(root, 'keep.arw'), '');

    const { files } = await scanLibraryTree(scope(root));
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
