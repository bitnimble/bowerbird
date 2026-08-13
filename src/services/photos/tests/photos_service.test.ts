import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import type { Album } from '../../../schemas/albums';
import type { Library } from '../../../schemas/libraries';
import type { PhotoDetail } from '../../../schemas/photos';
import type { Shoot } from '../../../schemas/shoots';
import type { AlbumsRepository } from '../../albums/albums_repository';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { ProcessingService } from '../../processing/processing_service';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import { config } from '../../../config';
import { getDataPath } from '../../../utils/paths';
import { PhotosService } from '../photos_service';
import type { PhotoListResult, PhotosRepository } from '../photos_repository';

const emptyResult: PhotoListResult = { photos: [], total: 0 };

function build(over: {
  photos?: Partial<PhotosRepository>;
  libraries?: Partial<LibrariesRepository>;
  shoots?: Partial<ShootsRepository>;
  albums?: Partial<AlbumsRepository>;
  processing?: Partial<ProcessingService>;
}) {
  const photos = {
    getById: jest.fn(() => null),
    listByLibrary: jest.fn(() => emptyResult),
    listByShoot: jest.fn(() => emptyResult),
    listByAlbum: jest.fn(() => emptyResult),
    update: jest.fn(() => true),
    setFilePath: jest.fn(),
    markDeleted: jest.fn(),
    transaction: (fn: () => unknown) => fn(),
    ...over.photos,
  } as unknown as PhotosRepository;
  const libraries = { getById: jest.fn(() => null), setBinIdentity: jest.fn(), ...over.libraries } as unknown as LibrariesRepository;
  const shoots = { getById: jest.fn(() => null), ...over.shoots } as unknown as ShootsRepository;
  const albums = { getById: jest.fn(() => null), getAlbumIdsForPhoto: jest.fn(() => []), ...over.albums } as unknown as AlbumsRepository;
  // These tests never render, so a stub keeps the native library and worker threads out.
  const processing = {
    renderLossless: jest.fn(async () => {}),
    renderOne: jest.fn(async () => {}),
    ...over.processing,
  } as unknown as ProcessingService;
  return { service: new PhotosService(photos, albums, shoots, libraries, processing), photos, libraries, shoots, albums, processing };
}

