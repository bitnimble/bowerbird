import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import type { Library } from '../../../schemas/libraries';
import { fileRecipe } from '../../../schemas/recipes';
import type { Shoot } from '../../../schemas/shoots';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoStateRepository } from '../../photos/mutations/photo_state_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { FolderRulesRepository } from '../folder_rules_repository';
import { ShootsService } from '../shoots_service';
import type { ShootsRepository } from '../shoots_repository';

function mockShoots(over: Partial<ShootsRepository> = {}): ShootsRepository {
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
function mockRules(over: Partial<FolderRulesRepository> = {}): FolderRulesRepository {
  return {
    listByLibrary: jest.fn(() => []),
    pathsWithRule: jest.fn(() => new Set<string>()),
    set: jest.fn(),
    clear: jest.fn(() => false),
    ...over,
  } as unknown as FolderRulesRepository;
}
function mockPhotos(over: Partial<PhotoPathsRepository> = {}): PhotoPathsRepository {
  return {
    getBasicByIds: jest.fn(() => [] as BasicPhoto[]),
    listUnderFolder: jest.fn(() => [] as BasicPhoto[]),
    setShoot: jest.fn(),
    setFilePath: jest.fn(),
    setFilePathAndShoot: jest.fn(),
    ...over,
  } as unknown as PhotoPathsRepository;
}

function makeService(
  shoots: ShootsRepository,
  photoPaths: PhotoPathsRepository,
  libraries: LibrariesRepository,
  folderRules: FolderRulesRepository,
): ShootsService {
  const photoState = { refreshStacksUnderShoot: jest.fn() } as unknown as PhotoStateRepository;
  return new ShootsService(shoots, photoPaths, photoState, libraries, folderRules);
}
function library(root: string): Library {
  return { id: 'lib', root_path: root, bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  render_skip_full: [], render_skip_max: [],
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
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
  is_hidden: false,
  hidden_directly: false,
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
    const service = makeService(mockShoots({ insert, getById: jest.fn(() => shoot) }), mockPhotos(), mockLibs(root), mockRules());
    const created = await service.create({ library_id: 'lib', parent_path: '', name: 'Trip', ordering: 'taken_desc' });
    expect(created.folder_path).toBe('Trip');
    expect(existsSync(path.join(root, 'Trip'))).toBe(true);
    expect(insert).toHaveBeenCalled();
  }));

  it('nests the folder under parent_path and takes its parent from the shoot enclosing it', withRoot(async (root) => {
    const insert = jest.fn();
    const shoots = mockShoots({
      insert,
      getById: jest.fn(() => shoot),
      listByLibrary: jest.fn(() => [shoot, { ...shoot, id: 'other', folder_path: 'Elsewhere', name: 'Elsewhere' }]),
    });
    const service = makeService(shoots, mockPhotos(), mockLibs(root), mockRules());

    await service.create({ library_id: 'lib', parent_path: 'Trip/2024', name: 'Day1', ordering: 'taken_desc' });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ folder_path: 'Trip/2024/Day1', parent_id: 'sh' }));
    expect(existsSync(path.join(root, 'Trip', '2024', 'Day1'))).toBe(true);
  }));

  it('refuses a parent_path that climbs out of the library', withRoot(async (root) => {
    const service = makeService(mockShoots(), mockPhotos(), mockLibs(root), mockRules());
    await expect(
      service.create({ library_id: 'lib', parent_path: '../elsewhere', name: 'Trip', ordering: 'taken_desc' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }));

  // A hidden folder is configuration rather than photographs, and the scan never
  // walks one - so a shoot there would take its photos out of the library.
  it('refuses a shoot inside a hidden folder, which the scan never looks at', withRoot(async (root) => {
    const service = makeService(mockShoots(), mockPhotos(), mockLibs(root), mockRules());
    await expect(
      service.create({ library_id: 'lib', parent_path: '.cache', name: 'Trip', ordering: 'taken_desc' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }));

  it('throws CONFLICT when a shoot already covers the folder', withRoot(async (root) => {
    const service = makeService(mockShoots({ getByFolderPath: jest.fn(() => shoot) }), mockPhotos(), mockLibs(root), mockRules());
    await expect(service.create({ library_id: 'lib', parent_path: '', name: 'Trip', ordering: 'taken_desc' })).rejects.toThrow(/already covers/);
  }));

  it('takes the same name as an existing shoot in another folder', withRoot(async (root) => {
    const insert = jest.fn();
    const shoots = mockShoots({
      insert,
      getById: jest.fn(() => shoot),
      listByLibrary: jest.fn(() => [{ ...shoot, id: 'other', folder_path: 'LA/Day1', name: 'Day1' }]),
    });
    const service = makeService(shoots, mockPhotos(), mockLibs(root), mockRules());

    await service.create({ library_id: 'lib', parent_path: 'NYC', name: 'Day1', ordering: 'taken_desc' });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ folder_path: 'NYC/Day1', name: 'Day1' }));
  }));

  it('records the folder identity, so a rename before the first scan is still followed', withRoot(async (root) => {
    const insert = jest.fn();
    const service = makeService(mockShoots({ insert, getById: jest.fn(() => shoot) }), mockPhotos(), mockLibs(root), mockRules());

    await service.create({ library_id: 'lib', parent_path: '', name: 'Trip', ordering: 'taken_desc' });

    const [written] = insert.mock.calls[0] as [{ folder_ino: number | null }];
    expect(written.folder_ino).toBeGreaterThan(0);
  }));

  it('maps a UNIQUE violation lost to a create race to CONFLICT (not a raw 500)', withRoot(async (root) => {
    const insert = jest.fn(() => {
      throw Object.assign(new Error('UNIQUE constraint failed: shoots.folder_path'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    });
    const service = makeService(mockShoots({ insert }), mockPhotos(), mockLibs(root), mockRules());
    await expect(service.create({ library_id: 'lib', parent_path: '', name: 'Trip', ordering: 'taken_desc' })).rejects.toMatchObject({ code: 'CONFLICT' });
  }));
});

describe('ShootsService.update (banner)', () => {
  it('rejects a banner photo that does not exist (400, not a raw 500)', withRoot(async (root) => {
    const setBanner = jest.fn();
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot), setBanner }), mockPhotos(), mockLibs(root), mockRules());
    await expect(service.update('sh', { banner_photo_id: 'ghost' })).rejects.toThrow(/banner photo not found/);
    expect(setBanner).not.toHaveBeenCalled();
  }));

  it('rejects a banner photo from another library', withRoot(async (root) => {
    const setBanner = jest.fn();
    const photos = mockPhotos({ getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'other', shoot_id: null, recipe: fileRecipe('p1.arw') }]) });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot), setBanner }), photos, mockLibs(root), mockRules());
    await expect(service.update('sh', { banner_photo_id: 'p1' })).rejects.toThrow(/not in this shoot's library/);
    expect(setBanner).not.toHaveBeenCalled();
  }));

  it('sets a valid same-library banner and clears on null', withRoot(async (root) => {
    const setBanner = jest.fn();
    const photos = mockPhotos({ getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: null, recipe: fileRecipe('p1.arw') }]) });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot), setBanner }), photos, mockLibs(root), mockRules());
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
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: 'sh', recipe: fileRecipe('Trip/a.arw') }]),
      setShoot,
      setFilePathAndShoot,
    });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root), mockRules());

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
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: null, recipe: fileRecipe('a.arw') }]),
      setFilePathAndShoot,
    });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root), mockRules());

    await expect(service.addPhotos('sh', ['p1', 'ghost'])).rejects.toThrow(/photos not found/);
    expect(setFilePathAndShoot).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'a.arw'))).toBe(true); // nothing moved
  }));

  it('rejects a photo from another library before moving anything', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'other-lib', shoot_id: null, recipe: fileRecipe('a.arw') }]),
      setFilePathAndShoot,
    });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root), mockRules());

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
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: null, recipe: fileRecipe('a.arw') }]),
      setFilePath,
      setFilePathAndShoot,
    });
    const service = makeService(mockShoots({ getById }), photos, mockLibs(root), mockRules());

    await expect(service.addPhotos('sh', ['p1'])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(setFilePathAndShoot).not.toHaveBeenCalled();
    expect(setFilePath).toHaveBeenCalledWith('p1', 'Trip/a.arw'); // real location recorded, no desync
    expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
  }));

  it('moves a photo into the shoot folder and updates its path + shoot', withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.arw'), '');
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: null, recipe: fileRecipe('a.arw') }]),
      setFilePathAndShoot,
    });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root), mockRules());

    await service.addPhotos('sh', ['p1']);

    expect(existsSync(path.join(root, 'a.arw'))).toBe(false);
    expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
    expect(setFilePathAndShoot).toHaveBeenCalledWith('p1', 'Trip/a.arw', 'sh');
  }));
});

