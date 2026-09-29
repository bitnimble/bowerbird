import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importsFormat, isOriginal, isStrayOriginal, originalMediaType, scanLibraryTree } from '../scan';
import { scope, withRoot } from './library_tree_test_helpers';

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

describe('scanLibraryTree', () => {
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
});
