import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browseAbsolute, createFolder, foldersUnder } from '../browse';
import { libraryScope, type LibraryScope } from '../scope';

function withRoot(run: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-browse-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function scope(root: string, over: { includeSubfolders?: boolean; excluded?: Set<string> } = {}): LibraryScope {
  return libraryScope(
    { root_path: root, include_subfolders: over.includeSubfolders ?? true, include_non_raw: false, bin_name: 'Bin' },
    over.excluded ?? new Set<string>(),
  );
}

describe('foldersUnder', () => {
  it(
    'reaches every depth, and says so about a folder holding nothing',
    withRoot(async (root) => {
      mkdirSync(path.join(root, 'Trip/Import/rx100'), { recursive: true });
      mkdirSync(path.join(root, 'Trip/Empty'), { recursive: true });
      writeFileSync(path.join(root, 'Trip/Import/IMG_0001.arw'), '');

      expect(await foldersUnder(scope(root))).toEqual(['Trip', 'Trip/Empty', 'Trip/Import', 'Trip/Import/rx100']);
    }),
  );

  // The whole point of asking for the tree at once: a leaf is drawn as a leaf
  // rather than with a chevron that vanishes under the click meant to open it.
  it(
    'leaves out what the scan would skip, and everything under it',
    withRoot(async (root) => {
      mkdirSync(path.join(root, 'Bin/Trip'), { recursive: true });
      mkdirSync(path.join(root, '.cache/thumbs'), { recursive: true });
      mkdirSync(path.join(root, 'Archive/2019'), { recursive: true });
      mkdirSync(path.join(root, 'Trip'), { recursive: true });

      const found = await foldersUnder(scope(root, { excluded: new Set(['Archive']) }));

      expect(found).toEqual(['Trip']);
    }),
  );

  it(
    'holds only the root when the library keeps no subfolders',
    withRoot(async (root) => {
      mkdirSync(path.join(root, 'Trip'), { recursive: true });

      expect(await foldersUnder(scope(root, { includeSubfolders: false }))).toEqual([]);
    }),
  );

  // A link back up the tree is a cycle, and the walk is the one thing here that
  // would follow it forever.
  it(
    'follows a symlinked folder once',
    withRoot(async (root) => {
      mkdirSync(path.join(root, 'Trip/Import'), { recursive: true });
      symlinkSync(path.join(root, 'Trip'), path.join(root, 'Trip/Import/loop'));

      const found = await foldersUnder(scope(root));

      expect(found).toEqual(['Trip', 'Trip/Import', 'Trip/Import/loop']);
    }),
  );
});

describe('createFolder', () => {
  it(
    'makes the folder, and refuses one already there',
    withRoot(async (root) => {
      await createFolder(path.join(root, 'Trip'));

      expect((await browseAbsolute(root)).directories.map((d) => d.name)).toEqual(['Trip']);
      await expect(createFolder(path.join(root, 'Trip'))).rejects.toThrow('already exists');
    }),
  );

  it(
    'refuses a parent that is not there',
    withRoot(async (root) => {
      await expect(createFolder(path.join(root, 'gone/Trip'))).rejects.toThrow('no such directory');
    }),
  );
});
