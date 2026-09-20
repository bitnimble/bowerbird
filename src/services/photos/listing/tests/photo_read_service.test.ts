import { describe, it, expect, jest } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../../errors';
import type { Album } from '../../../../schemas/albums';
import type { Library } from '../../../../schemas/libraries';
import type { PhotoDetail, PhotoSummary } from '../../../../schemas/photos';
import { fileRecipe } from '../../../../schemas/recipes';
import type { Shoot } from '../../../../schemas/shoots';
import type { AlbumsRepository } from '../../../albums/albums_repository';
import type { LibrariesRepository } from '../../../libraries/libraries_repository';
import type { ProcessingService } from '../../../processing/pipeline/processing_service';
import type { SettingsRepository } from '../../../settings/settings_repository';
import { DEFAULT_SETTINGS } from '../../../../schemas/settings';
import type { ShootsRepository } from '../../../shoots/shoots_repository';
import { getDataPath } from '../../../../utils/paths';
import type { PhotoCompositesRepository } from '../../composites/photo_composites_repository';
import type { PhotoMetadataRepository } from '../../metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../renditions/photo_processing_repository';
import { PhotoRenditionService } from '../../renditions/photo_rendition_service';
import type { PhotoNavigationRepository } from '../photo_navigation_repository';
import type { PhotoListResult, PhotoListingRepository } from '../photo_listing_repository';
import { PhotoReadService } from '../photo_read_service';

const emptyResult: PhotoListResult = { photos: [], total: 0 };

function build(over: {
  photoListing?: Partial<PhotoListingRepository>;
  libraries?: Partial<LibrariesRepository>;
  shoots?: Partial<ShootsRepository>;
  albums?: Partial<AlbumsRepository>;
  processing?: Partial<ProcessingService>;
  settings?: Partial<ReturnType<SettingsRepository['get']>>;
}) {
  const photoListing = {
    getById: jest.fn(() => null),
    listByLibrary: jest.fn(() => emptyResult),
    listByShoot: jest.fn(() => emptyResult),
    listByAlbum: jest.fn(() => emptyResult),
    ...over.photoListing,
  } as unknown as PhotoListingRepository;
  // `list` as well as `getById`: a listing resolves `shown_rendition` for a page that may
  // span libraries, so it looks them all up at once.
  const libraries = {
    getById: jest.fn(() => null),
    list: jest.fn(() => []),
    setBinIdentity: jest.fn(),
    ...over.libraries,
  } as unknown as LibrariesRepository;
  const shoots = { getById: jest.fn(() => null), ...over.shoots } as unknown as ShootsRepository;
  const albums = { getById: jest.fn(() => null), getAlbumIdsForPhoto: jest.fn(() => []), ...over.albums } as unknown as AlbumsRepository;
  // These tests never render, so a stub keeps the native library and worker threads out.
  const processing = {
    renderLossless: jest.fn(async () => {}),
    renderOne: jest.fn(async () => {}),
    rebuildEdited: jest.fn(() => 0),
    ...over.processing,
  } as unknown as ProcessingService;
  const settings = {
    get: jest.fn(() => ({ ...DEFAULT_SETTINGS, ...over.settings })),
  } as unknown as SettingsRepository;
  const photoPaths = {} as unknown as PhotoPathsRepository;
  const photoNavigation = {} as unknown as PhotoNavigationRepository;
  const photoComposites = {} as unknown as PhotoCompositesRepository;
  const photoMetadata = {} as unknown as PhotoMetadataRepository;
  const photoProcessing = {
    // An unedited photograph, which is what every test here that is not about edits
    // means: nothing to have moved past, so every stored copy reads as current.
    renditionStamps: jest.fn(() => ({ built_from: null, edited_from: null })),
  } as unknown as PhotoProcessingRepository;
  const renditions = new PhotoRenditionService(
    photoPaths,
    photoListing,
    photoMetadata,
    photoProcessing,
    libraries,
    processing,
    undefined,
    null,
  );
  // No fetch-through: these cases are about a device that holds its own originals.
  return {
    service: new PhotoReadService(
      photoListing,
      photoNavigation,
      photoPaths,
      photoComposites,
      albums,
      shoots,
      libraries,
      settings,
      processing,
      renditions,
    ),
    photoListing,
    libraries,
    shoots,
    albums,
    processing,
    settings,
  };
}

