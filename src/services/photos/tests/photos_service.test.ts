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
  const processing = { renderLossless: jest.fn(async () => {}) } as unknown as ProcessingService;
  return { service: new PhotosService(photos, albums, shoots, libraries, processing), photos, libraries, shoots, albums };
}

const library: Library = { id: 'lib', root_path: '/r', data_path: null, ordering: 'added_asc',
  preview_source: 'embedded' as const,
  preview_hdr: false,
  preview_hdr_video: false, last_synced_at: null, photo_count: 0 };
const shoot: Shoot = { id: 'sh', parent_id: null, library_id: 'lib', folder_path: 'Trip', name: 'Trip', description: null, banner_photo_id: null, ordering: 'taken_asc', photo_count: 0 };
const album: Album = { id: 'al', name: 'Faves', ordering: 'taken_desc', banner_photo_id: null, photo_count: 0 };
const detail = { id: 'p1' } as PhotoDetail;

describe('PhotosService.get', () => {
  it('throws NOT_FOUND when the photo is absent', () => {
    const { service } = build({});
    expect(() => service.get('p1')).toThrow(AppError);
  });
  it('returns the detail when present', () => {
    const { service } = build({ photos: { getById: jest.fn(() => detail) } });
    // Not toBe: get() decorates the row with has_lossless, which the repository
    // cannot know because it does not touch the filesystem.
    expect(service.get('p1')).toMatchObject({ ...detail, has_lossless: false });
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
      needsProcessing: undefined,
    });
    expect(res).toEqual({ photos: [], total: 0, offset: 5, limit: 10 });
  });
});

describe('PhotosService.listMissing', () => {
  it('delegates to listByLibrary with is_missing=true', () => {
    const { service, photos } = build({ libraries: { getById: jest.fn(() => library) } });
    service.listMissing('lib', { offset: 0, limit: 100 });
    expect(photos.listByLibrary).toHaveBeenCalledWith('lib', 'added_asc', 0, 100, {
      includeDeleted: false,
      isMissing: true,
      needsProcessing: undefined,
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
  it('moves the RAW into the library Bin, flags is_deleted, and keeps the thumbnails', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    try {
      const dataDir = path.join(root, '.bowerbird');
      mkdirSync(path.join(dataDir, 'thumbnails', 'small'), { recursive: true });
      mkdirSync(path.join(dataDir, 'thumbnails', 'full'), { recursive: true });
      writeFileSync(path.join(root, 'a.arw'), '');
      writeFileSync(path.join(dataDir, 'thumbnails', 'small', 'p1.webp'), '');
      writeFileSync(path.join(dataDir, 'thumbnails', 'full', 'p1.webp'), '');

      const lib: Library = { id: 'lib', root_path: root, data_path: null, ordering: 'added_asc',
  preview_source: 'embedded' as const,
  preview_hdr: false,
  preview_hdr_video: false, last_synced_at: null, photo_count: 0 };
      const markDeleted = jest.fn();
      const photo = { id: 'p1', library_id: 'lib', shoot_id: null, file_path: 'a.arw', is_deleted: false } as PhotoDetail;
      const { service } = build({
        photos: { getById: jest.fn(() => photo), markDeleted },
        libraries: { getById: jest.fn(() => lib) },
      });

      await service.delete(['p1']);

      expect(existsSync(path.join(root, 'a.arw'))).toBe(false);
      expect(existsSync(path.join(dataDir, 'bin', 'a.arw'))).toBe(true);
      // Kept, not deleted: the Bin is browsable and restorable only if the
      // binned photos can still be seen.
      expect(existsSync(path.join(dataDir, 'thumbnails', 'small', 'p1.webp'))).toBe(true);
      expect(existsSync(path.join(dataDir, 'thumbnails', 'full', 'p1.webp'))).toBe(true);
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
  preview_source: 'embedded' as const,
  preview_hdr: false,
  preview_hdr_video: false, last_synced_at: null, photo_count: 0 };
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
      expect(existsSync(path.join(root, '.bowerbird', 'bin', 'a.arw'))).toBe(false);
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
    expect(service.update('p1', { rating: 5 })).toMatchObject({ ...detail, has_lossless: false });
  });
});

describe('PhotosService.previewPath', () => {
  const rendered = { id: 'p1', thumbnail_source: 'render', thumbnail_hdr: false } as PhotoDetail;

  it('serves the photo\'s own full thumbnail when both source and range match', () => {
    const { service } = build({});
    expect(service.previewPath(library, rendered, 'render', false)).toContain(path.join('thumbnails', 'full'));
  });

  it('keeps HDR and SDR renders apart, so one built before the setting changed is not served for the other', () => {
    const { service } = build({});
    const sdr = service.previewPath(library, rendered, 'render', false);
    const hdr = service.previewPath(library, rendered, 'render', true);
    expect(hdr).not.toBe(sdr);
    expect(hdr).toContain('render-hdr');
  });
});
