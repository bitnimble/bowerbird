import path from 'node:path';

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
}

// Directory basenames never descended into. See DESIGN §6, §12.2.
//  - hidden dirs (leading '.') covers `.bowerbird` and other dotfolders
//  - `Bin` covers the deletion bins so soft-deleted files aren't re-imported
function isExcludedName(name: string): boolean {
  return name.startsWith('.') || name === 'Bin';
}

/** `relDir` is root-relative with forward slashes; `''` is the library root. */
export function isDirInScope(scope: LibraryScope, relDir: string): boolean {
  if (relDir === '') return true;
  const segments = relDir.split('/');
  if (!scope.includeSubfolders) return false;
  if (segments.some(isExcludedName)) return false;

  // Excluded is subtree-wide: a folder that is never walked has no children to
  // consider, so an ancestor's rule answers for everything beneath it.
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    if (scope.excluded.has(prefix)) return false;
  }

  const abs = path.resolve(scope.rootPath, relDir);
  const data = path.resolve(scope.dataPath);
  return abs !== data && !abs.startsWith(`${data}${path.sep}`);
}

/** Location only: whether the *format* is one of ours is `isSupportedFile` (§7). */
export function isFileInScope(scope: LibraryScope, relPath: string): boolean {
  const slash = relPath.lastIndexOf('/');
  return isDirInScope(scope, slash < 0 ? '' : relPath.slice(0, slash));
}