const library: Library = { id: 'lib', root_path: '/r', bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'added_asc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  render_skip_full: [], render_skip_max: [], render_timings: {},
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
const shoot: Shoot = { id: 'sh', parent_id: null, library_id: 'lib', folder_path: 'Trip', name: 'Trip', description: null, banner_photo_id: null, ordering: 'taken_asc', photo_count: 0, is_hidden: false, hidden_directly: false };
const album: Album = { id: 'al', name: 'Faves', ordering: 'taken_desc', banner_photo_id: null, photo_count: 0 };
const detail = { id: 'p1', file_path: 'a.arw', recipe: fileRecipe('a.arw') } as PhotoDetail;

describe('PhotoReadService.get', () => {
  it('throws NOT_FOUND when the photo is absent', () => {
    const { service } = build({});
    expect(() => service.get('p1')).toThrow(AppError);
  });
  it('returns the detail when present', () => {
    const { service } = build({ photoListing: { getById: jest.fn(() => detail) } });
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
        photoListing: { getById: jest.fn(() => photo) },
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

describe('PhotoReadService.resolve', () => {
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
    const { service, photoListing } = build({ photoListing: { idsInLibrary }, libraries: { getById: jest.fn(() => library) } });
    expect(service.resolve(selection())).toEqual(['a', 'b']);
    expect(photoListing.idsInLibrary).toHaveBeenCalledWith('lib', 'added_asc', [{ start: 0, end: 1 }], expect.anything());
  });

  // A photo picked out of an open stack has no position in a collapsed listing
  // (§19.6.1), so it travels by id beside the runs - and a stack row named by a
  // run resolves to every member, so the two can name the same photo.
  it('adds the members to the runs, each photo once', () => {
    const idsInLibrary = jest.fn(() => ['a', 'b']);
    const { service } = build({ photoListing: { idsInLibrary }, libraries: { getById: jest.fn(() => library) } });
    expect(service.resolve(selection({ members: ['b', 'c'] }))).toEqual(['a', 'b', 'c']);
  });

  it('asks the collection nothing when the selection is members alone', () => {
    const idsInLibrary = jest.fn(() => ['a']);
    const { service, photoListing } = build({ photoListing: { idsInLibrary }, libraries: { getById: jest.fn(() => library) } });
    expect(service.resolve(selection({ ranges: [], members: ['c'] }))).toEqual(['c']);
    expect(photoListing.idsInLibrary).not.toHaveBeenCalled();
  });
});

describe('PhotoReadService.listByLibrary', () => {
  it('throws NOT_FOUND for an unknown library', () => {
    const { service } = build({});
    expect(() => service.listByLibrary('lib', { offset: 0, limit: 100, include_deleted: false })).toThrow(/library not found/);
  });

  it("orders by the library's ordering and echoes pagination", () => {
    const { service, photoListing } = build({ libraries: { getById: jest.fn(() => library) } });
    const res = service.listByLibrary('lib', { offset: 5, limit: 10, include_deleted: false, is_missing: true });
    expect(photoListing.listByLibrary).toHaveBeenCalledWith('lib', 'added_asc', 5, 10, {
      includeDeleted: false,
      isMissing: true,
    });
    // The ordering it actually sorted by travels back with the page, so a client
    // never has to hold its own copy of what the sort is (§18.3.1).
    expect(res).toEqual({ photos: [], total: 0, offset: 5, limit: 10, ordering: 'added_asc' });
  });
});

describe('PhotoReadService.listMissing', () => {
  it('delegates to listByLibrary with is_missing=true', () => {
    const { service, photoListing } = build({ libraries: { getById: jest.fn(() => library) } });
    service.listMissing('lib', { offset: 0, limit: 100, include_deleted: false });
    expect(photoListing.listByLibrary).toHaveBeenCalledWith('lib', 'added_asc', 0, 100, {
      includeDeleted: false,
      isMissing: true,
    });
  });

  // It takes the whole listing query, not just pagination. A client acting on a
  // selection made in this view states the filters it was viewing under
  // (§18.3.3), so filters dropped here would resolve a different set of photos
  // than the grid ever showed.
  it('carries the rest of the filters through', () => {
    const { service, photoListing } = build({ libraries: { getById: jest.fn(() => library) } });
    service.listMissing('lib', { offset: 0, limit: 100, include_deleted: false, rated: true, triage: ['picked'], q: 'DSC' });
    expect(photoListing.listByLibrary).toHaveBeenCalledWith(
      'lib',
      'added_asc',
      0,
      100,
      expect.objectContaining({ isMissing: true, rated: true, triage: ['picked'], search: 'DSC' }),
    );
  });
});

describe('PhotoReadService scoped listing uses the owner ordering', () => {
  it('listByShoot uses shoot ordering (NOT_FOUND when absent)', () => {
    const missing = build({});
    expect(() => missing.service.listByShoot('sh', { offset: 0, limit: 100, include_deleted: false })).toThrow(/shoot not found/);
    const { service, photoListing } = build({ shoots: { getById: jest.fn(() => shoot) } });
    service.listByShoot('sh', { offset: 0, limit: 100, include_deleted: false });
    expect(photoListing.listByShoot).toHaveBeenCalledWith('sh', 'taken_asc', 0, 100, { includeDeleted: false });
  });

  it('listByAlbum uses album ordering (NOT_FOUND when absent)', () => {
    const missing = build({});
    expect(() => missing.service.listByAlbum('al', { offset: 0, limit: 100, include_deleted: false })).toThrow(/album not found/);
    const { service, photoListing } = build({ albums: { getById: jest.fn(() => album), getAlbumIdsForPhoto: jest.fn(() => []) } });
    service.listByAlbum('al', { offset: 0, limit: 100, include_deleted: false });
    expect(photoListing.listByAlbum).toHaveBeenCalledWith('al', 'taken_desc', 0, 100, { includeDeleted: false });
  });
});

// The row a grid, a band or the viewer's run is drawn from is the *only* copy of this
// answer those views have, and the client prefers it over nothing else - so a row that
// resolves differently from the same photograph's detail opens it one way from the grid and
// another from a deep link.
describe('PhotoReadService listings resolve shown_rendition per row', () => {
  const row = (over: Partial<PhotoSummary>): PhotoSummary =>
    ({
      id: 'p1',
      library_id: 'lib',
      file_path: 'a.arw',
      viewer_rendition: null,
      rendition_source: null,
      is_edited: false,
      renditions_built_at: null,
      ...over,
    }) as PhotoSummary;

  function listed(lib: Library, rows: PhotoSummary[], settings?: { viewer_rendition_mode: 'best_available' }): PhotoSummary[] {
    const { service } = build({
      photoListing: { listByLibrary: jest.fn(() => ({ photos: rows, total: rows.length })) },
      libraries: { getById: jest.fn(() => lib), list: jest.fn(() => [lib]) },
      ...(settings == null ? {} : { settings }),
    });
    return service.listByLibrary('lib', { offset: 0, limit: 10 } as never).photos;
  }

  it('answers the camera JPEG for a library that serves it, and the render for one that builds', () => {
    expect(listed(library, [row({})])[0]?.shown_rendition).toBe('embedded');
    expect(listed({ ...library, rendition_source: 'render' }, [row({})])[0]?.shown_rendition).toBe('full');
  });

  // The failure this pins: a row resolved as unedited draws an edited photograph from the
  // camera's JPEG, which cannot carry the edit - and nothing corrects it, because the
  // camera's JPEG is the RAW's own bytes and never 404s into a build.
  it('answers the render for an edited photo in a library that serves the camera JPEG', () => {
    expect(listed(library, [row({ is_edited: true })])[0]?.shown_rendition).toBe('full');
  });

  // What the library serves now, not what a photograph's renditions were last built from: a
  // library just switched to rendering has photographs whose renders are still being made,
  // and naming the render is what makes the first frame 404 into the build that writes it.
  it('answers from what the library serves, for a photo whose renditions predate the switch', () => {
    const rendering = { ...library, rendition_source: 'render' as const };
    expect(listed(rendering, [row({ renditions_built_at: null })])[0]?.shown_rendition).toBe('full');
  });

  // `best_available` is the one mode allowed to answer from what is on disk, and a listing has
  // not looked: `renditions_built_at` is stamped when a photograph's renditions are finished,
  // which for a library serving the camera's JPEG means no render was written at all. Taken as
  // an exact answer, every row in such a library would open on a `full` that does not exist -
  // and the whole page would 404 into builds nobody asked for. Only `PhotoReadService.get`, which
  // has statted the files, may say otherwise.
  it('does not draw on what is built for best_available, having statted nothing', () => {
    const shown = listed(library, [row({ renditions_built_at: '2026-01-01T00:00:00.000Z' })], {
      viewer_rendition_mode: 'best_available',
    })[0]?.shown_rendition;
    expect(shown).toBe('embedded');
  });
});
