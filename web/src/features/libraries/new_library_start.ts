/**
 * Where the folder picker opens when a library is being added: the deepest
 * folder every existing library root sits under, so a second library beside the
 * first is a click away rather than a walk down from the home directory.
 * Undefined when there is nothing to go on, which is the account's home.
 */
export function newLibraryStart(rootPaths: string[]): string | undefined {
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

  // A library cannot be added at a folder that is already a library root, so a
  // shared folder that is one - every library nested under the shallowest, or
  // there being only one - starts at its parent instead.
  if (shared === shallowest) shared -= 1;
  return `/${first.slice(0, shared).join('/')}`;
}

function segments(rootPath: string): string[] {
  return rootPath.split('/').filter((segment) => segment !== '');
}
