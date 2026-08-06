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

// Repository is a class with private state, so a structural double is cast once
// here (test-only) rather than standing up a real bun:sqlite DB under jest.
function mockRepo(overrides: Partial<LibrariesRepository> = {}): LibrariesRepository {
  return {
    insert: jest.fn(),
    getById: jest.fn(() => null),
    getByRootPath: jest.fn(() => null),
    list: jest.fn(() => []),
    delete: jest.fn(() => false),
    ...overrides,
  } as unknown as LibrariesRepository;
}

const sample: Library = { id: 'id-1', root_path: '/x', bin_name: 'Bin', name: 'lib', ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  include_subfolders: true, mirror_shoots: true, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };

describe('LibrariesService.get', () => {
  it('returns the library when present', () => {
    const service = new LibrariesService(mockRepo({ getById: jest.fn(() => sample) }));
    expect(service.get('id-1')).toEqual(sample);
  });

  it('throws NOT_FOUND when absent', () => {
    const service = new LibrariesService(mockRepo());
    expect(() => service.get('missing')).toThrow(AppError);
    expect(() => service.get('missing')).toThrow(/not found/);
  });
});

describe('LibrariesService.delete', () => {
  it('throws NOT_FOUND when nothing was deleted', () => {
    const service = new LibrariesService(mockRepo({ delete: jest.fn(() => false) }));
    expect(() => service.delete('missing')).toThrow(AppError);
  });

  it('succeeds when a row was deleted', () => {
    const service = new LibrariesService(mockRepo({ delete: jest.fn(() => true) }));
    expect(() => service.delete('id-1')).not.toThrow();
  });
});

describe('LibrariesService.create', () => {
  it('throws VALIDATION_ERROR when root_path is not a directory', async () => {
    const service = new LibrariesService(mockRepo());
    await expect(service.create({ root_path: '/definitely/not/here', bin_name: 'Bin', ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toThrow(
      /does not exist or is not a directory/,
    );
  });

  it('throws CONFLICT when the root is already registered', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const service = new LibrariesService(mockRepo({ getByRootPath: jest.fn(() => sample) }));
      await expect(service.create({ root_path: root, bin_name: 'Bin', ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toThrow(
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
      const service = new LibrariesService(mockRepo({ getByRootPath: jest.fn(() => null), insert }));
      await expect(service.create({ root_path: root, bin_name: 'Bin', ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inserts and creates the data directory on the happy path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      const service = new LibrariesService(mockRepo({ insert }));
      const library = await service.create({ root_path: root, bin_name: 'Bin', ordering: 'added_asc', include_subfolders: true, mirror_shoots: true });

      expect(library.root_path).toBe(root);
      expect(library.name).toBe(path.basename(root));
      expect(library.ordering).toBe('added_asc');
      expect(library.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(insert).toHaveBeenCalledWith(library);
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
      const service = new LibrariesService(mockRepo({ insert }));
      const library = await service.create({ root_path: root, bin_name: 'Bin', ordering: 'added_asc', include_subfolders: true, mirror_shoots: true });
      expect(library.name).toBe(`${path.basename(parent)} 2025`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('stores an explicit name when one is given', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      const service = new LibrariesService(mockRepo({ insert }));
      const library = await service.create({
        root_path: root,
        name: 'My Catalogue',
        bin_name: 'Bin',
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
      const service = new LibrariesService(mockRepo({ insert }));
      await expect(service.create({ root_path: root, bin_name: 'Bin', ordering: 'added_asc', include_subfolders: true, mirror_shoots: true })).rejects.toMatchObject(
        { code: 'VALIDATION_ERROR' },
      );

      const library = await service.create({ root_path: root, bin_name: 'Deleted', ordering: 'added_asc', include_subfolders: true, mirror_shoots: true });
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
      const service = new LibrariesService(mockRepo());
      await expect(
        service.create({ root_path: path.join(config.dataDir, 'nested'), bin_name: 'Bin', ordering: 'added_asc', include_subfolders: true, mirror_shoots: true }),
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

      const service = new LibrariesService(mockRepo({ getById: jest.fn(() => library), delete: jest.fn(() => true) }));
      await service.delete(library.id);

      expect(existsSync(data)).toBe(false);
      expect(readFileSync(path.join(root, 'a.arw'), 'utf8')).toBe('raw');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
