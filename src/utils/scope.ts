import path from 'node:path';
import type { Library } from '../schemas/libraries';

// What a library contains, as one question asked in one place (DESIGN §9.1).
//
// The scan and the watcher both need it, and they used to answer it separately:
// two lists of skip rules that agree until one of them is edited. Nothing visible
// breaks when they drift - an excluded folder just keeps waking syncs, and the
// watcher keeps queueing paths the scan will discard - which is why it is worth
// having once rather than watching for it.
export interface LibraryScope {
  rootPath: string;
  dataPath: string;
  includeSubfolders: boolean;
  /** Root-relative folder paths carrying an `excluded` rule (§4.7). */
  excluded: ReadonlySet<string>;
  /** `dataPath` already resolved, since every path test compares against it. */
  readonly resolvedDataPath: string;
}

/** The one place a scope is assembled, so every caller asks the same question. */
export function libraryScope(
  library: Pick<Library, 'root_path' | 'include_subfolders'>,
  dataPath: string,
  excluded: ReadonlySet<string>,
): LibraryScope {
  return {
    rootPath: library.root_path,
    dataPath,
    includeSubfolders: library.include_subfolders,
    excluded,
    resolvedDataPath: path.resolve(dataPath),
  };
}

// Directory basenames never descended into. See DESIGN §6, §12.2.
//  - hidden dirs (leading '.') covers `.bowerbird` and other dotfolders
//  - `Bin` covers the deletion bins so soft-deleted files aren't re-imported
function isExcludedName(name: string): boolean {
  return name.startsWith('.') || name === 'Bin';
}

// The rules that read the path itself, which answer the same whether what sits
// there is a file or a folder: every one of them is about a segment, so a path
// under a skipped folder is skipped however it ends.
//
// Separate from `isDirInScope` because a watcher event names a path and not what
// kind of thing is at it, and this half needs no such distinction.
export function isPathAllowed(scope: LibraryScope, relPath: string): boolean {
  if (relPath === '') return true;
  const segments = relPath.split('/');
  if (segments.some(isExcludedName)) return false;

  // Excluded is subtree-wide: a folder that is never walked has no children to
  // consider, so an ancestor's rule answers for everything beneath it.
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    if (scope.excluded.has(prefix)) return false;
  }

  const abs = path.resolve(scope.rootPath, relPath);
  const data = scope.resolvedDataPath;
  return abs !== data && !abs.startsWith(`${data}${path.sep}`);
}

/** `relDir` is root-relative with forward slashes; `''` is the library root. */
export function isDirInScope(scope: LibraryScope, relDir: string): boolean {
  if (relDir === '') return true;
  // The one rule that needs to know it is looking at a folder: a root-only
  // library keeps the files in its root and none of the folders beside them.
  if (!scope.includeSubfolders) return false;
  return isPathAllowed(scope, relDir);
}

/** Location only: whether the *format* is one of ours is `isSupportedFile` (§7). */
export function isFileInScope(scope: LibraryScope, relPath: string): boolean {
  const slash = relPath.lastIndexOf('/');
  return isDirInScope(scope, slash < 0 ? '' : relPath.slice(0, slash));
}
