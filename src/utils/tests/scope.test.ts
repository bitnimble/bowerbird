import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { isDirInScope, isFileInScope, isPathAllowed, libraryScope, type LibraryScope } from '../scope';

const ROOT = '/lib';

// Built through the real constructor rather than as a literal, so the tests
// cannot drift from how a scope is actually assembled.
function scope(over: { dataPath?: string; includeSubfolders?: boolean; excluded?: Set<string>; binName?: string } = {}): LibraryScope {
  return libraryScope(
    { root_path: ROOT, include_subfolders: over.includeSubfolders ?? true, bin_name: over.binName ?? 'Bin' },
    over.dataPath ?? path.join(ROOT, '.bowerbird'),
    over.excluded ?? new Set<string>(),
  );
}

describe('isDirInScope', () => {
  it('always holds the library root', () => {
    expect(isDirInScope(scope({ includeSubfolders: false }), '')).toBe(true);
  });

  it('skips dotfolders at any depth', () => {
    expect(isDirInScope(scope(), 'Trip/.git')).toBe(false);
    expect(isDirInScope(scope(), '.git/objects')).toBe(false);
  });

  // The bin is one tree at the root, so that is the only place the name means
  // anything: a folder of the user's own called Bin further down is theirs, and
  // dropping it would take its photographs out of the library in silence.
  it('skips the bin at the root, and only there', () => {
    expect(isDirInScope(scope(), 'Bin')).toBe(false);
    expect(isDirInScope(scope(), 'Bin/Trip/2019')).toBe(false);
    expect(isDirInScope(scope(), 'Trip/Bin')).toBe(true);
    expect(isDirInScope(scope(), 'Binnacle')).toBe(true); // prefix, not the bin
  });

  // The name is the library's, so a root that already had a Bin of the user's own
  // keeps it and skips whatever the bin was named instead.
  it('skips the library\'s own bin name, and nothing else', () => {
    const renamed = scope({ binName: 'Deleted' });
    expect(isDirInScope(renamed, 'Deleted')).toBe(false);
    expect(isDirInScope(renamed, 'Deleted/Trip')).toBe(false);
    expect(isDirInScope(renamed, 'Bin')).toBe(true);
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

// What the watcher asks, because an event names a path and not what kind of thing
// is at it. Every rule here is about a segment, so both answers have to agree.
describe('isPathAllowed', () => {
  it('answers the same for a folder and for a file inside it', () => {
    const s = scope({ excluded: new Set(['Rejects']) });
    expect(isPathAllowed(s, 'Rejects')).toBe(false);
    expect(isPathAllowed(s, 'Rejects/a.arw')).toBe(false);
    expect(isPathAllowed(s, 'Trip')).toBe(true);
    expect(isPathAllowed(s, 'Trip/a.arw')).toBe(true);
  });

  // The rule that does need to know, and so is applied to files alone on the
  // watcher: a root-level file stays while a root-level folder goes.
  it('says nothing about how deep the library goes', () => {
    const s = scope({ includeSubfolders: false });
    expect(isPathAllowed(s, 'Trip')).toBe(true);
    expect(isPathAllowed(s, 'Trip/a.arw')).toBe(true);
  });

  it('still refuses the Bin, dotfolders and the data directory', () => {
    const s = scope();
    expect(isPathAllowed(s, 'Bin')).toBe(false);
    expect(isPathAllowed(s, 'Bin/Trip/a.arw')).toBe(false);
    expect(isPathAllowed(s, '.bowerbird/renditions/x.avif')).toBe(false);
  });
});

describe('isFileInScope', () => {
  it('answers for the folder the file sits in', () => {
    const s = scope({ excluded: new Set(['Rejects']) });
    expect(isFileInScope(s, 'a.arw')).toBe(true);
    expect(isFileInScope(s, 'Trip/a.arw')).toBe(true);
    expect(isFileInScope(s, 'Rejects/a.arw')).toBe(false);
    expect(isFileInScope(s, 'Bin/Trip/a.arw')).toBe(false);
  });

  // A root-only library still has its own root.
  it('keeps root files when subfolders are off, and drops the rest', () => {
    const s = scope({ includeSubfolders: false });
    expect(isFileInScope(s, 'a.arw')).toBe(true);
    expect(isFileInScope(s, 'Trip/a.arw')).toBe(false);
  });
});
