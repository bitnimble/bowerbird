import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../../errors';
import type { Library } from '../../../../schemas/libraries';
import type { PhotoDetail } from '../../../../schemas/photos';
import { fileRecipe } from '../../../../schemas/recipes';
import type { LibrariesRepository } from '../../../libraries/libraries_repository';
import { config } from '../../../../config';
import type { PhotoReadService } from '../../listing/photo_read_service';
import type { PhotoPathsRepository } from '../../paths/photo_paths_repository';
import { PhotoMutationService } from '../photo_mutation_service';
import type { PhotoStateRepository } from '../photo_state_repository';

function build(over: {
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
const detail = { id: 'p1', file_path: 'a.arw', recipe: fileRecipe('a.arw') } as PhotoDetail;

describe('PhotoMutationService.delete', () => {
  it('moves the RAW into the library Bin, flags is_deleted, and keeps the renditions', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const dataDir = path.join(config.dataDir, 'photos-delete');
    try {
      mkdirSync(path.join(dataDir, 'renditions', 'grid'), { recursive: true });
      mkdirSync(path.join(dataDir, 'renditions', 'full'), { recursive: true });
      writeFileSync(path.join(root, 'a.arw'), '');
      writeFileSync(path.join(dataDir, 'renditions', 'grid', 'p1.avif'), '');
      writeFileSync(path.join(dataDir, 'renditions', 'full', 'p1.avif'), '');

      const lib: Library = { id: 'photos-delete', root_path: root, bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  render_skip_full: [], render_skip_max: [], render_timings: {},
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
      const markDeleted = jest.fn();
      // getBasicByIds, not getById: the delete reads the four columns it needs
      // for a whole batch rather than a detail payload per photo (§12.1).
      const photo = { id: 'p1', library_id: 'photos-delete', shoot_id: null, recipe: fileRecipe('a.arw') };
      const { service } = build({
        photoPaths: { getBasicByIds: jest.fn(() => [photo]), markDeleted },
        libraries: { getById: jest.fn(() => lib) },
      });

      await service.delete(['p1'], 'batch-1');

      expect(existsSync(path.join(root, 'a.arw'))).toBe(false);
      expect(existsSync(path.join(root, 'Bin', 'a.arw'))).toBe(true);
      // Kept, not deleted: the Bin is browsable and restorable only if the
      // binned photos can still be seen. Under the library's real data directory,
      // or this asserts that a path nothing writes to still holds what the test
      // put there (§6).
      expect(existsSync(path.join(dataDir, 'renditions', 'grid', 'p1.avif'))).toBe(true);
      expect(existsSync(path.join(dataDir, 'renditions', 'full', 'p1.avif'))).toBe(true);
      // The pre-delete path is recorded so restore can put the file back there,
      // and the batch so an undo can name this one bin rather than every id.
      expect(markDeleted).toHaveBeenCalledWith('p1', 'a.arw', 'batch-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // One bin at the library root, laid out inside itself like the folders it took
  // the photographs from (§12.3), so what is in it can be read without the
  // catalogue and two files of the same name from different folders cannot meet.
  it('mirrors the folder a photo was binned from inside the one root Bin', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-mirror-'));
    try {
      mkdirSync(path.join(root, 'A', 'B', 'C'), { recursive: true });
      mkdirSync(path.join(root, 'D'), { recursive: true });
      writeFileSync(path.join(root, 'A', 'B', 'C', 'foo.arw'), 'deep');
      writeFileSync(path.join(root, 'D', 'foo.arw'), 'shallow');
      writeFileSync(path.join(root, 'foo.arw'), 'root');

      const lib: Library = { id: 'lib', root_path: root, bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  render_skip_full: [], render_skip_max: [], render_timings: {},
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
      const markDeleted = jest.fn();
      const setFilePath = jest.fn();
      const rows = [
        { id: 'p1', library_id: 'lib', shoot_id: 'sh', recipe: fileRecipe('A/B/C/foo.arw') },
        { id: 'p2', library_id: 'lib', shoot_id: null, recipe: fileRecipe('D/foo.arw') },
        { id: 'p3', library_id: 'lib', shoot_id: null, recipe: fileRecipe('foo.arw') },
      ];
      const { service } = build({
        photoPaths: { getBasicByIds: jest.fn(() => rows), markDeleted, setFilePath },
        libraries: { getById: jest.fn(() => lib) },
      });

      await service.delete(['p1', 'p2', 'p3']);

      // No bin inside the shoot folder, and the three same-named files sit apart.
      expect(existsSync(path.join(root, 'A', 'B', 'C', 'Bin'))).toBe(false);
      expect(readFileSync(path.join(root, 'Bin', 'A', 'B', 'C', 'foo.arw'), 'utf8')).toBe('deep');
      expect(readFileSync(path.join(root, 'Bin', 'D', 'foo.arw'), 'utf8')).toBe('shallow');
      expect(readFileSync(path.join(root, 'Bin', 'foo.arw'), 'utf8')).toBe('root');
      expect(setFilePath).toHaveBeenCalledWith('p1', 'Bin/A/B/C/foo.arw');
      // Where restore puts it back, which is the folder it came from and not the bin.
      expect(markDeleted).toHaveBeenCalledWith('p1', 'A/B/C/foo.arw', undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls the Bin move back to the original path when the DB write fails', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-del-'));
    try {
      writeFileSync(path.join(root, 'a.arw'), 'raw');
      const lib: Library = { id: 'lib', root_path: root, bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  render_skip_full: [], render_skip_max: [], render_timings: {},
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
      const photo = { id: 'p1', library_id: 'lib', shoot_id: null, recipe: fileRecipe('a.arw') };
      const { service } = build({
        photoPaths: {
          getBasicByIds: jest.fn(() => [photo]),
          transaction: () => {
            throw new Error('SQLITE_FULL: database or disk is full');
          },
        },
        libraries: { getById: jest.fn(() => lib) },
      });

      await expect(service.delete(['p1'])).rejects.toThrow(/failed to delete/);

      // File is back at its original path, not orphaned in the (unscanned) Bin.
      expect(existsSync(path.join(root, 'a.arw'))).toBe(true);
      expect(existsSync(path.join(root, 'Bin', 'a.arw'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // getBasicByIds excludes them, which is how a photo already in the Bin is
  // skipped without a per-photo check.
  it('skips already-deleted photos', async () => {
    const markDeleted = jest.fn();
    const { service } = build({ photoPaths: { getBasicByIds: jest.fn(() => []), markDeleted } });
    await service.delete(['p1']);
    expect(markDeleted).not.toHaveBeenCalled();
  });

  // The whole batch shares one lock, one library lookup and one commit per
  // chunk; per photo it was a join, a second query for album membership it never
  // reads, a lock and a transaction each.
  it('reads the rows and commits the flags once for the batch, not once per photo', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-batch-'));
    try {
      const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
      for (const id of ids) writeFileSync(path.join(root, `${id}.arw`), '');
      const lib: Library = {
        id: 'lib',
        root_path: root,
        bin_name: 'Bin',
        read_only: false,
        name: 'lib',
        ordering: 'added_asc',
        rendition_source: 'embedded' as const,
        rendition_hdr: false,
        render_skip_full: [],
        render_skip_max: [],
        render_timings: {},
        include_subfolders: true,
        include_non_raw: false,
        auto_stack: true,
        auto_stack_similarity: 0.78,
        auto_stack_window_seconds: 60,
        last_synced_at: null,
        photo_count: 0,
      };
      const getBasicByIds = jest.fn(() => ids.map((id) => ({ id, library_id: 'lib', shoot_id: null, recipe: fileRecipe(`${id}.arw`) })));
      // Counted by hand: jest.fn erases the generic the repository declares.
      let commits = 0;
      const transaction = <T,>(fn: () => T): T => {
        commits++;
        return fn();
      };
      const get = jest.fn();
      const markDeleted = jest.fn();
      const { service } = build({
        photoPaths: { getBasicByIds, transaction, markDeleted },
        read: { get },
        libraries: { getById: jest.fn(() => lib) },
      });

      await service.delete(ids);

      expect(getBasicByIds).toHaveBeenCalledTimes(1);
      expect(commits).toBe(1);
      expect(get).not.toHaveBeenCalled();
      expect(markDeleted).toHaveBeenCalledTimes(40);
      for (const id of ids) expect(existsSync(path.join(root, 'Bin', `${id}.arw`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PhotoMutationService.update', () => {
  it('throws NOT_FOUND when nothing was updated', () => {
    const { service } = build({ photoState: { update: jest.fn(() => false) } });
    expect(() => service.update('p1', { rating: 5 })).toThrow(AppError);
  });
  it('returns the refreshed detail on success', () => {
    const { service } = build({ photoState: { update: jest.fn(() => true) }, read: { get: jest.fn(() => detail) } });
    expect(service.update('p1', { rating: 5 })).toMatchObject(detail);
  });
});

// The one route to hiding a selection, and it writes a stamp of its own - so it goes through
// `setHidden` rather than the verdict's `updateMany`, and nothing else may answer for it (§12.4).
describe('PhotoMutationService.hide', () => {
  it('hands the ids and the direction to setHidden, and answers with the count', () => {
    const setHidden = jest.fn(() => 2);
    const updateMany = jest.fn(() => 0);
    const { service } = build({ photoState: { setHidden, updateMany } });

    expect(service.hide(['p1', 'p2'], true)).toBe(2);
    expect(setHidden).toHaveBeenCalledWith(['p1', 'p2'], true);
    expect(updateMany).not.toHaveBeenCalled();

    service.hide(['p1'], false);
    expect(setHidden).toHaveBeenLastCalledWith(['p1'], false);
  });
});
