import { jest } from 'bun:test';
import type { PhotoDetail } from '../../../../schemas/photos';
import { fileRecipe } from '../../../../schemas/recipes';
import type { LibrariesRepository } from '../../../libraries/libraries_repository';
import type { PhotoReadService } from '../../listing/photo_read_service';
import type { PhotoPathsRepository } from '../../paths/photo_paths_repository';
import { PhotoMutationService } from '../photo_mutation_service';
import type { PhotoStateRepository } from '../photo_state_repository';

export function build(over: {
  photoState?: Partial<PhotoStateRepository>;
  photoPaths?: Partial<PhotoPathsRepository>;
  read?: Partial<PhotoReadService>;
  libraries?: Partial<LibrariesRepository>;
}) {
  const photoState = {
    update: jest.fn(() => true),
    updateMany: jest.fn(() => 0),
    setHidden: jest.fn(() => 0),
    ...over.photoState,
  } as unknown as PhotoStateRepository;
  const photoPaths = {
    getBasicByIds: jest.fn(() => []),
    setFilePath: jest.fn(),
    markDeleted: jest.fn(),
    transaction: (fn: () => unknown) => fn(),
    ...over.photoPaths,
  } as unknown as PhotoPathsRepository;
  const read = { get: jest.fn(() => detail), ...over.read } as unknown as PhotoReadService;
  const libraries = {
    getById: jest.fn(() => null),
    setBinIdentity: jest.fn(),
    ...over.libraries,
  } as unknown as LibrariesRepository;
  return {
    service: new PhotoMutationService(photoState, photoPaths, libraries, read),
    photoState,
    photoPaths,
    read,
    libraries,
  };
}
export const detail = { id: 'p1', file_path: 'a.arw', recipe: fileRecipe('a.arw') } as PhotoDetail;
