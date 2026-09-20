import { describe, it, expect, jest } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../../../schemas/libraries';
import type { PhotoDetail } from '../../../../schemas/photos';
import { fileRecipe, type Recipe } from '../../../../schemas/recipes';
import type { ViewerRendition } from '../../../../schemas/settings';
import type { AlbumsRepository } from '../../../albums/albums_repository';
import { localOriginals } from '../../../blobs/originals_for_testing';
import type { LibrariesRepository } from '../../../libraries/libraries_repository';
import type { ProcessingService } from '../../../processing/pipeline/processing_service';
import type { Job } from '../../../../schemas/jobs';
import type { SettingsRepository } from '../../../settings/settings_repository';
import { DEFAULT_SETTINGS } from '../../../../schemas/settings';
import type { ShootsRepository } from '../../../shoots/shoots_repository';
import { getDataPath } from '../../../../utils/paths';
import { resolveRenditionToBuild, resolveShownRendition, type RenditionContext } from '../photo_rendition_policy';
import type { PhotoCompositesRepository } from '../../composites/photo_composites_repository';
import type { PhotoMetadataRepository } from '../../metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../photo_processing_repository';
import type { PhotoNavigationRepository } from '../../listing/photo_navigation_repository';
import type { PhotoListResult, PhotoListingRepository } from '../../listing/photo_listing_repository';
import { PhotoReadService } from '../../listing/photo_read_service';
import { PhotoRenditionService } from '../photo_rendition_service';

const emptyResult: PhotoListResult = { photos: [], total: 0 };