describe('ShootsService.delete', () => {
  it('throws NOT_FOUND when the shoot is absent (and never touches disk)', async () => {
    const service = makeService(mockShoots({ getById: jest.fn(() => null) }), mockPhotos(), mockLibs('/x'), mockRules());
    await expect(service.delete('sh', 'keep')).rejects.toThrow(AppError);
  });

  // Without the rule, mirroring recreates the shoot on the next sync and the
  // delete reads as broken.
  it('keeps the photos and marks the folder plain', async () => {
    const set = jest.fn();
    const deleteByIds = jest.fn();
    const service = makeService(
      mockShoots({ getById: jest.fn(() => shoot) }),
      mockPhotos({ deleteByIds }),
      mockLibs('/x'),
      mockRules({ set }),
    );

    await service.delete('sh', 'keep');

    expect(set).toHaveBeenCalledWith('lib', 'Trip', 'plain');
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it('excludes the folder and takes the photo records with it, soft-deleted rows included', async () => {
    const set = jest.fn();
    const deleteByIds = jest.fn();
    const listUnderFolder = jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: 'sh', recipe: fileRecipe('Trip/a.arw') }]);
    const service = makeService(
      mockShoots({ getById: jest.fn(() => shoot) }),
      mockPhotos({ listUnderFolder, deleteByIds }),
      mockLibs('/x'),
      mockRules({ set }),
    );

    await service.delete('sh', 'remove');

    expect(listUnderFolder).toHaveBeenCalledWith('lib', 'Trip', true);
    expect(set).toHaveBeenCalledWith('lib', 'Trip', 'excluded');
    expect(deleteByIds).toHaveBeenCalledWith(['p1']);
  });
});

