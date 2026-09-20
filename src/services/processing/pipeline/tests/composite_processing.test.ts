import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../../../../schemas/settings';
import { canvasLongEdgeFor } from '../../../../schemas/composition';
import { RecipeSchema } from '../../../../schemas/recipes';
import type { PhotoListingRepository } from '../../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import type { SettingsRepository } from '../../../settings/settings_repository';
import { ProcessingService } from '../processing_service';
import { JOB_CANCELLED } from '../../rawshim/rawshim_job';
import type { CompositeJob, RenditionJob, ProcessingResult } from '../../workers/processing_types';

const CRASH = 'crash-photo';
// This file's own library id, because the data directory is keyed by one (§6)
// and two test files sharing a directory would race each other's cleanup.
const LIB = 'processing-service-test';

/** Every job the service handed to a worker, so its shape can be asserted. */
const posted: (RenditionJob | CompositeJob)[] = [];

/** Every worker the service constructed, so "one worker" can be asserted rather than assumed. */
const built: MockWorker[] = [];

const DESCRIPTOR = new Uint8Array([1, 2, 3]);

// Fake Worker: a job for CRASH fires onerror (a native-crash-like event, which
// skips the worker's own catch); everything else reports success.
class MockWorker {
  onmessage: ((event: { data: ProcessingResult }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: string) {
    built.push(this);
  }
  postMessage(job: RenditionJob | CompositeJob): void {
    posted.push(job);
    queueMicrotask(() => {
      // A panorama is keyed by its stack rather than a photograph, and an align answers a recipe.
      if (job.kind === 'composite') {
        if (job.photoId === CRASH || (job.want === 'seams' && job.volumePath === CRASH)) {
          return this.onerror?.({ message: 'segfault' });
        }
        return this.onmessage?.({
          data: { photoId: job.photoId, success: true, composite: '{}' },
        });
      }
      if (job.photoId === CRASH) return this.onerror?.({ message: 'segfault' });
      // As the real worker does: a descriptor rides back with a grid tile and with
      // nothing else, since that is the one pass computing it (§19.3).
      const tile = job.targets.every((target) => target.rendition === 'grid');
      this.onmessage?.({
        data: { photoId: job.photoId, success: true, ...(tile ? { descriptor: DESCRIPTOR } : {}) },
      });
    });
  }

  terminate(): void {}
}

// Put back rather than `delete`d, so what the runtime hands the next reader of this global is
// the builtin it started with rather than nothing.
const REAL_WORKER = globalThis.Worker;

function settingsWith(overrides: Partial<Settings> = {}): SettingsRepository {
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 2, ...overrides };
  return { get: () => settings } as SettingsRepository;
}

const settings = settingsWith();

function usingMockWorker(): void {
  beforeEach(() => {
    posted.length = 0;
    built.length = 0;
    (globalThis as { Worker?: unknown }).Worker = MockWorker;
  });
  afterEach(() => {
    globalThis.Worker = REAL_WORKER;
  });
}


describe('ProcessingService.openComposite', () => {
  usingMockWorker();

  const service = (): ProcessingService =>
    new ProcessingService({} as unknown as PhotoProcessingRepository, NO_PATHS, NO_LISTING, settings);

  const job = (want: 'align' | 'render', photoId = 'panorama'): CompositeJob =>
    ({ kind: 'composite', want, photoId, sources: [], targets: [] }) as unknown as CompositeJob;

  /**
   * A merge is an align and a rendition each for the tile and the picture, and every job opens a
   * GPU device and compiles the shader modules before it starts - half a second of it. One worker
   * across the three is what stops that being paid three times.
   */
  it('runs a whole merge on one worker', async () => {
    const on = service().openComposite();
    await on.run(job('align'));
    await on.run(job('render'));
    await on.run(job('render'));
    on.close();

    expect(built).toHaveLength(1);
    expect(posted).toHaveLength(3);
  });

  // A worker that crashed has no thread left to answer, so a job posted to it would wait for a
  // reply nobody is going to send.
  it('refuses to post to a worker that has crashed', async () => {
    const on = service().openComposite();
    await expect(on.run(job('render', CRASH))).rejects.toThrow(/crashed/);
    await expect(on.run(job('render'))).rejects.toThrow(/crashed/);
    on.close();
  });
});

