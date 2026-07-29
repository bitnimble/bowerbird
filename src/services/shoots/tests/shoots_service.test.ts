import { describe, it, expect, jest } from 'bun:test';
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
  return { id: 'lib', root_path: root, data_path: null, name: null, ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  rendition_hdr_video: false, last_synced_at: null, photo_count: 0 };
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
  photo_count: 0,
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

  it('maps a UNIQUE violation lost to a create race to CONFLICT (not a raw 500)', withRoot(async (root) => {
    const insert = jest.fn(() => {
      throw Object.assign(new Error('UNIQUE constraint failed: shoots.name'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    });
    const service = new ShootsService(mockShoots({ getByName: jest.fn(() => null), insert }), mockPhotos(), mockLibs(root));
    await expect(service.create({ library_id: 'lib', name: 'Trip', ordering: 'taken_desc' })).rejects.toMatchObject({ code: 'CONFLICT' });
  }));
});

describe('ShootsService.update (banner)', () => {
  it('rejects a banner photo that does not exist (400, not a raw 500)', withRoot(async (root) => {
    const setBanner = jest.fn();
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot), setBanner }), mockPhotos(), mockLibs(root));
    await expect(service.update('sh', { banner_photo_id: 'ghost' })).rejects.toThrow(/banner photo not found/);
    expect(setBanner).not.toHaveBeenCalled();
  }));

  it('rejects a banner photo from another library', withRoot(async (root) => {
    const setBanner = jest.fn();
    const photos = mockPhotos({ getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'other', file_path: 'p1.arw', shoot_id: null }]) });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot), setBanner }), photos, mockLibs(root));
    await expect(service.update('sh', { banner_photo_id: 'p1' })).rejects.toThrow(/not in this shoot's library/);
    expect(setBanner).not.toHaveBeenCalled();
  }));

  it('sets a valid same-library banner and clears on null', withRoot(async (root) => {
    const setBanner = jest.fn();
    const photos = mockPhotos({ getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'p1.arw', shoot_id: null }]) });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot), setBanner }), photos, mockLibs(root));
    await service.update('sh', { banner_photo_id: 'p1' });
    expect(setBanner).toHaveBeenCalledWith('sh', 'p1');
    await service.update('sh', { banner_photo_id: null });
    expect(setBanner).toHaveBeenCalledWith('sh', null);
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

  it('rejects an unknown/soft-deleted photo id (400) instead of silently dropping it', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      // 'ghost' is absent from the result (unknown or soft-deleted).
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'a.arw', shoot_id: null }]),
      setFilePathAndShoot,
    });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root));

    await expect(service.addPhotos('sh', ['p1', 'ghost'])).rejects.toThrow(/photos not found/);
    expect(setFilePathAndShoot).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'a.arw'))).toBe(true); // nothing moved
  }));

  it('rejects a photo from another library before moving anything', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'other-lib', file_path: 'a.arw', shoot_id: null }]),
      setFilePathAndShoot,
    });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root));

    await expect(service.addPhotos('sh', ['p1'])).rejects.toThrow(/not in this shoot's library/);
    expect(setFilePathAndShoot).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'a.arw'))).toBe(true); // untouched
  }));

  it('aborts with CONFLICT (not a raw FK 500) if the shoot is deleted mid-move, keeping DB consistent with disk', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    let calls = 0;
    const getById = jest.fn(() => (calls++ === 0 ? shoot : null)); // exists at entry, gone by the re-check
    const setFilePath = jest.fn();
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'a.arw', shoot_id: null }]),
      setFilePath,
      setFilePathAndShoot,
    });
    const service = new ShootsService(mockShoots({ getById }), photos, mockLibs(root));

    await expect(service.addPhotos('sh', ['p1'])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(setFilePathAndShoot).not.toHaveBeenCalled();
    expect(setFilePath).toHaveBeenCalledWith('p1', 'Trip/a.arw'); // real location recorded, no desync
    expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
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

describe('ShootsService.removePhotos', () => {
  it('moves the file back to the library root and clears shoot_id', withRoot(async (root) => {
    mkdirSync(path.join(root, 'Trip'), { recursive: true });
    writeFileSync(path.join(root, 'Trip', 'a.arw'), '');
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'Trip/a.arw', shoot_id: 'sh' }]),
      setFilePathAndShoot,
    });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root));

    await service.removePhotos('sh', ['p1']);

    expect(existsSync(path.join(root, 'a.arw'))).toBe(true);
    expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(false);
    expect(setFilePathAndShoot).toHaveBeenCalledWith('p1', 'a.arw', null);
  }));

  it('skips photos that are not in the shoot', withRoot(async (root) => {
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'x.arw', shoot_id: 'other' }]),
      setFilePathAndShoot,
    });
    const service = new ShootsService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root));
    await service.removePhotos('sh', ['p1']);
    expect(setFilePathAndShoot).not.toHaveBeenCalled();
  }));
});