function build(over: {
  photoPaths?: Partial<PhotoPathsRepository>;
  photoListing?: Partial<PhotoListingRepository>;
  photoMetadata?: Partial<PhotoMetadataRepository>;
  photoProcessing?: Partial<PhotoProcessingRepository>;
  libraries?: Partial<LibrariesRepository>;
  shoots?: Partial<ShootsRepository>;
  albums?: Partial<AlbumsRepository>;
  processing?: Partial<ProcessingService>;
  settings?: Partial<ReturnType<SettingsRepository['get']>>;
}) {
  const photoPaths = {
    getBasicById: jest.fn(() => null),
    ...over.photoPaths,
  } as unknown as PhotoPathsRepository;
  const photoListing = {
    getById: jest.fn(() => null),
    listByLibrary: jest.fn(() => emptyResult),
    listByShoot: jest.fn(() => emptyResult),
    listByAlbum: jest.fn(() => emptyResult),
    ...over.photoListing,
  } as unknown as PhotoListingRepository;
  const photoMetadata = { updateMetadata: jest.fn(), ...over.photoMetadata } as unknown as PhotoMetadataRepository;
  const photoProcessing = {
    // An unedited photograph, which is what every test here that is not about edits
    // means: nothing to have moved past, so every stored copy reads as current.
    renditionStamps: jest.fn(() => ({ built_from: null, edited_from: null })),
    ...over.photoProcessing,
  } as unknown as PhotoProcessingRepository;
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
  const renditions = new PhotoRenditionService(
    photoPaths,
    photoListing,
    photoMetadata,
    photoProcessing,
    libraries,
    processing,
    localOriginals(),
    undefined,
    null,
  );
  const read = new PhotoReadService(
    photoListing,
    {} as unknown as PhotoNavigationRepository,
    photoPaths,
    {} as unknown as PhotoCompositesRepository,
    albums,
    shoots,
    libraries,
    settings,
    processing,
    renditions,
  );
  return {
    service: renditions,
    read,
    photoPaths,
    photoListing,
    photoMetadata,
    photoProcessing,
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
  render_skip_full: [], render_skip_max: [],
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
const detail = { id: 'p1', file_path: 'a.arw', recipe: fileRecipe('a.arw') } as PhotoDetail;

function panoramaRecipe(): Recipe {
  return {
    kind: 'panorama',
    version: 1,
    sources: ['frame001', 'frame002'].map((photoId) => ({
      photoId,
      size: [6000, 4000] as [number, number],
      rotation: [1, 0, 0, 0] as [number, number, number, number],
      focal: 5200,
      lens: { crop: 1, distortion: [0, -0.01], falloff: null, tca: null },
      gain: 1,
    })),
    projection: 'cylindrical',
    canvas: [9000, 4200],
    centre: [4500, 2100],
    radiansPerPixel: 1 / 5200,
    crop: [0, 0, 1, 1],
    reference: 0,
    seamRmsPx: null,
  };
}

describe('PhotoRenditionService.rebuildIfStale', () => {
  const stamps = (over: Partial<{ built_from: string | null; edited_from: string | null; failed: boolean }>) => ({
    renditionStamps: jest.fn(() => ({ built_from: null, edited_from: null, failed: false, ...over })),
  });

  it('queues nothing for a photograph nobody has edited', () => {
    const { service, processing } = build({ photoProcessing: stamps({ edited_from: null }) });

    service.rebuildIfStale('p1');

    expect(processing.rebuildEdited).not.toHaveBeenCalled();
  });

  it('queues the rebuild an editor that never closed would have asked for', () => {
    const { service, processing } = build({ photoProcessing: stamps({ edited_from: 'edits-2' }) });

    service.rebuildIfStale('p1');

    expect(processing.rebuildEdited).toHaveBeenCalledWith(['p1']);
  });

  /**
   * A render that cannot succeed must not be asked for again by every request.
   *
   * `built_from` is written only by a build that landed, so a photograph the decoder
   * refuses stays owed for good - and `queueEditedSince` clears `processing_error` as it
   * queues. Asked on every read, a grid of that photograph would spawn a worker per tile
   * forever and erase the failure the view exists to report.
   */
  it('leaves a photograph whose render already failed alone', () => {
    const { service, processing } = build({ photoProcessing: stamps({ edited_from: 'edits-2', failed: true }) });

    service.rebuildIfStale('p1');

    expect(processing.rebuildEdited).not.toHaveBeenCalled();
  });
});

/** Lets the awaits before a render run, without letting the render itself finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('PhotoRenditionService.buildRendition', () => {
  it('shares one render between the requests that arrive while it runs', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-build-'));
    const lib = { ...library, id: 'photos-build', root_path: root };
    try {
      writeFileSync(path.join(root, 'a.arw'), 'raw');
      const pending: (() => void)[] = [];
      const renderOne = jest.fn(() => new Promise<void>((resolve) => pending.push(resolve)));
      const { service, processing } = build({
        photoPaths: { getBasicById: jest.fn(() => ({ id: 'p1', library_id: lib.id, shoot_id: null, recipe: fileRecipe('a.arw') })) },
        libraries: { getById: jest.fn(() => lib) },
        processing: { renderOne },
      });

      const both = Promise.all([service.buildRendition('p1', 'full'), service.buildRendition('p1', 'full')]);
      // The render is reached through an await - the original is asked for first, and it may not
      // be on this disk (§14.4) - so the call has not happened in the tick that started it.
      await settle();
      expect(processing.renderOne).toHaveBeenCalledTimes(1);
      pending.forEach((resolve) => resolve());
      await both;

      // And the next one renders again: the guard is for the overlap, not a cache.
      // Nothing was written here, so there is no file to stop it.
      const again = service.buildRendition('p1', 'full');
      await settle();
      expect(processing.renderOne).toHaveBeenCalledTimes(2);
      pending.forEach((resolve) => resolve());
      await again;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('measures the photograph again only when the build was forced', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-remeasure-'));
    const lib = { ...library, id: 'photos-remeasure', root_path: root };
    try {
      writeFileSync(path.join(root, 'a.arw'), 'raw');
      const renderOne = jest.fn(async () => {});
      const { service } = build({
        photoPaths: { getBasicById: jest.fn(() => ({ id: 'p1', library_id: lib.id, shoot_id: null, recipe: fileRecipe('a.arw') })) },
        libraries: { getById: jest.fn(() => lib) },
        processing: { renderOne },
      });

      await service.buildRendition('p1', 'full');
      expect(renderOne).toHaveBeenLastCalledWith(path.join(root, 'a.arw'), 'p1', lib, 'full', false, 'render', false);

      await service.buildRendition('p1', 'full', true);
      expect(renderOne).toHaveBeenLastCalledWith(path.join(root, 'a.arw'), 'p1', lib, 'full', false, 'render', true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `max` is never queued, so this is the only way one is ever made - and a composite has no file
  // of its own, so without this arm the reader who zooms a panorama is told nothing here can build
  // it while its frames sit on the same disk.
  it('composites a panorama that is asked for by name', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-composite-'));
    const lib = { ...library, id: 'photos-composite', root_path: root };
    try {
      const buildComposite = jest.fn(async () => true);
      const renderOne = jest.fn(async () => {});
      const { service } = build({
        photoPaths: {
          getBasicById: jest.fn(() => ({
            id: 'pano',
            library_id: lib.id,
            shoot_id: null,
            recipe: panoramaRecipe(),
          })),
        },
        libraries: { getById: jest.fn(() => lib) },
        processing: { renderOne, buildComposite },
      });

      await service.buildRendition('pano', 'max');

      expect(buildComposite).toHaveBeenCalledWith('pano', lib, 'max', lib.rendition_hdr);
      expect(renderOne).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a panorama whose frames are not here rather than claiming it built one', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-composite-gone-'));
    const lib = { ...library, id: 'photos-composite-gone', root_path: root };
    try {
      const { service } = build({
        photoPaths: {
          getBasicById: jest.fn(() => ({
            id: 'pano',
            library_id: lib.id,
            shoot_id: null,
            recipe: panoramaRecipe(),
          })),
        },
        libraries: { getById: jest.fn(() => lib) },
        processing: { buildComposite: jest.fn(async () => false) },
      });

      await expect(service.buildRendition('pano', 'max')).rejects.toThrow(/compose/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PhotoRenditionService.renditionJob', () => {
  it("hands a client the job the server would have rendered, with the edit stamp it renders", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-client-job-'));
    const lib = { ...library, id: 'photos-client-job', root_path: root };
    try {
      writeFileSync(path.join(root, 'a.arw'), 'raw');
      const command = { rawFilePath: '' } as Job;
      const renditionCommand = jest.fn(() => ({ command, builtFrom: 'stamp-1' }));
      const { service } = build({
        photoPaths: { getBasicById: jest.fn(() => ({ id: 'p1', library_id: lib.id, shoot_id: null, recipe: fileRecipe('a.arw') })) },
        libraries: { getById: jest.fn(() => lib) },
        processing: { renditionCommand },
      });

      expect(service.renditionJob('p1', 'max', true)).toEqual({ command, builtFrom: 'stamp-1' });
      expect(renditionCommand).toHaveBeenCalledWith('p1', lib, 'max', lib.rendition_hdr, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a panorama and a missing original to the server', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-client-job-none-'));
    const lib = { ...library, id: 'photos-client-job-none', root_path: root };
    try {
      const renditionCommand = jest.fn();
      const recipes = { pano: panoramaRecipe(), gone: fileRecipe('gone.arw') };
      const { service } = build({
        photoPaths: {
          getBasicById: jest.fn((id: 'pano' | 'gone') => ({ id, library_id: lib.id, shoot_id: null, recipe: recipes[id] })),
        },
        libraries: { getById: jest.fn(() => lib) },
        processing: { renditionCommand },
      });

      expect(service.renditionJob('pano', 'full', false)).toBeNull();
      expect(service.renditionJob('gone', 'full', false)).toBeNull();
      expect(renditionCommand).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("files what a client rendered under the stamp the client's job carried", async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-client-keep-'));
    const lib = { ...library, id: 'photos-client-keep', root_path: root };
    try {
      const keepRendered = jest.fn(async () => {});
      const { service } = build({
        photoPaths: { getBasicById: jest.fn(() => ({ id: 'p1', library_id: lib.id, shoot_id: null, recipe: fileRecipe('a.arw') })) },
        libraries: { getById: jest.fn(() => lib) },
        processing: { keepRendered },
      });
      const rendered = new Uint8Array([1, 2, 3]);

      await service.keepRendition('p1', 'full', 'stamp-1', rendered);

      expect(keepRendered).toHaveBeenCalledWith('p1', lib, 'full', lib.rendition_hdr, 'stamp-1', rendered);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PhotoReadService renditions', () => {
  function detailFor(lib: Library) {
    const { read } = build({
      photoListing: { getById: jest.fn(() => detail) },
      libraries: { getById: jest.fn(() => lib) },
    });
    return read.get('p1');
  }

  it('serves the camera JPEG as the RAW itself rather than a stored rendition', () => {
    const got = detailFor(library);
    expect(got.renditions?.embedded.path).toBe(path.join('/r', 'a.arw'));
    expect(got.renditions?.embedded.built).toBe(true);
  });

  it('opens at the camera JPEG for a library that serves it, and at the full render otherwise', () => {
    expect(detailFor(library).shown_rendition).toBe('embedded');
    expect(detailFor({ ...library, rendition_source: 'render' }).shown_rendition).toBe('full');
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

describe('resolveShownRendition / resolveRenditionToBuild', () => {
  function ctx(over: Partial<RenditionContext>): RenditionContext {
    return {
      librarySource: 'embedded',
      mode: 'remember',
      lastViewerRendition: null,
      rowViewerRendition: null,
      isEdited: false,
      framesEdited: false,
      hasEmbedded: true,
      composesCameraView: false,
      builtRenditions: new Set(['embedded']),
      // A listing's fidelity by default; the cases about a stat say so.
      builtIsExact: false,
      ...over,
    };
  }

  // A PNG, a HEIC or an AVIF has no camera JPEG to fall back to, so every route that would
  // otherwise reach for one has to name the render instead - a viewer pointed at a file that
  // cannot exist sits on the 404 rather than healing through it.
  it('never opens a photograph with no camera JPEG at one', () => {
    const none = { hasEmbedded: false, builtRenditions: new Set<ViewerRendition>() };
    expect(resolveShownRendition(ctx({ librarySource: 'embedded', ...none }))).toBe('full');
    expect(resolveShownRendition(ctx({ librarySource: 'embedded', ...none, mode: 'best_available' }))).toBe('full');
    expect(
      resolveShownRendition(ctx({ librarySource: 'embedded', ...none, mode: 'remember', lastViewerRendition: 'embedded' })),
    ).toBe('full');
  });

  // The half `resolveShownRendition` cannot cover on its own: the client acts on both answers,
  // and `ImageApi` will not heal an `embedded` 404 the way it heals a missing render - so naming
  // one here is a stage that stays blank until the reader guesses to switch. `remember` is the
  // default mode and `last_viewer_rendition` becomes `embedded` the moment anyone presses I on
  // any RAW, so this fires on every PNG in the library rather than in some corner.
  it('never asks for a build of a camera JPEG that does not exist', () => {
    const none = { hasEmbedded: false, builtRenditions: new Set<ViewerRendition>() };
    for (const mode of ['remember', 'remember_per_photo'] as const) {
      const asked = ctx({
        librarySource: 'embedded',
        ...none,
        mode,
        lastViewerRendition: 'embedded',
        rowViewerRendition: 'embedded',
      });
      expect(resolveRenditionToBuild(asked)).toBeNull();
    }
    // And the guard is only about the camera JPEG: the same photograph asked for `max` still
    // says so, or it would stop building anything a reader chose.
    expect(resolveRenditionToBuild(ctx({ librarySource: 'embedded', ...none, mode: 'max' }))).toBe('max');
  });

  /**
   * A canvas's camera view is a *build* - its frames' JPEGs composited into one - where a
   * photograph's is a lift out of the RAW. It is promised all the same, and the 404 is what
   * starts it: a library that serves the cameras' pictures queues a panorama nothing but its
   * tile (`renditions::owedOf`), so promising the render there would open every panorama into a
   * copy nobody is building.
   */
  it('opens a composite at the cameras pictures where that is what the library serves', () => {
    expect(resolveShownRendition(ctx({ composesCameraView: true, librarySource: 'embedded' }))).toBe('embedded');
    // Not built yet, and still what it is promised: the 404 on it is what composites it.
    const missing = ctx({ composesCameraView: true, builtRenditions: new Set<ViewerRendition>(['full']) });
    expect(resolveShownRendition(missing)).toBe('embedded');
    // A library that renders is shown the render, which is the copy the merge did build.
    expect(resolveShownRendition(ctx({ composesCameraView: true, librarySource: 'render' }))).toBe('full');
  });

  /**
   * The other half of that promise, and the half nothing was keeping: a canvas's camera view is a
   * file that has to be composited, so the row shown one and holding none is the row that asks for
   * it. Left unasked, a library serving the cameras' pictures opens every canvas on a 404 that
   * never heals, and the only way to a picture is the reader finding the rendition menu.
   *
   * A photograph is never named here for the same reason: its camera view is bytes inside the
   * original, there is nothing to build, and a build of one would be a render filed under the one
   * name promising it is not one.
   */
  it('asks a composite for the camera view it is opened at, and a photograph for none', () => {
    const stat = { builtIsExact: true, builtRenditions: new Set<ViewerRendition>() };
    const canvas = ctx({ composesCameraView: true, librarySource: 'embedded', ...stat });
    expect(resolveShownRendition(canvas)).toBe('embedded');
    expect(resolveRenditionToBuild(canvas)).toBe('embedded');

    const composited = ctx({
      composesCameraView: true,
      librarySource: 'embedded',
      builtIsExact: true,
      builtRenditions: new Set<ViewerRendition>(['embedded']),
    });
    expect(resolveRenditionToBuild(composited)).toBeNull();

    expect(resolveRenditionToBuild(ctx({ librarySource: 'embedded', ...stat }))).toBeNull();
  });

  /**
   * Its *frames'* documents, not its own. A canvas carries one from the moment it is merged -
   * the framing the align found - and a crop reaches the cameras' pictures as readily as a
   * render, where a frame's edit is in no JPEG of that frame (`renditions::sourceFor`).
   */
  it('opens a composite whose frames are edited at the render, and one that is only framed at the JPEGs', () => {
    const composite = { composesCameraView: true, librarySource: 'embedded' as const };
    expect(resolveShownRendition(ctx({ ...composite, isEdited: true }))).toBe('embedded');
    expect(resolveShownRendition(ctx({ ...composite, framesEdited: true }))).toBe('full');
  });

  it('opens at the camera JPEG for a library that serves it, and at the render for one that builds', () => {
    expect(resolveShownRendition(ctx({ librarySource: 'embedded' }))).toBe('embedded');
    expect(resolveShownRendition(ctx({ librarySource: 'render' }))).toBe('full');
  });

  it('opens an edited photo at the render even in a library that serves the camera JPEG', () => {
    expect(resolveShownRendition(ctx({ librarySource: 'embedded', isEdited: true }))).toBe('full');
  });

  it('remember: the last rendition used anywhere, capped at what the library guarantees', () => {
    const wantsMax = ctx({ mode: 'remember', lastViewerRendition: 'max', librarySource: 'embedded' });
    expect(resolveShownRendition(wantsMax)).toBe('embedded');
    expect(resolveRenditionToBuild(wantsMax)).toBe('max');
    expect(resolveShownRendition(ctx({ mode: 'remember', lastViewerRendition: null }))).toBe('embedded');
  });

  it("remember_per_photo: this row's own memory, independent of any other photo", () => {
    const remembered = ctx({ mode: 'remember_per_photo', rowViewerRendition: 'full', librarySource: 'render' });
    expect(resolveShownRendition(remembered)).toBe('full');
    expect(resolveRenditionToBuild(remembered)).toBeNull();
  });

  // What a stat says is on disk is drawn from as it stands, `max` included: capped to what
  // the library guarantees, the one mode whose whole premise is "show me what is already
  // there" fetched `full` first and swapped to the `max` it had already chosen.
  it('best_available: the highest rendition a stat found, and nothing left to build', () => {
    const exact = { mode: 'best_available', librarySource: 'render', builtIsExact: true } as const;
    expect(resolveShownRendition(ctx({ ...exact, builtRenditions: new Set(['embedded']) }))).toBe('embedded');
    const rendered = ctx({ ...exact, builtRenditions: new Set(['embedded', 'full']) });
    expect(resolveShownRendition(rendered)).toBe('full');
    expect(resolveRenditionToBuild(rendered)).toBeNull();
    const highest = ctx({ ...exact, builtRenditions: new Set(['embedded', 'full', 'max']) });
    expect(resolveShownRendition(highest)).toBe('max');
    expect(resolveRenditionToBuild(highest)).toBeNull();
  });

  // A listing reads `renditions_built_at`, which a run that wrote no `full` also stamps, so
  // there the same set is a guess and the guarantee is what holds.
  it('best_available: a row is capped at what the library guarantees, its built set being a guess', () => {
    const row = ctx({ mode: 'best_available', librarySource: 'embedded', builtRenditions: new Set(['embedded', 'full']) });
    expect(resolveShownRendition(row)).toBe('embedded');
  });

  it('a max built by hand in an embedded library is taken where a stat found it', () => {
    const exact = ctx({
      mode: 'best_available',
      librarySource: 'embedded',
      builtIsExact: true,
      builtRenditions: new Set(['embedded', 'max']),
    });
    expect(resolveShownRendition(exact)).toBe('max');
    expect(resolveRenditionToBuild(exact)).toBeNull();

    const store = ctx({ mode: 'best_available', librarySource: 'embedded', builtRenditions: new Set(['embedded', 'max']) });
    expect(resolveShownRendition(store)).toBe('embedded');
    expect(resolveRenditionToBuild(store)).toBe('max');
  });

  it('a rendition asked for outright is what goes up once the library guarantees it, and a build behind it otherwise', () => {
    const guaranteed = ctx({ mode: 'full', librarySource: 'render' });
    expect(resolveShownRendition(guaranteed)).toBe('full');
    expect(resolveRenditionToBuild(guaranteed)).toBeNull();

    const notGuaranteed = ctx({ mode: 'full', librarySource: 'embedded' });
    expect(resolveShownRendition(notGuaranteed)).toBe('embedded');
    expect(resolveRenditionToBuild(notGuaranteed)).toBe('full');
  });
});