describe('ShootsService.removePhotos', () => {
  it('moves the file back to the library root and clears shoot_id', withRoot(async (root) => {
    mkdirSync(path.join(root, 'Trip'), { recursive: true });
    writeFileSync(path.join(root, 'Trip', 'a.arw'), '');
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: 'sh', recipe: fileRecipe('Trip/a.arw') }]),
      setFilePathAndShoot,
    });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root), mockRules());

    await service.removePhotos('sh', ['p1']);

    expect(existsSync(path.join(root, 'a.arw'))).toBe(true);
    expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(false);
    expect(setFilePathAndShoot).toHaveBeenCalledWith('p1', 'a.arw', null);
  }));

  it('skips photos that are not in the shoot', withRoot(async (root) => {
    const setFilePathAndShoot = jest.fn();
    const photos = mockPhotos({
      getBasicByIds: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: 'other', recipe: fileRecipe('x.arw') }]),
      setFilePathAndShoot,
    });
    const service = makeService(mockShoots({ getById: jest.fn(() => shoot) }), photos, mockLibs(root), mockRules());
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
      getByFolderPath: jest.fn(() => null),
    listIdentities: jest.fn(() => []),
    setIdentity: jest.fn(),
      listByLibrary: jest.fn(() => [shoot, descendant]),
      updateFields,
    });
    const listUnderFolder = jest.fn(() => []);
    const photos = mockPhotos({ listUnderFolder, setFilePathAndShoot });
    const service = makeService(shoots, photos, mockLibs(root), mockRules());

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

  // The name is a label on a folder, and two folders may legitimately be called
  // the same thing (NYC/Day1 and LA/Day1).
  it('takes a name another shoot already uses', withRoot(async (root) => {
    const updateFields = jest.fn();
    const shoots = mockShoots({
      getById: jest.fn(() => shoot),
      listByLibrary: jest.fn(() => [{ ...shoot, id: 'other', folder_path: 'Elsewhere', name: 'Vacation' }]),
      updateFields,
    });
    const service = makeService(shoots, mockPhotos({}), mockLibs(root), mockRules());

    await service.update('sh', { name: 'Vacation' });

    expect(updateFields).toHaveBeenCalledWith('sh', expect.objectContaining({ name: 'Vacation' }));
  }));
});

// Hiding a shoot goes through the same PATCH a rename does, and it is the only route to it, so a
// field that stopped being passed through here would take the whole feature with it silently.
describe('ShootsService.update (hiding)', () => {
  it('hides and unhides through its own stamp rather than the shoot’s fields', withRoot(async (root) => {
    const setHidden = jest.fn();
    const updateFields = jest.fn();
    const shoots = mockShoots({ getById: jest.fn(() => shoot), setHidden, updateFields });
    const service = makeService(shoots, mockPhotos({}), mockLibs(root), mockRules());

    await service.update('sh', { is_hidden: true });
    expect(setHidden).toHaveBeenCalledWith('sh', true);

    // false is a value, not an absence: an `if (updates.is_hidden)` here would make unhiding a no-op.
    await service.update('sh', { is_hidden: false });
    expect(setHidden).toHaveBeenLastCalledWith('sh', false);
  }));

  it('leaves the flag alone when the request says nothing about it', withRoot(async (root) => {
    const setHidden = jest.fn();
    const shoots = mockShoots({ getById: jest.fn(() => shoot), setHidden });
    const service = makeService(shoots, mockPhotos({}), mockLibs(root), mockRules());

    await service.update('sh', { name: 'Vacation' });

    expect(setHidden).not.toHaveBeenCalled();
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
      getByFolderPath: jest.fn(() => null),
    listIdentities: jest.fn(() => []),
    setIdentity: jest.fn(),
      getById: jest.fn(() => shoot),
      listByLibrary: jest.fn(() => (insertedId ? [{ ...shoot, id: insertedId, folder_path: 'Existing', name: 'Existing' }] : [])),
    });
    const photos = mockPhotos({
      listUnderFolder: jest.fn(() => [{ id: 'p1', library_id: 'lib', shoot_id: null, recipe: fileRecipe('Existing/c.arw') }]),
      setShoot,
    });
    const service = makeService(shoots, photos, mockLibs(root), mockRules());

    await service.create({ library_id: 'lib', parent_path: '', name: 'Existing', ordering: 'taken_desc' });

    expect(setShoot).toHaveBeenCalledWith('p1', insertedId);
  }));
});