describe('ShootsService.update (rename)', () => {
  it('renames the shoot without touching the folder, its descendants or any photo', withRoot(async (root) => {
    mkdirSync(path.join(root, 'Trip', 'Day1'), { recursive: true });
    const descendant: Shoot = { ...shoot, id: 'd1', parent_id: 'sh', folder_path: 'Trip/Day1', name: 'Day1' };
    const updateFields = jest.fn();
    const setFilePathAndShoot = jest.fn();
    const shoots = mockShoots({
      getById: jest.fn(() => shoot),
      getByName: jest.fn(() => null),
      listByLibrary: jest.fn(() => [shoot, descendant]),
      updateFields,
    });
    const listUnderFolder = jest.fn(() => []);
    const photos = mockPhotos({ listUnderFolder, setFilePathAndShoot });
    const service = new ShootsService(shoots, photos, mockLibs(root));

    await service.update('sh', { name: 'Vacation' });

    // The name is a label: the folder keeps the name it was created with.
    expect(existsSync(path.join(root, 'Trip'))).toBe(true);
    expect(existsSync(path.join(root, 'Vacation'))).toBe(false);
    expect(updateFields).toHaveBeenCalledWith('sh', { name: 'Vacation' });
    // No folder moved, so nothing downstream of a path can have changed.
    expect(updateFields).not.toHaveBeenCalledWith('d1', expect.anything());
    expect(setFilePathAndShoot).not.toHaveBeenCalled();
    expect(listUnderFolder).not.toHaveBeenCalled();
  }));

  it('still rejects a name already used in the library', withRoot(async (root) => {
    const shoots = mockShoots({
      getById: jest.fn(() => shoot),
      getByName: jest.fn(() => ({ ...shoot, id: 'other', name: 'Vacation' })),
    });
    const service = new ShootsService(shoots, mockPhotos({}), mockLibs(root));

    await expect(service.update('sh', { name: 'Vacation' })).rejects.toMatchObject({ code: 'CONFLICT' });
  }));
});

describe('ShootsService.create (adoption)', () => {
  it('adopts photos already under a pre-existing folder', withRoot(async (root) => {
    mkdirSync(path.join(root, 'Existing'), { recursive: true });
    let insertedId = '';
    const insert = jest.fn((s: { id: string }) => {
      insertedId = s.id;
    });
    const setShoot = jest.fn();
    const shoots = mockShoots({
      insert,
      getByName: jest.fn(() => null),
      getById: jest.fn(() => shoot),
      listByLibrary: jest.fn(() => (insertedId ? [{ ...shoot, id: insertedId, folder_path: 'Existing', name: 'Existing' }] : [])),
    });
    const photos = mockPhotos({
      listUnderFolder: jest.fn(() => [{ id: 'p1', library_id: 'lib', file_path: 'Existing/c.arw', shoot_id: null }]),
      setShoot,
    });
    const service = new ShootsService(shoots, photos, mockLibs(root));

    await service.create({ library_id: 'lib', name: 'Existing', ordering: 'taken_desc' });

    expect(setShoot).toHaveBeenCalledWith('p1', insertedId);
  }));
});