describe('ProcessingService.analyseAssembly', () => {
  usingMockWorker();

  const service = (): ProcessingService =>
    new ProcessingService({} as unknown as PhotoProcessingRepository, NO_PATHS, NO_LISTING, settings);
  const library = { id: LIB, root_path: '/nowhere' } as never;
  const sources = [
    { photoId: 'a', rawFilePath: '/nowhere/a.arw' },
    { photoId: 'b', rawFilePath: '/nowhere/b.arw' },
  ];

  it('asks for a carve rather than an align, and answers what the worker sent back', async () => {
    const on = service().openComposite();
    const answer = await service().analyseAssembly(LIB, sources, library, on, '/nowhere/volume.bin');
    on.close();

    // `composite: '{}'` is what this file's worker answers every composite job with.
    expect(answer).toBe('{}');
    expect(posted[0]).toMatchObject({ kind: 'composite', want: 'analyse', volumePath: '/nowhere/volume.bin' });
    // Keyed by the library, there being no row yet - and rendering nothing, so no targets.
    expect(posted[0]?.photoId).toBe(LIB);
    expect(posted[0]?.targets).toEqual([]);
  });

  it('refuses by name when the worker answers with nothing at all', async () => {
    class Silent extends MockWorker {
      override postMessage(job: RenditionJob | CompositeJob): void {
        queueMicrotask(() => this.onmessage?.({ data: { photoId: job.photoId, success: true } }));
      }
    }
    (globalThis as { Worker?: unknown }).Worker = Silent;
    const on = service().openComposite();
    await expect(service().analyseAssembly(LIB, sources, library, on, '/nowhere/volume.bin')).rejects.toThrow(
      /carved/,
    );
    on.close();
  });
});

describe('ProcessingService.solveSeams', () => {
  usingMockWorker();

  it('asks for a seam solve over the named volume, with the recipe tagged as an assembly', async () => {
    const recipe = { pick: [1], base: 0 } as never;
    const answer = await new ProcessingService(
      {} as unknown as PhotoProcessingRepository,
      NO_PATHS,
      NO_LISTING,
      settings,
    ).solveSeams(
      recipe,
      [[1], [0]],
      '/nowhere/seams.bin',
      { id: LIB, root_path: '/nowhere' } as never,
    );

    expect(answer).toBe('{}');
    expect(posted[0]).toMatchObject({
      kind: 'composite',
      want: 'seams',
      volumePath: '/nowhere/seams.bin',
      picks: [[1], [0]],
      recipe: { pick: [1], base: 0 },
    });
  });

  it('solves on a fresh worker once the one it kept has crashed', async () => {
    const service = new ProcessingService({} as unknown as PhotoProcessingRepository, NO_PATHS, NO_LISTING, settings);
    const library = { id: LIB, root_path: '/nowhere' } as never;

    await expect(service.solveSeams({} as never, [[0]], CRASH, library)).rejects.toThrow(/crashed/);
    expect(await service.solveSeams({} as never, [[0]], '/nowhere/seams.bin', library)).toBe('{}');
    expect(built).toHaveLength(2);
  });

  it('names a cancelled job as the native side fails one', () => {
    const planes = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', '..', 'native', 'rawshim', 'src', 'assembly_planes.rs'),
      'utf8',
    );
    expect(planes).toContain(`pub const CANCELLED: &str = "${JOB_CANCELLED}";`);
  });
});

/**
 * A copy of a canvas that a reader asked for by name, which is the only way the camera view of
 * one is ever made: nothing queues it, so nothing else would ever write its row.
 */
describe('ProcessingService.buildComposite', () => {
  usingMockWorker();

  it('records the copy it built, from the cameras pictures and against the documents behind it', async () => {
    const markCopyBuilt = jest.fn();
    const repo = { markCopyBuilt, builtFromOf: jest.fn(() => 'stamp-2') };
    const service = new ProcessingService(
      repo as unknown as PhotoProcessingRepository,
      NO_PATHS,
      NO_LISTING,
      settings,
      () => ({ doc: '{}', stamp: 'stamp-1' }),
      () => ({ id: LIB, root_path: '/nowhere' }) as never,
      () => ({ kind: 'panorama', recipe: { version: 1 }, sources: [{ photoId: 'a', rawFilePath: '/nowhere/a.arw' }] }),
    );

    expect(await service.buildComposite('panorama', { id: LIB, root_path: '/nowhere' } as never, 'embedded', false)).toBe(
      true,
    );

    // The cameras' own pictures, composited: the camera view of a canvas is that request and
    // nothing else, whatever the library builds its renditions from.
    expect(posted[0]?.targets[0]?.source).toBe('embedded');
    // Stamped against everything behind the canvas, or `stale` reads the copy as older than the
    // row the moment it is written.
    expect(markCopyBuilt.mock.calls[0]?.[2]).toBe('stamp-2');
    expect(markCopyBuilt.mock.calls[0]?.[3]).toBe('embedded');
  });
});

/**
 * A composite the queue found owing its copies, whichever kind it is.
 *
 * A row that is not `kind: 'file'` has no stages at all (`toStages` answers null for one), so a
 * composite the composite pass skips is a row whose `needs_tile`/`needs_renditions` flags nothing
 * will ever clear - it comes back on every batch for the life of the library and is never built.
 */
