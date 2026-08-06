import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import { config } from '../../../config';
import type { Library } from '../../../schemas/libraries';
import { renditionDirs } from '../../processing/renditions';
import { containsPath, getDataPath } from '../../../utils/paths';
import { assertNoDataDirectoryOverlap, LibrariesService } from '../libraries_service';
import type { LibrariesRepository } from '../libraries_repository';
import type { PhotosRepository } from '../../photos/photos_repository';

// Repository is a class with private state, so a structural double is cast once
// here (test-only) rather than standing up a real bun:sqlite DB under jest.
function mockRepo(overrides: Partial<LibrariesRepository> = {}): LibrariesRepository {
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
const noPhotos = { transaction: (fn: () => void) => fn(), rewriteBinnedPathPrefix: jest.fn() } as unknown as PhotosRepository;

function build(repo: LibrariesRepository): LibrariesService {
  return new LibrariesService(repo, noPhotos);
}

const sample: Library = { id: 'id-1', root_path: '/x', bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  include_subfolders: true, mirror_shoots: true, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };

describe('LibrariesService.get', () => {
  it('returns the library when present', () => {
    const service = build(mockRepo({ getById: jest.fn(() => sample) }));
    expect(service.get('id-1')).toEqual(sample);
  });

  it('throws NOT_FOUND when absent', () => {
    const service = build(mockRepo());
    expect(() => service.get('missing')).toThrow(AppError);
    expect(() => service.get('missing')).toThrow(/not found/);
  });
});

describe('LibrariesService.delete', () => {
  it('throws NOT_FOUND when nothing was deleted', () => {
    const service = build(mockRepo({ delete: jest.fn(() => false) }));
    expect(() => service.delete('missing')).toThrow(AppError);
  });

  it('succeeds when a row was deleted', () => {
    const service = build(mockRepo({ delete: jest.fn(() => true) }));
    expect(() => service.delete('id-1')).not.toThrow();
  });
});

describe('LibrariesService.create', () => {
  it('throws VALIDATION_ERROR when root_path is not a directory', async () => {
    const service = build(mockRepo());
    await expect(service.create({ root_path: '/definitely/not/here', bin_name: 'Bin', read_only: false, ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toThrow(
      /does not exist or is not a directory/,
    );
  });

  it('throws CONFLICT when the root is already registered', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const service = build(mockRepo({ getByRootPath: jest.fn(() => sample) }));
      await expect(service.create({ root_path: root, bin_name: 'Bin', read_only: false, ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toThrow(
        /already registered/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps a UNIQUE violation lost to a create race to CONFLICT (not a raw 500)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn(() => {
      throw Object.assign(new Error('UNIQUE constraint failed: libraries.root_path'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    });
    try {
      const service = build(mockRepo({ getByRootPath: jest.fn(() => null), insert }));
      await expect(service.create({ root_path: root, bin_name: 'Bin', read_only: false, ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      // A bin left behind by a failed insert is refused by the "already exists"
      // check next time, so the library could never be created with that name.
      expect(existsSync(path.join(root, 'Bin'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The one combination the columns must never hold: a writable library with no
  // bin bins in place, silently, for a photographer who was shown a bin-name
  // field - and `update` cannot repair it, since the flag is already false.
  it('refuses a writable library with no bin name', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-nobin-'));
    try {
      const service = build(mockRepo());
      await expect(
        service.create({ root_path: root, bin_name: null, read_only: false, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes no bin folder for a read-only library, whatever bin_name was sent', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-ro-'));
    const insert = jest.fn();
    try {
      const service = build(mockRepo({ insert }));
      const library = await service.create({
        root_path: root,
        bin_name: 'Bin',
        read_only: true,
        ordering: 'added_asc',
        include_subfolders: true,
        mirror_shoots: true,
      });
      expect(library.bin_name).toBeNull();
      expect(existsSync(path.join(root, 'Bin'))).toBe(false);
      rmSync(getDataPath(library), { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inserts and creates the data directory on the happy path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      const service = build(mockRepo({ insert }));
      const library = await service.create({ root_path: root, bin_name: 'Bin', read_only: false, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true });

      expect(library.root_path).toBe(root);
      expect(library.name).toBe(path.basename(root));
      expect(library.ordering).toBe('added_asc');
      expect(library.id).toMatch(/^[0-9a-f-]{36}$/);
      // The bin folder's identity rides into the INSERT, since the row it would
      // otherwise be written to does not exist yet (§2.3).
      expect(insert).toHaveBeenCalledWith({ ...library, identity: expect.objectContaining({ ino: expect.any(Number) }) });
      // The bin exists from the moment the library does.
      expect(existsSync(path.join(root, 'Bin'))).toBe(true);
      // Outside the root, keyed by library id, with every rendition directory
      // made up front rather than lazily by a writer (§3).
      const data = getDataPath(library);
      expect(containsPath(root, data)).toBe(false);
      for (const dir of renditionDirs()) expect(existsSync(path.join(data, 'renditions', dir))).toBe(true);
      rmSync(data, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores an inferred name that includes the parent when the root is a year', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'bb-trip-'));
    const root = path.join(parent, '2025');
    mkdirSync(root);
    const insert = jest.fn();
    try {
      const service = build(mockRepo({ insert }));
      const library = await service.create({ root_path: root, bin_name: 'Bin', read_only: false, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true });
      expect(library.name).toBe(`${path.basename(parent)} 2025`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('stores an explicit name when one is given', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      const service = build(mockRepo({ insert }));
      const library = await service.create({
        root_path: root,
        name: 'My Catalogue',
        bin_name: 'Bin',
        read_only: false,
        ordering: 'added_asc',
        include_subfolders: true,
        mirror_shoots: true,
      });
      expect(library.name).toBe('My Catalogue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Adopting the folder would exclude it from every scan, so whatever the user
  // keeps in it would never be imported and nothing would say so.
  it('refuses a root that already holds a folder of the bin name, and takes another name', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      mkdirSync(path.join(root, 'Bin'));
      const service = build(mockRepo({ insert }));
      await expect(service.create({ root_path: root, bin_name: 'Bin', read_only: false, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true })).rejects.toMatchObject(
        { code: 'VALIDATION_ERROR' },
      );

      const library = await service.create({ root_path: root, bin_name: 'Deleted', read_only: false, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true });
      expect(library.bin_name).toBe('Deleted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Removing a library deletes its whole data directory, so a root inside
  // DATA_DIR is the overlap that loses photographs.
  it('refuses a root that overlaps DATA_DIR, in either direction', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      mkdirSync(path.join(config.dataDir, 'nested'), { recursive: true });
      const service = build(mockRepo());
      await expect(
        service.create({ root_path: path.join(config.dataDir, 'nested'), bin_name: 'Bin', read_only: false, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true }),
      ).rejects.toThrow(/inside DATA_DIR/);

      expect(() => assertNoDataDirectoryOverlap(path.dirname(config.dataDir))).toThrow(/is inside library root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('LibrariesService.delete, on disk', () => {
  it('removes the library data directory and nothing under the root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const library: Library = { ...sample, root_path: root };
      const data = getDataPath(library);
      mkdirSync(path.join(data, 'renditions', 'grid'), { recursive: true });
      writeFileSync(path.join(data, 'renditions', 'grid', 'p1.avif'), '');
      writeFileSync(path.join(root, 'a.arw'), 'raw');

      const service = build(mockRepo({ getById: jest.fn(() => library), delete: jest.fn(() => true) }));
      await service.delete(library.id);

      expect(existsSync(data)).toBe(false);
      expect(readFileSync(path.join(root, 'a.arw'), 'utf8')).toBe('raw');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
