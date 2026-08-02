// Keep in sync with src/utils/library_name.ts; web cannot value-import that tree.
export function inferredLibraryName(rootPath: string): string {
  const segments = rootPath.replace(/\\/g, '/').split('/').filter((segment) => segment !== '');
  const leaf = segments[segments.length - 1] ?? rootPath;
  if (/^\d{4}$/.test(leaf)) {
    const parent = segments[segments.length - 2];
    if (parent != null) return `${parent} ${leaf}`;
  }
  return leaf;
}
