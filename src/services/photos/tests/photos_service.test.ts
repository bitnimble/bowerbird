import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const libraries = { getById: jest.fn(() => null), ...over.libraries } as unknown as LibrariesRepository;
  const shoots = { getById: jest.fn(() => null), ...over.shoots } as unknown as ShootsRepository;
  const albums = { getById: jest.fn(() => null), getAlbumIdsForPhoto: jest.fn(() => []), ...over.albums } as unknown as AlbumsRepository;
  // These tests never render, so a stub keeps LibRaw and worker threads out.
  const processing = {
    renderLossless: jest.fn(async () => {}),
    renderOne: jest.fn(async () => {}),
    ...over.processing,
  } as unknown as ProcessingService;
  return { service: new PhotosService(photos, albums, shoots, libraries, processing), photos, libraries, shoots, albums, processing };
}

const library: Library = { id: 'lib', root_path: '/r', data_path: null, ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  rendition_hdr_video: false, last_synced_at: null, photo_count: 0 };
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
    try {
      writeFileSync(path.join(root, 'a.arw'), 'raw');
      const photo = { ...detail, rendition_source: 'embedded' } as PhotoDetail;
      const lib = { ...library, root_path: root, rendition_source: 'render' as const };
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
      await Promise.resolve();
      mkdirSync(path.join(root, '.bowerbird', 'renditions', 'grid'), { recursive: true });
      writeFileSync(path.join(root, '.bowerbird', 'renditions', 'grid', 'p1.avif'), 'tile');
      service.get('p1');
      expect(processing.renderOne).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    service.listMissing('lib', { offset: 0, limit: 100 });
    expect(photos.listByLibrary).toHaveBeenCalledWith('lib', 'added_asc', 0, 100, {
      includeDeleted: false,
      isMissing: true,
      needsTile: undefined,
    });
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
    try {
      const dataDir = path.join(root, '.bowerbird');
      mkdirSync(path.join(dataDir, 'renditions', 'small'), { recursive: true });
      mkdirSync(path.join(dataDir, 'renditions', 'full'), { recursive: true });
      writeFileSync(path.join(root, 'a.arw'), '');
      writeFileSync(path.join(dataDir, 'renditions', 'small', 'p1.webp'), '');
      writeFileSync(path.join(dataDir, 'renditions', 'full', 'p1.webp'), '');

      const lib: Library = { id: 'lib', root_path: root, data_path: null, ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  rendition_hdr_video: false, last_synced_at: null, photo_count: 0 };
      const markDeleted = jest.fn();
      const photo = { id: 'p1', library_id: 'lib', shoot_id: null, file_path: 'a.arw', is_deleted: false } as PhotoDetail;
      const { service } = build({
        photos: { getById: jest.fn(() => photo), markDeleted },
        libraries: { getById: jest.fn(() => lib) },
      });

      await service.delete(['p1']);

      expect(existsSync(path.join(root, 'a.arw'))).toBe(false);
      expect(existsSync(path.join(root, 'Bin', 'a.arw'))).toBe(true);
      // Kept, not deleted: the Bin is browsable and restorable only if the
      // binned photos can still be seen.
      expect(existsSync(path.join(dataDir, 'renditions', 'small', 'p1.webp'))).toBe(true);
      expect(existsSync(path.join(dataDir, 'renditions', 'full', 'p1.webp'))).toBe(true);
      // The pre-delete path is recorded so restore can put the file back there.
      expect(markDeleted).toHaveBeenCalledWith('p1', 'a.arw');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls the Bin move back to the original path when the DB write fails', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-del-'));
    try {
      writeFileSync(path.join(root, 'a.arw'), 'raw');
      const lib: Library = { id: 'lib', root_path: root, data_path: null, ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  rendition_hdr_video: false, last_synced_at: null, photo_count: 0 };
      const photo = { id: 'p1', library_id: 'lib', shoot_id: null, file_path: 'a.arw', is_deleted: false } as PhotoDetail;
      const { service } = build({
        photos: {
          getById: jest.fn(() => photo),
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

  it('skips already-deleted photos', async () => {
    const markDeleted = jest.fn();
    const photo = { id: 'p1', is_deleted: true } as PhotoDetail;
    const { service } = build({ photos: { getById: jest.fn(() => photo), markDeleted } });
    await service.delete(['p1']);
    expect(markDeleted).not.toHaveBeenCalled();
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
    const root = mkdtempSync(path.join(tmpdir(), 'bb-bytes-'));
    try {
      const dir = path.join(root, '.bowerbird', 'renditions', 'full');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'p1.avif'), 'x'.repeat(17));

      const renditions = detailFor({ ...library, root_path: root }).renditions;
      expect(renditions?.full.bytes).toBe(17);
      expect(renditions?.max.bytes).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Firefox watches the twin rather than the still, so the panel describing what
  // is on screen has to be able to name that file and say what it weighs.
  it('reports the video twin with its path and weight, and nothing when there is none', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-twin-'));
    try {
      const dir = path.join(root, '.bowerbird', 'renditions', 'full-hdr-video');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'p1.mp4'), 'x'.repeat(11));

      const withVideo = detailFor({ ...library, root_path: root, rendition_hdr: true }).renditions;
      expect(withVideo?.full.video).toEqual({ path: path.join(dir, 'p1.mp4'), bytes: 11 });
      // Only `full` has one on disk, and an SDR library never gets one at all.
      expect(withVideo?.max.video).toBeNull();
      expect(detailFor({ ...library, root_path: root }).renditions?.full.video).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