const library: Library = { id: 'lib', root_path: '/r', bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  include_subfolders: true, mirror_shoots: true, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
const shoot: Shoot = { id: 'sh', parent_id: null, library_id: 'lib', folder_path: 'Trip', name: 'Trip', description: null, banner_photo_id: null, ordering: 'taken_asc', photo_count: 0 };
const album: Album = { id: 'al', name: 'Faves', ordering: 'taken_desc', banner_photo_id: null, photo_count: 0 };
const detail = { id: 'p1', file_path: 'a.arw' } as PhotoDetail;

describe('PhotosService.get', () => {
  it('throws NOT_FOUND when the photo is absent', () => {
    const { service } = build({});
    expect(() => service.get('p1')).toThrow(AppError);
  });
  it('returns the detail when present', () => {
    const { service } = build({ photos: { getById: jest.fn(() => detail) } });
    // Not toBe: get() decorates the row with rendition state the repository
    // cannot answer, so it is a new object rather than the row itself.
    expect(service.get('p1')).toMatchObject(detail);
  });

  // A wiped cache leaves the grid showing holes nothing ever fills: the queue
  // only visits photos flagged for processing. Opening one is when it is noticed.
  it('rebuilds a missing grid tile in the background, from the source the import used', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-tile-'));
    // Its own id, because the tile the third assertion puts on disk has to land
    // where the service looks for it - under DATA_DIR, keyed by library id (§6).
    const lib = { ...library, id: 'photos-tile', root_path: root, rendition_source: 'render' as const };
    const data = getDataPath(lib);
    try {
      writeFileSync(path.join(root, 'a.arw'), 'raw');
      const photo = { ...detail, rendition_source: 'embedded' } as PhotoDetail;
      const { service, processing } = build({
        photos: { getById: jest.fn(() => photo) },
        libraries: { getById: jest.fn(() => lib) },
      });

      service.get('p1');
      // The photo's own source wins over the library's: it is what the tile
      // beside it in the grid was built from.
      expect(processing.renderOne).toHaveBeenCalledWith(path.join(root, 'a.arw'), 'p1', lib, 'grid', false, 'embedded');

      // Only once while the first is still in flight, and never once it is there.
      service.get('p1');
      expect(processing.renderOne).toHaveBeenCalledTimes(1);
      // A macrotask, not one microtask: the in-flight set is cleared in the
      // `.finally()` of a chain three ticks long, so yielding once leaves the
      // guard still holding and the tile-exists check below unexercised.
      await new Promise((resolve) => setTimeout(resolve, 0));
      mkdirSync(path.join(data, 'renditions', 'grid'), { recursive: true });
      writeFileSync(path.join(data, 'renditions', 'grid', 'p1.avif'), 'tile');
      // The in-flight guard has cleared by now, so a third `get` would ask again
      // if the tile on disk were not what stops it.
      service.get('p1');
      expect(processing.renderOne).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('PhotosService.resolve', () => {
  const selection = (over: Partial<{ ranges: { start: number; end: number }[]; members: string[] }> = {}) => ({
    selection: {
      scope: { kind: 'library' as const, id: 'lib' },
      filters: {},
      ranges: [{ start: 0, end: 1 }],
      members: [],
      ...over,
    },
  });

  it('resolves the runs against the collection ordering', () => {
    const idsInLibrary = jest.fn(() => ['a', 'b']);
    const { service, photos } = build({ photos: { idsInLibrary }, libraries: { getById: jest.fn(() => library) } });
    expect(service.resolve(selection())).toEqual(['a', 'b']);
    expect(photos.idsInLibrary).toHaveBeenCalledWith('lib', 'added_asc', [{ start: 0, end: 1 }], expect.anything());
  });

  // A photo picked out of an open stack has no position in a collapsed listing
  // (§19.6.1), so it travels by id beside the runs - and a stack row named by a
  // run resolves to every member, so the two can name the same photo.
  it('adds the members to the runs, each photo once', () => {
    const idsInLibrary = jest.fn(() => ['a', 'b']);
    const { service } = build({ photos: { idsInLibrary }, libraries: { getById: jest.fn(() => library) } });
    expect(service.resolve(selection({ members: ['b', 'c'] }))).toEqual(['a', 'b', 'c']);
  });

  it('asks the collection nothing when the selection is members alone', () => {
    const idsInLibrary = jest.fn(() => ['a']);
    const { service, photos } = build({ photos: { idsInLibrary }, libraries: { getById: jest.fn(() => library) } });
    expect(service.resolve(selection({ ranges: [], members: ['c'] }))).toEqual(['c']);
    expect(photos.idsInLibrary).not.toHaveBeenCalled();
  });
});

describe('PhotosService.listByLibrary', () => {
  it('throws NOT_FOUND for an unknown library', () => {
    const { service } = build({});
    expect(() => service.listByLibrary('lib', { offset: 0, limit: 100, include_deleted: false })).toThrow(/library not found/);
  });

  it("orders by the library's ordering and echoes pagination", () => {
    const { service, photos } = build({ libraries: { getById: jest.fn(() => library) } });
    const res = service.listByLibrary('lib', { offset: 5, limit: 10, include_deleted: false, is_missing: true });
    expect(photos.listByLibrary).toHaveBeenCalledWith('lib', 'added_asc', 5, 10, {
      includeDeleted: false,
      isMissing: true,
      needsTile: undefined,
    });
    // The ordering it actually sorted by travels back with the page, so a client
    // never has to hold its own copy of what the sort is (§18.3.1).
    expect(res).toEqual({ photos: [], total: 0, offset: 5, limit: 10, ordering: 'added_asc' });
  });
});

describe('PhotosService.listMissing', () => {
  it('delegates to listByLibrary with is_missing=true', () => {
    const { service, photos } = build({ libraries: { getById: jest.fn(() => library) } });
    service.listMissing('lib', { offset: 0, limit: 100, include_deleted: false });
    expect(photos.listByLibrary).toHaveBeenCalledWith('lib', 'added_asc', 0, 100, {
      includeDeleted: false,
      isMissing: true,
      needsTile: undefined,
    });
  });

  // It takes the whole listing query, not just pagination. A client acting on a
  // selection made in this view states the filters it was viewing under
  // (§18.3.3), so filters dropped here would resolve a different set of photos
  // than the grid ever showed.
  it('carries the rest of the filters through', () => {
    const { service, photos } = build({ libraries: { getById: jest.fn(() => library) } });
    service.listMissing('lib', { offset: 0, limit: 100, include_deleted: false, rated: true, triage: ['picked'], q: 'DSC' });
    expect(photos.listByLibrary).toHaveBeenCalledWith(
      'lib',
      'added_asc',
      0,
      100,
      expect.objectContaining({ isMissing: true, rated: true, triage: ['picked'], search: 'DSC' }),
    );
  });
});

describe('PhotosService scoped listing uses the owner ordering', () => {
  it('listByShoot uses shoot ordering (NOT_FOUND when absent)', () => {
    const missing = build({});
    expect(() => missing.service.listByShoot('sh', { offset: 0, limit: 100, include_deleted: false })).toThrow(/shoot not found/);
    const { service, photos } = build({ shoots: { getById: jest.fn(() => shoot) } });
    service.listByShoot('sh', { offset: 0, limit: 100, include_deleted: false });
    expect(photos.listByShoot).toHaveBeenCalledWith('sh', 'taken_asc', 0, 100, { includeDeleted: false });
  });

  it('listByAlbum uses album ordering (NOT_FOUND when absent)', () => {
    const missing = build({});
    expect(() => missing.service.listByAlbum('al', { offset: 0, limit: 100, include_deleted: false })).toThrow(/album not found/);
    const { service, photos } = build({ albums: { getById: jest.fn(() => album), getAlbumIdsForPhoto: jest.fn(() => []) } });
    service.listByAlbum('al', { offset: 0, limit: 100, include_deleted: false });
    expect(photos.listByAlbum).toHaveBeenCalledWith('al', 'taken_desc', 0, 100, { includeDeleted: false });
  });
});

describe('PhotosService.delete', () => {
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
  include_subfolders: true, mirror_shoots: true, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
      const markDeleted = jest.fn();
      // getBasicByIds, not getById: the delete reads the four columns it needs
      // for a whole batch rather than a detail payload per photo (§12.1).
      const photo = { id: 'p1', library_id: 'photos-delete', shoot_id: null, file_path: 'a.arw' };
      const { service } = build({
        photos: { getBasicByIds: jest.fn(() => [photo]), markDeleted },
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
  include_subfolders: true, mirror_shoots: true, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
      const markDeleted = jest.fn();
      const setFilePath = jest.fn();
      const rows = [
        { id: 'p1', library_id: 'lib', shoot_id: 'sh', file_path: 'A/B/C/foo.arw' },
        { id: 'p2', library_id: 'lib', shoot_id: null, file_path: 'D/foo.arw' },
        { id: 'p3', library_id: 'lib', shoot_id: null, file_path: 'foo.arw' },
      ];
      const { service } = build({
        photos: { getBasicByIds: jest.fn(() => rows), markDeleted, setFilePath },
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
  include_subfolders: true, mirror_shoots: true, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
      const photo = { id: 'p1', library_id: 'lib', shoot_id: null, file_path: 'a.arw' };
      const { service } = build({
        photos: {
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
    const { service } = build({ photos: { getBasicByIds: jest.fn(() => []), markDeleted } });
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
        include_subfolders: true,
        mirror_shoots: true,
        auto_stack: true,
        auto_stack_similarity: 0.78,
        auto_stack_window_seconds: 60,
        last_synced_at: null,
        photo_count: 0,
      };
      const getBasicByIds = jest.fn(() => ids.map((id) => ({ id, library_id: 'lib', shoot_id: null, file_path: `${id}.arw` })));
      // Counted by hand: jest.fn erases the generic the repository declares.
      let commits = 0;
      const transaction = <T,>(fn: () => T): T => {
        commits++;
        return fn();
      };
      const getById = jest.fn();
      const markDeleted = jest.fn();
      const { service } = build({
        photos: { getBasicByIds, transaction, getById, markDeleted },
        libraries: { getById: jest.fn(() => lib) },
      });

      await service.delete(ids);

      expect(getBasicByIds).toHaveBeenCalledTimes(1);
      expect(commits).toBe(1);
      expect(getById).not.toHaveBeenCalled();
      expect(markDeleted).toHaveBeenCalledTimes(40);
      for (const id of ids) expect(existsSync(path.join(root, 'Bin', `${id}.arw`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PhotosService.update', () => {
  it('throws NOT_FOUND when nothing was updated', () => {
    const { service } = build({ photos: { update: jest.fn(() => false) } });
    expect(() => service.update('p1', { rating: 5 })).toThrow(AppError);
  });
  it('returns the refreshed detail on success', () => {
    const { service } = build({ photos: { update: jest.fn(() => true), getById: jest.fn(() => detail) } });
    expect(service.update('p1', { rating: 5 })).toMatchObject(detail);
  });
});

describe('PhotosService renditions', () => {
  function detailFor(lib: Library) {
    const { service } = build({
      photos: { getById: jest.fn(() => detail) },
      libraries: { getById: jest.fn(() => lib) },
    });
    return service.get('p1');
  }

  it('serves the camera JPEG as the RAW itself rather than a stored rendition', () => {
    const got = detailFor(library);
    expect(got.renditions?.embedded.path).toBe(path.join('/r', detail.file_path));
    expect(got.renditions?.embedded.built).toBe(true);
  });

  it('opens at the camera JPEG for a library that serves it, and at the full render otherwise', () => {
    expect(detailFor(library).default_rendition).toBe('embedded');
    expect(detailFor({ ...library, rendition_source: 'render' }).default_rendition).toBe('full');
  });

  // The file is the cache, so an SDR copy built before the setting was turned on
  // must not answer an HDR request under the same name.
  it('keeps HDR and SDR apart', () => {
    const sdr = detailFor(library).renditions?.full;
    const hdr = detailFor({ ...library, rendition_hdr: true }).renditions?.full;
    expect(hdr?.path).not.toBe(sdr?.path);
    expect(hdr?.path).toContain('full-hdr');
    expect(hdr?.hdr).toBe(true);
    expect(sdr?.hdr).toBe(false);
  });

  // Firefox reports no body size for a cross-origin image, so the panel cannot
  // read this off the response the way it used to; it comes off the same stat
  // that answers `built`.
  it('reports what a stored rendition weighs, and nothing for one that is not built', () => {
    const lib = { ...library, id: 'photos-bytes' };
    const data = getDataPath(lib);
    try {
      const dir = path.join(data, 'renditions', 'full');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'p1.avif'), 'x'.repeat(17));

      const renditions = detailFor(lib).renditions;
      expect(renditions?.full.bytes).toBe(17);
      expect(renditions?.max.bytes).toBeNull();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});
