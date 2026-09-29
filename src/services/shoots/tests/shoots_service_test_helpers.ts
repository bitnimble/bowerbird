import { jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../../schemas/libraries';
import type { Shoot } from '../../../schemas/shoots';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoStateRepository } from '../../photos/mutations/photo_state_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { FolderRulesRepository } from '../folder_rules_repository';
import { ShootsService } from '../shoots_service';
import type { ShootsRepository } from '../shoots_repository';

export function mockShoots(over: Partial<ShootsRepository> = {}): ShootsRepository {
  return {
    transaction: (fn: () => unknown) => fn(),
    insert: jest.fn(),
    getById: jest.fn(() => null),
    getByFolderPath: jest.fn(() => null),
    listIdentities: jest.fn(() => []),
    listFolders: jest.fn(() => []),
    setIdentity: jest.fn(),
    listByLibrary: jest.fn(() => []),
    updateFields: jest.fn(),
    reparentChildren: jest.fn(),
    delete: jest.fn(() => false),
    setBanner: jest.fn(),
    setHidden: jest.fn(),
    ...over,
  } as unknown as ShootsRepository;
}
export function mockRules(over: Partial<FolderRulesRepository> = {}): FolderRulesRepository {
  return {
    listByLibrary: jest.fn(() => []),
    pathsWithRule: jest.fn(() => new Set<string>()),
    set: jest.fn(),
    clear: jest.fn(() => false),
    ...over,
  } as unknown as FolderRulesRepository;
}
export function mockPhotos(over: Partial<PhotoPathsRepository> = {}): PhotoPathsRepository {
  return {
    getBasicByIds: jest.fn(() => [] as BasicPhoto[]),
    listUnderFolder: jest.fn(() => [] as BasicPhoto[]),
    setShoot: jest.fn(),
    setFilePath: jest.fn(),
    setFilePathAndShoot: jest.fn(),
    ...over,
  } as unknown as PhotoPathsRepository;
}

export function makeService(
  shoots: ShootsRepository,
  photoPaths: PhotoPathsRepository,
  libraries: LibrariesRepository,
  folderRules: FolderRulesRepository,
): ShootsService {
  const photoState = { refreshStacksUnderShoot: jest.fn() } as unknown as PhotoStateRepository;
  return new ShootsService(shoots, photoPaths, photoState, libraries, folderRules);
}
function library(root: string): Library {
  return {
    id: 'lib',
    root_path: root,
    bin_name: 'Bin',
    read_only: false,
    name: 'lib',
    ordering: 'taken_desc',
    rendition_source: 'embedded' as const,
    rendition_hdr: false,
    render_skip_full: [],
    render_skip_max: [],
    denoiser: 'galosh',
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 0,
    missing_photo_count: 0,
    unavailable_photo_count: 0,
    rendered_photo_count: 0,
  };
}
export function mockLibs(root: string): LibrariesRepository {
  return { getById: jest.fn(() => library(root)) } as unknown as LibrariesRepository;
}

export const shoot: Shoot = {
  id: 'sh',
  parent_id: null,
  library_id: 'lib',
  folder_path: 'Trip',
  name: 'Trip',
  description: null,
  banner_photo_id: null,
  ordering: 'taken_desc',
  photo_count: 0,
  is_hidden: false,
  hidden_directly: false,
};

export function withRoot(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-shoot-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
