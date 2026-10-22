/**
 * The deepest folder every path sits under, stepping up one level when that folder is itself one of
 * the paths; undefined with nothing to go on.
 */
export function commonParent(rootPaths: string[]): string | undefined {
  const first = segments(rootPaths[0] ?? '');
  if (rootPaths.length === 0 || first.length === 0) return undefined;

  let shared = first.length;
  let shallowest = first.length;
  for (const rootPath of rootPaths.slice(1)) {
    const other = segments(rootPath);
    shallowest = Math.min(shallowest, other.length);
    let i = 0;
    while (i < shared && i < other.length && other[i] === first[i]) i++;
    shared = i;
  }

  // The shallowest path is itself the common prefix, so the answer is one level above it.
  if (shared === shallowest) shared -= 1;
  return `/${first.slice(0, shared).join('/')}`;
}

function segments(rootPath: string): string[] {
  return rootPath.split('/').filter((segment) => segment !== '');
}
