import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

const sample: Library = { id: 'id-1', root_path: '/x', data_path: null, ordering: 'taken_desc', last_synced_at: null, photo_count: 0 };

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
    await expect(service.create({ root_path: '/definitely/not/here', ordering: 'taken_desc' })).rejects.toThrow(
      /does not exist or is not a directory/,
    );
  });

  it('throws CONFLICT when the root is already registered', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const service = new LibrariesService(mockRepo({ getByRootPath: jest.fn(() => sample) }));
      await expect(service.create({ root_path: root, ordering: 'taken_desc' })).rejects.toThrow(/already registered/);
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
      await expect(service.create({ root_path: root, ordering: 'taken_desc' })).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inserts and creates the data directory structure on the happy path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      const service = new LibrariesService(mockRepo({ insert }));
      const library = await service.create({ root_path: root, ordering: 'added_asc' });

      expect(library.root_path).toBe(root);
      expect(library.ordering).toBe('added_asc');
      expect(library.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(insert).toHaveBeenCalledWith(library);
      expect(existsSync(path.join(root, '.bowerbird', 'thumbnails', 'small'))).toBe(true);
      expect(existsSync(path.join(root, '.bowerbird', 'thumbnails', 'full'))).toBe(true);
      expect(existsSync(path.join(root, '.bowerbird', 'bin'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
