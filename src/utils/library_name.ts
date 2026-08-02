// Default library name from its root path. A year leaf takes its parent too, so
// date-sorted trees (…/Trip/2025) don't all show as "2025".
export function inferredLibraryName(rootPath: string): string {
  const segments = rootPath.replace(/\\/g, '/').split('/').filter((segment) => segment !== '');
  const leaf = segments[segments.length - 1] ?? rootPath;
  if (/^\d{4}$/.test(leaf)) {
    const parent = segments[segments.length - 2];
    if (parent != null) return `${parent} ${leaf}`;
  }
  return leaf;
}
