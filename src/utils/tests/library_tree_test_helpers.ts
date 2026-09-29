import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { libraryScope, type LibraryScope } from '../scope';

export function withRoot(run: (root: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-tree-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export function scope(
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
