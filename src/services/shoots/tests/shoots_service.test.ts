import { jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import type { Library } from '../../../schemas/libraries';
import type { Shoot } from '../../../schemas/shoots';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { BasicPhoto, PhotosRepository } from '../../photos/photos_repository';
import { ShootsService } from '../shoots_service';
import type { ShootsRepository } from '../shoots_repository';

function mockShoots(over: Partial<ShootsRepository> = {}): ShootsRepository {
  return {
    transaction: (fn: () => unknown) => fn(),
    insert: jest.fn(),
    getById: jest.fn(() => null),
    getByName: jest.fn(() => null),
    listByLibrary: jest.fn(() => []),
    updateFields: jest.fn(),
    delete: jest.fn(() => false),
    setBanner: jest.fn(),
    ...over,
  } as unknown as ShootsRepository;
}
function mockPhotos(over: Partial<PhotosRepository> = {}): PhotosRepository {
  return {
    getBasicByIds: jest.fn(() => [] as BasicPhoto[]),
    listUnderFolder: jest.fn(() => [] as BasicPhoto[]),
    setShoot: jest.fn(),
    setFilePath: jest.fn(),
    setFilePathAndShoot: jest.fn(),
    ...over,
  } as unknown as PhotosRepository;
}
function library(root: string): Library {
  return { id: 'lib', root_path: root, data_path: null, ordering: 'taken_desc' };
}
function mockLibs(root: string): LibrariesRepository {
  return { getById: jest.fn(() => library(root)) } as unknown as LibrariesRepository;
}

const shoot: Shoot = {
  id: 'sh',
  parent_id: null,
  library_id: 'lib',
  folder_path: 'Trip',
  name: 'Trip',
  description: null,
  banner_photo_id: null,
  ordering: 'taken_desc',
};

function withRoot(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-shoot-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('ShootsService.create', () => {
  it('creates the folder and inserts the record', withRoot(async (root) => {
    const insert = jest.fn();
    // getById is used by create() to read the new record back for its return value.
    const service = new ShootsService(mockShoots({ insert, getById: jest.fn(() => shoot) }), mockPhotos(), mockLibs(root));
    const created = await service.create({ library_id: 'lib', name: 'Trip', ordering: 'taken_desc' });
    expect(created.folder_path).toBe('Trip');
    expect(existsSync(path.join(root, 'Trip'))).toBe(true);
    expect(insert).toHaveBeenCalled();
  }));

  it('throws CONFLICT when the name is taken', withRoot(async (root) => {
    const service = new ShootsService(mockShoots({ getByName: jest.fn(() => shoot) }), mockPhotos(), mockLibs(root));
    await expect(service.create({ library_id: 'lib', name: 'Trip', ordering: 'taken_desc' })).rejects.toThrow(/already used/);
  }));
});

describe('ShootsService.addPhotos', () => {
  it('is a no-op (no rename, no suffix) when the photo already sits in the shoot folder', withRoot(async (root) => {
    mkdirSync(path.join(root, 'Trip'), { recursive: true });
    writeFileSync(path.join(root, 'Trip', 'a.arw'), '');
    const setShoot = jest.fn();
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'Trip/a.arw', shoot_id: 'sh' }]),
      setShoot,
      setFilePathAndShoot,
    });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root));

    await service.addPhotos('sh', ['p1']);

    expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
    expect(existsSync(path.join(root, 'Trip', 'a_1.arw'))).toBe(false); // not mangled
    expect(setFilePathAndShoot).not.toHaveBeenCalled(); // no move
    expect(setShoot).not.toHaveBeenCalled(); // membership already correct
  }));

  it('moves a photo into the shoot folder and updates its path + shoot', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'a.arw', shoot_id: null }]),
      setFilePathAndShoot,
    });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root));

    await service.addPhotos('sh', ['p1']);

    expect(existsSync(path.join(root, 'a.arw'))).toBe(false);
    expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
    expect(setFilePathAndShoot).toHaveBeenCalledWith('p1', 'Trip/a.arw', 'sh');
  }));
});

describe('ShootsService.delete', () => {
  it('throws NOT_FOUND when the shoot is absent (and never touches disk)', () => {
    const service = new ShootsService(mockShoots({ delete: jest.fn(() => false) }), mockPhotos(), mockLibs('/x'));
    expect(() => service.delete('sh')).toThrow(AppError);
  });
});
