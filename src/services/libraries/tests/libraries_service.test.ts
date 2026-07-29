import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import type { Library } from '../../../schemas/libraries';
import { LibrariesService } from '../libraries_service';
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

const sample: Library = { id: 'id-1', root_path: '/x', data_path: null, name: null, ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  rendition_hdr_video: false, include_subfolders: true, mirror_shoots: true, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };

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
    await expect(service.create({ root_path: '/definitely/not/here', ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toThrow(
      /does not exist or is not a directory/,
    );
  });

  it('throws CONFLICT when the root is already registered', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const service = new LibrariesService(mockRepo({ getByRootPath: jest.fn(() => sample) }));
      await expect(service.create({ root_path: root, ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toThrow(/already registered/);
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
      await expect(service.create({ root_path: root, ordering: 'taken_desc', include_subfolders: true, mirror_shoots: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inserts and creates the data directory on the happy path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      const service = new LibrariesService(mockRepo({ insert }));
      const library = await service.create({ root_path: root, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true });

      expect(library.root_path).toBe(root);
      expect(library.ordering).toBe('added_asc');
      expect(library.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(insert).toHaveBeenCalledWith(library);
      expect(existsSync(path.join(root, '.bowerbird'))).toBe(true);
      // The Bin holds originals, so it is never made under the data directory.
      expect(existsSync(path.join(root, '.bowerbird', 'bin'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Removing a library deletes its whole data directory, so an overlap in either
  // direction would put one library's photographs inside another's disposable tree.
  it('refuses a root inside another library data directory, and a data_path holding another root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const existing: Library = { ...sample, root_path: path.join(root, 'other'), data_path: path.join(root, 'shared') };
      const service = new LibrariesService(mockRepo({ list: jest.fn(() => [existing]) }));

      mkdirSync(path.join(root, 'shared', 'nested'), { recursive: true });
      await expect(service.create({ root_path: path.join(root, 'shared', 'nested'), ordering: 'added_asc', include_subfolders: true, mirror_shoots: true })).rejects.toThrow(
        /inside the data directory of library/,
      );

      mkdirSync(path.join(root, 'other'), { recursive: true });
      await expect(
        service.create({ root_path: path.join(root, 'other'), data_path: root, ordering: 'added_asc', include_subfolders: true, mirror_shoots: true }),
      ).rejects.toThrow(/would contain the root of library/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('LibrariesService.delete, on disk', () => {
  it('carries originals out of the data directory into the Bin before removing it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const library: Library = { ...sample, root_path: root };
      mkdirSync(path.join(root, '.bowerbird', 'bin'), { recursive: true }); // the pre-move layout
      mkdirSync(path.join(root, '.bowerbird', 'renditions', 'grid'), { recursive: true });
      writeFileSync(path.join(root, '.bowerbird', 'bin', 'a.arw'), 'raw');
      writeFileSync(path.join(root, '.bowerbird', 'renditions', 'grid', 'p1.avif'), '');

      const service = new LibrariesService(mockRepo({ getById: jest.fn(() => library), delete: jest.fn(() => true) }));
      await service.delete(library.id);

      expect(existsSync(path.join(root, '.bowerbird'))).toBe(false);
      expect(readFileSync(path.join(root, 'Bin', 'a.arw'), 'utf8')).toBe('raw');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
