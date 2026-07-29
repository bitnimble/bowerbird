import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { isDirInScope, isFileInScope, type LibraryScope } from '../scope';

const ROOT = '/lib';

function scope(over: Partial<LibraryScope> = {}): LibraryScope {
  return {
    rootPath: ROOT,
    dataPath: path.join(ROOT, '.bowerbird'),
    includeSubfolders: true,
    excluded: new Set<string>(),
    ...over,
  };
}

describe('isDirInScope', () => {
  it('always holds the library root', () => {
    expect(isDirInScope(scope({ includeSubfolders: false }), '')).toBe(true);
  });

  it('skips dotfolders and Bin at any depth', () => {
    expect(isDirInScope(scope(), 'Trip/.git')).toBe(false);
    expect(isDirInScope(scope(), 'Trip/Bin')).toBe(false);
    expect(isDirInScope(scope(), 'Trip/Bin/Deeper')).toBe(false);
    expect(isDirInScope(scope(), 'Trip/Binnacle')).toBe(true); // not the Bin
  });

  it('skips the data directory, wherever it is configured', () => {
    expect(isDirInScope(scope(), '.bowerbird')).toBe(false);
    expect(isDirInScope(scope({ dataPath: path.join(ROOT, 'data') }), 'data')).toBe(false);
    expect(isDirInScope(scope({ dataPath: path.join(ROOT, 'data') }), 'data/renditions')).toBe(false);
  });

  it('refuses every subfolder when the library is root-only', () => {
    expect(isDirInScope(scope({ includeSubfolders: false }), 'Trip')).toBe(false);
  });

  // Subtree-wide by construction: a folder that is never walked has no children
  // to consider, so an ancestor's rule answers for everything beneath it.
  it('refuses an excluded folder and everything under it', () => {
    const s = scope({ excluded: new Set(['Rejects', 'Trip/Old']) });
    expect(isDirInScope(s, 'Rejects')).toBe(false);
    expect(isDirInScope(s, 'Rejects/2019')).toBe(false);
    expect(isDirInScope(s, 'Trip/Old/Raw')).toBe(false);
    expect(isDirInScope(s, 'Trip')).toBe(true);
    expect(isDirInScope(s, 'Rejected')).toBe(true); // prefix, not an ancestor
  });
});

describe('isFileInScope', () => {
  it('answers for the folder the file sits in', () => {
    const s = scope({ excluded: new Set(['Rejects']) });
    expect(isFileInScope(s, 'a.arw')).toBe(true);
    expect(isFileInScope(s, 'Trip/a.arw')).toBe(true);
    expect(isFileInScope(s, 'Rejects/a.arw')).toBe(false);
    expect(isFileInScope(s, 'Trip/Bin/a.arw')).toBe(false);
  });

  // A root-only library still has its own root.
  it('keeps root files when subfolders are off, and drops the rest', () => {
    const s = scope({ includeSubfolders: false });
    expect(isFileInScope(s, 'a.arw')).toBe(true);
    expect(isFileInScope(s, 'Trip/a.arw')).toBe(false);
  });
});
