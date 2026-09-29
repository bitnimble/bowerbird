import { jest } from 'bun:test';
import { LibrariesService } from '../libraries_service';
import type { LibrariesRepository } from '../libraries_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';

// Repository is a class with private state, so a structural double is cast once
// here (test-only) rather than standing up a real catalogue.
export function mockRepo(overrides: Partial<LibrariesRepository> = {}): LibrariesRepository {
  return {
    insert: jest.fn(),
    getById: jest.fn(() => null),
    getByRootPath: jest.fn(() => null),
    list: jest.fn(() => []),
    delete: jest.fn(() => false),
    setBinIdentity: jest.fn(),
    setBinName: jest.fn(),
    setReadOnly: jest.fn(),
    getBinIdentity: jest.fn(() => null),
    ...overrides,
  } as unknown as LibrariesRepository;
}

// Only the bin rename reaches it, and only from `update`.
const noPhotoScan = { transaction: (fn: () => void) => fn() } as unknown as PhotoScanRepository;
const noPhotoPaths = { rewriteBinnedPathPrefix: jest.fn() } as unknown as PhotoPathsRepository;

export function build(repo: LibrariesRepository): LibrariesService {
  return new LibrariesService(repo, noPhotoScan, noPhotoPaths);
}
