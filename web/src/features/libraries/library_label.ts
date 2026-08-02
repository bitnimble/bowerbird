import type { Library } from '../../api/client';

export function libraryLabel(library: Library): string {
  return library.name;
}
