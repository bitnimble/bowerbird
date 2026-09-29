import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browseAbsolute, createFolder, foldersUnder } from '../browse';
import { scope, withRoot } from './library_tree_test_helpers';

describe('foldersUnder', () => {
  it(
    'reaches every depth, and says so about a folder holding nothing',
    withRoot(async (root) => {
      mkdirSync(path.join(root, 'Trip/Import/rx100'), { recursive: true });
      mkdirSync(path.join(root, 'Trip/Empty'), { recursive: true });
      writeFileSync(path.join(root, 'Trip/Import/IMG_0001.arw'), '');

      expect(await foldersUnder(scope(root))).toEqual([
        'Trip',
        'Trip/Empty',
        'Trip/Import',
        'Trip/Import/rx100',
      ]);
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
