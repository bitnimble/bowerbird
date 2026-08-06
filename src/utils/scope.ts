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
  includeSubfolders: boolean;
  /** The library's bin folder, skipped along with everything under it (§12.3). */
  binName: string;
  /** Root-relative folder paths carrying an `excluded` rule (§4.7). */
  excluded: ReadonlySet<string>;
}

/** The one place a scope is assembled, so every caller asks the same question. */
export function libraryScope(
  library: Pick<Library, 'root_path' | 'include_subfolders' | 'bin_name'>,
  excluded: ReadonlySet<string>,
): LibraryScope {
  return {
    rootPath: library.root_path,
    includeSubfolders: library.include_subfolders,
    binName: library.bin_name,
    excluded,
  };
}

// Hidden dirs (leading '.') at any depth: configuration and caches rather than
// photographs, including a legacy `<root>/.bowerbird` from before generated files
// left the library root (§3). See DESIGN §6.
function isHidden(name: string): boolean {
  return name.startsWith('.');
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
  if (segments.some(isHidden)) return false;
  // The library's one bin, and everything it holds. Anchored at the root rather
  // than matched at every depth because that is the only place a bin is ever made
  // (§12.3): a folder of the user's own called `Bin` further down is theirs, and
  // excluding it by name would drop its photographs from the import in silence.
  if (segments[0] === scope.binName) return false;

  // Excluded is subtree-wide: a folder that is never walked has no children to
  // consider, so an ancestor's rule answers for everything beneath it.
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    if (scope.excluded.has(prefix)) return false;
  }
  return true;
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
