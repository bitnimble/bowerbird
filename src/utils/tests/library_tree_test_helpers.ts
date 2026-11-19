import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WriteGrants } from '../../services/libraries/write_grants';
import { libraryScope, type LibraryScope } from '../scope';

/** A refused deletion must not ask the platform first, or the reader is prompted for nothing. */
export const NEVER_ASKED: WriteGrants = {
  grant: () => Promise.reject(new Error('asked leave for a deletion it then refused')),
};

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
