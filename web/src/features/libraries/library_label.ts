import type { Library } from '../../api/client';

// What a library is called on screen: the name it was given, or its root folder
// until it is given one.
export function libraryLabel(library: Library): string {
  if (library.name != null && library.name !== '') return library.name;
  const segments = library.root_path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? library.root_path;
}
