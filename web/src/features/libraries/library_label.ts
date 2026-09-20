import { type Library } from '../../../../src/schemas/libraries';

export function libraryLabel(library: Library): string {
  return library.name;
}