describe('the composites a batch finds owed', () => {
  usingMockWorker();

  const ASSEMBLY = RecipeSchema.parse({
    ...JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'test', 'fixtures', 'assembly-recipe.json'), 'utf8')),
    kind: 'assembly',
  });
  if (ASSEMBLY.kind === 'file') throw new Error('the assembly fixture parsed as a file recipe');

  it('builds an assembly at the canvas its crop comes out of at a tile size', async () => {
    const markTileBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [
        {
          photo_id: 'assembly1',
          root_path: '/nowhere',
          library_id: LIB,
          recipe: ASSEMBLY,
          rendition_source: 'render' as const,
          needs_tile: 1,
          needs_renditions: 0,
          library_rendition_source: 'render' as const,
          rendition_hdr: 0,
          edits: null,
          edits_stamp: null,
          inputs_edited: 0,
          built_from: null,
        },
      ]),
      markTileBuilt,
      markRenditionsBuilt: jest.fn(),
      markRenditionsUnowed: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;
    const service = new ProcessingService(
      repo,
      NO_PATHS,
      NO_LISTING,
      settingsWith({ grid_rendition_size: 800 }),
      () => null,
      () => ({ id: LIB, root_path: '/nowhere' }) as never,
      () => ({ kind: 'assembly', recipe: ASSEMBLY, sources: [{ photoId: 'a', rawFilePath: '/nowhere/a.arw' }] }),
    );

    await service.processUnprocessed({ libraryId: LIB });

    expect(posted.map((job) => job.photoId)).toEqual(['assembly1']);
    // Not a panorama's size, and not the tile size either: an assembly is framed as one frame, and
    // the frame is its crop, so the canvas is asked for at whatever leaves the crop 800 long
    // (`canvasLongEdgeFor`). The fixture's crop is 0.975 of the canvas's long edge.
    expect(posted[0]?.targets[0]?.size).toBe(canvasLongEdgeFor(ASSEMBLY, 800));
    expect(posted[0]?.targets[0]?.size).toBeGreaterThan(800);
    expect(markTileBuilt).toHaveBeenCalled();
  });
});

/**
 * A canvas is several frames wide, so the sizes that frame one photograph frame a smear of it:
 * 3840 across a twenty-six frame pan leaves each frame under 150 pixels, and the tile is worse.
 */
describe('the sizes a composite is framed to', () => {
  usingMockWorker();

  async function sizeOf(
    rendition: 'grid' | 'full' | 'embedded',
    overrides: Partial<Settings> = {},
    kind: 'panorama' | 'assembly' = 'panorama',
  ): Promise<number> {
    const service = new ProcessingService(
      {} as unknown as PhotoProcessingRepository,
      NO_PATHS,
      NO_LISTING,
      settingsWith(overrides),
    );
    const on = service.openComposite();
    await service.buildCompositeRendition(
      'panorama',
      [],
      { version: 1 },
      kind,
      { id: LIB, root_path: '/nowhere', render_skip_full: [], render_skip_max: [] } as never,
      rendition,
      false,
      'embedded',
      on,
    );
    on.close();
    // The last, not the first: two calls in one test share the recording.
    return posted.at(-1)?.targets[0]?.size ?? -1;
  }

  /**
   * And an assembly is not framed that way. Its canvas is the *intersection* of near-identical
   * frames (§2.6 of the take-best-parts design), so it is about one frame's own size - a tile four
   * times larger than that buys nothing, and a viewer copy at the panorama setting is a decode of
   * every frame at four hundred megapixels for a picture the size of one of them.
   */
  it('frames an assembly as one frame rather than as a canvas several frames wide', async () => {
    expect(await sizeOf('grid', { grid_rendition_size: 800 }, 'assembly')).toBe(800);
    expect(
      await sizeOf('full', { full_rendition_size: 3840, panorama_full_rendition_size: 16384 }, 'assembly'),
    ).toBe(3840);
    // And its camera view is the viewer's copy of it, exactly as a panorama's is: sized off the
    // canvas instead, an assembly on a library serving the cameras' pictures composites every
    // frame at native resolution the first time anybody opens one.
    expect(
      await sizeOf('embedded', { full_rendition_size: 3840, panorama_full_rendition_size: 16384 }, 'assembly'),
    ).toBe(3840);
  });

  it('frames the viewer copy to the panorama setting rather than the photograph one', async () => {
    expect(await sizeOf('full', { full_rendition_size: 3840, panorama_full_rendition_size: 16384 })).toBe(16384);
  });

  it('frames the tile larger than a photograph tile, with no second setting to keep in step', async () => {
    expect(await sizeOf('grid', { grid_rendition_size: 800 })).toBe(3200);
  });

  // The cameras' own view of a canvas is what a library serving their pictures opens a panorama
  // at, so it is the size the viewer's copy is rather than the four hundred megapixels the frames
  // would make. `max` is what asks for native resolution.
  it('frames the cameras own view of a canvas as the viewer copy, not as the canvas', async () => {
    expect(await sizeOf('embedded', { panorama_full_rendition_size: 16384 })).toBe(16384);
  });
});
const NO_PATHS = {} as unknown as PhotoPathsRepository;
const NO_LISTING = {} as unknown as PhotoListingRepository;
