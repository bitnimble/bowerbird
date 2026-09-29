import { describe, it, expect } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { foldersUnder } from '../browse';
import { scope, withRoot } from './library_tree_test_helpers';

describe('foldersUnder', () => {
  // A link back up the tree is a cycle, and the walk is the one thing here that
  // would follow it forever.
  it(
    'follows a symlinked folder once',
    withRoot(async (root) => {
      mkdirSync(path.join(root, 'Trip/Import'), { recursive: true });
      symlinkSync(path.join(root, 'Trip'), path.join(root, 'Trip/Import/loop'), process.platform === 'win32' ? 'junction' : 'dir');

      const found = await foldersUnder(scope(root));

      expect(found).toEqual(['Trip', 'Trip/Import', 'Trip/Import/loop']);
    }),
  );
});
