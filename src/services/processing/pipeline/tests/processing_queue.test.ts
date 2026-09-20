import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileRecipe } from '../../../../schemas/recipes';
import type { PhotoListingRepository } from '../../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import type { PendingPhoto, PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { dataPathForLibraryId } from '../../../../utils/paths';
import { ProcessingService } from '../processing_service';
import type { CompositeJob, RenditionJob, RenditionSource } from '../../workers/processing_types';
import { CRASH, LIB, MockWorker, REAL_WORKER, posted, settings, settingsWith } from './processing_test_helpers';

function photoStage(job: RenditionJob | CompositeJob): string {
  return job.photoId + ':' + (job.targets[0]?.rendition ?? 'none');
}

function makeProcessingService(
  photoProcessing: PhotoProcessingRepository,
  currentSettings: ConstructorParameters<typeof ProcessingService>[3],
): ProcessingService {
  return new ProcessingService(
    photoProcessing,
    {} as unknown as PhotoPathsRepository,
    {} as unknown as PhotoListingRepository,
    currentSettings,
  );
}

describe('ProcessingService.processUnprocessed', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bb-proc-'));
    posted.length = 0;
    (globalThis as { Worker?: unknown }).Worker = MockWorker;
  });
  afterEach(() => {
    globalThis.Worker = REAL_WORKER;
    rmSync(root, { recursive: true, force: true });
    rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
  });

  // Generated files live outside the library root, keyed by library id (§6).
  const renditions = (dir: string): string => path.join(dataPathForLibraryId(LIB), 'renditions', dir);

  function pending(photoId: string): PendingPhoto {
    return {
      photo_id: photoId,
      root_path: root,
      library_id: LIB,
      recipe: fileRecipe(`${photoId}.arw`),
      rendition_source: 'render',
      needs_tile: 1,
      needs_renditions: 1,
      library_rendition_source: 'render',
      rendition_hdr: 0,
      // Unedited, which is what every test in this file is about: the photo grades as the
      // camera metered it. `edits` is exercised in `exposure` below.
      edits: null,
      edits_stamp: null,
      // A photograph composes no rows, so there is nothing behind it to be edited.
      inputs_edited: 0,
      built_from: null,
    };
  }

  it('carries a saved exposure to every job in the stops the document holds', async () => {
    // Stops all the way to the shader, which raises them once for both hosts. Pinned because
    // converting here would not fail: `4` is a legal exposure, so a photo edited to +2 EV
    // would render four stops up and nothing would say so - which is what happened while the
    // editor and this path each did the raising, and is why neither does now.
    const repo = {
      listPendingProcessing: jest.fn(() => [
        { ...pending('a'), edits: JSON.stringify({ version: 1, exposure: 2 }) },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    // Both jobs: the tile and the renditions are the same picture, so they cannot
    // disagree about the exposure it was taken at.
    expect(posted.map((job) => job.exposure)).toEqual([2, 2]);
  });

  it('passes the tonal and colour sliders through on their own scales', async () => {
    // Unlike the exposure, these are *not* converted: `EditDoc` holds Camera Raw's own
    // -100..100 and `adjust.slang` is written against it, which is the whole reason the
    // schema borrowed those ranges. A conversion appearing here would be the bug.
    const repo = {
      listPendingProcessing: jest.fn(() => [
        {
          ...pending('a'),
          edits: JSON.stringify({
            version: 1,
            contrast: 20,
            highlights: -40,
            shadows: 15,
            whites: 8,
            blacks: -12,
            vibrance: 30,
            saturation: -5,
            texture: 25,
            clarity: -18,
            dehaze: 7.5,
            temperature: 4800,
            tint: -6,
          }),
        },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    expect(posted[0]?.adjust).toEqual({
      contrast: 20,
      highlights: -40,
      shadows: 15,
      whites: 8,
      blacks: -12,
      vibrance: 30,
      saturation: -5,
      texture: 25,
      clarity: -18,
      // A real where its neighbours are integers, which is `crs:Dehaze`'s own oddity and
      // has to survive the trip rather than being rounded on the way.
      dehaze: 7.5,
      // Absolute Kelvin, not an offset from what the camera metered. What it is *relative to*
      // is the decode's own illuminant, which the job never sees and could not carry.
      temperature: 4800,
      tint: -6,
      colourProfile: 'matched',
    });
    // And on both jobs, so the tile and the full view cannot disagree about the picture.
    expect(posted[1]?.adjust).toEqual(posted[0]?.adjust);
  });

  it('carries the crop as fractions, with the edges in the order the gather reads them', async () => {
    const repo = {
      listPendingProcessing: jest.fn(() => [
        {
          ...pending('a'),
          edits: JSON.stringify({
            version: 1,
            cropLeft: 0.2,
            cropTop: 0.1,
            cropRight: 0.9,
            cropBottom: 0.8,
            cropAngle: 3,
            rotate: 90,
          }),
        },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    // Left, top, right, bottom - the order `image::Geometry` destructures. A transposed
    // pair here is a crop of the wrong rectangle, which no type on either side would catch
    // because all four are the same shape.
    expect(posted[0]?.geometry).toEqual({
      crop: [0.2, 0.1, 0.9, 0.8],
      angleDegrees: 3,
      rotate: 90,
      keystone: null,
    });
  });

  it('carries the perspective correction the editor solved, in the order the gather reads it', async () => {
    // The document's own eight, row-major. This is the only hop the correction takes to the
    // renderer, and a rendition built without it is a differently-shaped photograph from the
    // one the reader approved - which nothing downstream would report.
    const keystone = [1.98, 0, 0, 0, 2.52, -0.27, 0, 1.09];
    const repo = {
      listPendingProcessing: jest.fn(() => [
        { ...pending('a'), edits: JSON.stringify({ version: 1, keystone }) },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    expect(posted[0]?.geometry.keystone).toEqual(keystone);
  });

  it('renders as metered where the photo has no edits, or a document it cannot read', async () => {
    const repo = {
      listPendingProcessing: jest.fn(() => [
        pending('a'),
        { ...pending('b'), edits: 'not json' },
        { ...pending('c'), edits: JSON.stringify({ version: 1, exposure: 99 }) },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    // A rendition of the picture as the camera metered it is a worse rendition than the
    // reader asked for, and a far better outcome than a photo that never builds one. The
    // out-of-range document is the same case: the schema refuses it, so it reads as absent.
    expect(posted.map((job) => job.exposure)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('renders an edited photo even where the library serves the camera JPEG', async () => {
    // The default library builds no renditions at all and serves the embedded JPEG. That
    // JPEG cannot carry an edit, so without this the reader sees their change in the
    // editor and nowhere else - permanently, and with nothing saying why.
    const repo = {
      listPendingProcessing: jest.fn(() => [
        { ...pending('plain'), rendition_source: null, library_rendition_source: 'embedded' },
        {
          ...pending('edited'),
          rendition_source: null,
          library_rendition_source: 'embedded',
          edits: JSON.stringify({ version: 1, exposure: 1 }),
        },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    // The untouched photo keeps its 18ms tile and builds nothing else; only the one
    // somebody worked on pays for a render.
    expect(posted.map((job) => photoStage(job))).toEqual([
      'plain:grid',
      'edited:grid',
      'edited:full',
    ]);
  });

  it('passes the embedded-JPEG matching setting through to the worker', async () => {
    // The worker cannot read config, so a job that does not carry the flag leaves
    // the feature permanently off however the server is configured.
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a')]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    // Two jobs per photo now - the grid tile, then the renditions - and the flag has
    // to reach both, since the tile can fall back to a render and needs the match too.
    await makeProcessingService(repo, settingsWith({ match_embedded_jpeg: true })).processUnprocessed({ libraryId: 'lib' });
    expect(posted.map((job) => job.kind === 'rendition' && job.matchEmbeddedJpeg)).toEqual([true, true]);

    posted.length = 0;
    await makeProcessingService(repo, settingsWith({ match_embedded_jpeg: false })).processUnprocessed({ libraryId: 'lib' });
    expect(posted.map((job) => job.kind === 'rendition' && job.matchEmbeddedJpeg)).toEqual([false, false]);
  });

  it('keeps the grid tile subsampled while the rendition beside it follows the setting', async () => {
    // `sdr_full_chroma` does not cover the grid: a tile is 800px in a wall of other
    // tiles and its usual source is the camera's already-subsampled JPEG, so 4:4:4
    // would store chroma the source never had. Pinned because it is a setting a
    // caller can turn on, and a tile that quietly followed it would still encode,
    // still be the right size, and show up only as an import that got slower.
    const repo = {
      listPendingProcessing: jest.fn(() => [{ ...pending('a'), rendition_hdr: 1 }]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(
      repo,
      settingsWith({ sdr_full_chroma: true, hdr_still_full_chroma: true }),
    ).processUnprocessed({ libraryId: 'lib' });

    const targets = posted.flatMap((job) => job.targets);
    const grid = targets.find((target) => target.rendition === 'grid');
    expect(grid?.sdrFullChroma).toBe(false);
    expect(grid?.hdr).toBe(false);
    // The rendition that does take the settings still does, or this would pass with
    // them simply not plumbed through.
    const full = targets.find((target) => target.rendition === 'full');
    expect(full?.hdr).toBe(true);
    expect(full?.sdrFullChroma).toBe(true);
  });

  it('marks each photo processed and drains the pool without hanging', async () => {
    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b'), pending('c')]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    expect(markRenditionsBuilt).toHaveBeenCalledTimes(3);
  });

  it('a DB write failure in applyResult does not hang the pool', async () => {
    const markRenditionsBuilt = jest.fn(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b')]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    // Must resolve (not hang): applyResult swallows the throw so the pool's
    // assignNext/terminate bookkeeping still runs for every job.
    await expect(makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' })).resolves.toBeUndefined();
    expect(markRenditionsBuilt).toHaveBeenCalledTimes(2);
  });

  it('builds every grid tile before any rendition, and clears each flag as its stage lands', async () => {
    // The whole point of the split. A tile is ~18ms where a rendition is ~1.5s, so
    // interleaving them would make a 2000-frame shoot's grid take as long as the
    // renders do. Nothing else pins the ordering, so a future refactor that fused the
    // passes back together would be invisible.
    const markTileBuilt = jest.fn();
    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b')]),
      markTileBuilt,
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    const order = posted.map((job) => photoStage(job));
    expect(order).toEqual(['a:grid', 'b:grid', 'a:full', 'b:full']);
    // Each stage clears its own, so a run interrupted between the passes comes back
    // owing only the second.
    //
    // The tile is stamped twice per photo, which is the point rather than a slip: the
    // first pass writes it from the camera's JPEG so the grid fills at ~18ms a photo,
    // and the render pass overwrites it from the same pixels the viewer gets. The stamp
    // has to move both times or a client keeps asking for the first one.
    expect(markTileBuilt.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'a', 'b']);
    expect(markRenditionsBuilt.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('settles a photo that owes renditions it has none of, rather than asking about it forever', async () => {
    // A library serving the camera's JPEG builds no renditions, and its tile was adopted from
    // the scan - so neither pass posts a job and nothing clears `needs_renditions`. Left alone
    // it is a row every batch re-reads and never finishes, for the life of the library.
    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [
        { ...pending('a'), needs_tile: 0, rendition_source: 'embedded' as RenditionSource, library_rendition_source: 'embedded' as RenditionSource },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: LIB });

    expect(posted).toEqual([]); // nothing to build: both files are already on disk
    expect(markRenditionsBuilt.mock.calls.map((c) => [c[0], c[2]])).toEqual([['a', 'embedded']]);
  });

  it('resumes at the stage a photo still owes rather than rebuilding the tile', async () => {
    // What the split flags buy over one: an import interrupted after the tiles came
    // back needing both passes redone, and a tile is 18ms per photo of work that
    // was already on disk.
    const repo = {
      listPendingProcessing: jest.fn(() => [{ ...pending('a'), needs_tile: 0 }]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    expect(posted.map((job) => photoStage(job))).toEqual(['a:full']);
  });

  it('keeps the grid tile a resumed run is not rebuilding', async () => {
    // The sweep drops every derived copy this run did not write, because they are of
    // the old file. The tile of a run resumed at its second pass is not: its own pass
    // already rebuilt it, and `needs_tile` is clear - so deleting it left the grid
    // blank with nothing that would ever build it again.
    const gridDir = renditions('grid');
    mkdirSync(gridDir, { recursive: true });
    const tile = path.join(gridDir, 'a.avif');
    writeFileSync(tile, 'kept');

    const repo = {
      listPendingProcessing: jest.fn(() => [{ ...pending('a'), needs_tile: 0 }]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    // The sweep is fire-and-forget, so give it the chance to be wrong.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(tile)).toBe(true);
  });

  it('rebuilds a tile on its own without touching the renditions beside it', async () => {
    // The grid's own action, on a file whose pixels have not changed: stamping the
    // viewer's side here would sweep every rendition this run did not write, so
    // regenerating a rendition deleted the photo view's copies behind it.
    const fullDir = renditions('full');
    mkdirSync(fullDir, { recursive: true });
    const full = path.join(fullDir, 'a.avif');
    writeFileSync(full, 'kept');

    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [{ ...pending('a'), needs_renditions: 0 }]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid']);
    expect(markRenditionsBuilt).not.toHaveBeenCalled();
    // The sweep is fire-and-forget, so give it the chance to be wrong.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(full)).toBe(true);
  });

  it('announces each stage as it lands, with the stamp that stage wrote', async () => {
    // Splitting the passes exists so a grid is browsable at the tile's pace (~18ms)
    // rather than the render's (~1.5s). A client hears about a photo through these
    // announcements, so raising one only at the end would hand that back: the tile
    // would be on disk with nobody told for a second and a half.
    const markTileBuilt = jest.fn();
    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a')]),
      markTileBuilt,
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    const announced: { photoId: string; stage: string; version: string }[] = [];
    const service = makeProcessingService(repo, settings);
    service.onProcessed((photoId, written) => announced.push({ photoId, ...written }));
    await service.processUnprocessed({ libraryId: 'lib' });

    // The tile twice: once from the camera's JPEG at the tile's pace, then again from
    // the render, because the second one is a different picture and not a re-encode of
    // the first. A client hears about both, which is what makes the grid sharpen in
    // place as the queue reaches each photo.
    expect(announced.map((a) => a.stage)).toEqual(['tile', 'renditions', 'tile']);
    // Each carries the stamp its own write put on the row, and only that one moves:
    // a client builds the URL out of that column, so an announcement ahead of the row
    // would be walked back by the next list read - and a tile whose stamp moved for
    // a rendition rebuild would be re-fetched for bytes that had not changed.
    // And each says what it actually is: the camera's JPEG first, then the render that replaced
    // it, with whether the match warped that render into the camera's own geometry - which
    // together are what let the panorama alignment search a tile instead of opening the RAW.
    expect(markTileBuilt).toHaveBeenCalledWith('a', announced[0]?.version, null, {
      from: 'embedded',
      matched: false,
    });
    expect(markRenditionsBuilt).toHaveBeenCalledWith('a', announced[1]?.version, 'render', null, 'full');
    expect(markTileBuilt).toHaveBeenCalledWith('a', announced[2]?.version, null, { from: 'render', matched: true });
  });

  it('records what the viewer gets, so a second import still rebuilds the renditions', async () => {
    // `rendition_source` is written when the renditions land, and read straight back by the
    // next import to decide whether the viewer's renditions get built. Recording the
    // tile's own source instead put 'embedded' there for every photo, whatever the
    // library said - so the second import built the tile alone, and the sweep then
    // deleted the `full` it had declined to rebuild, with nothing to ever restore it.
    let stored: RenditionSource | null = 'render';
    const repo = {
      listPendingProcessing: jest.fn(() => [{ ...pending('a'), rendition_source: stored }]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn((_id: string, _at: string, source: RenditionSource) => {
        stored = source;
      }),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });
    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid', 'a:full']);
    expect(stored).toBe('render');

    posted.length = 0;
    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });
    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid', 'a:full']);
  });

  it('on a worker crash of a present file: marks it failed and deletes stale renditions', async () => {
    const gridDir = renditions('grid');
    const fullDir = renditions('full');
    mkdirSync(gridDir, { recursive: true });
    mkdirSync(fullDir, { recursive: true });
    const staleSmall = path.join(gridDir, `${CRASH}.avif`);
    const staleFull = path.join(fullDir, `${CRASH}.avif`);
    writeFileSync(staleSmall, 'stale');
    writeFileSync(staleFull, 'stale');
    writeFileSync(path.join(root, `${CRASH}.arw`), ''); // source still present -> real failure

    const markProcessingFailed = jest.fn();
    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('ok'), pending(CRASH)]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed,
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    expect(markProcessingFailed).toHaveBeenCalledWith(CRASH, expect.stringContaining('crashed'));
    for (let i = 0; i < 25 && (existsSync(staleSmall) || existsSync(staleFull)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(staleSmall)).toBe(false);
    expect(existsSync(staleFull)).toBe(false);
  });

  it('a crash whose source file has moved/gone is NOT marked failed (left for retry)', async () => {
    // No `${CRASH}.arw` created: the source is gone, so the failure is transient.
    const markProcessingFailed = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending(CRASH)]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed,
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    expect(markProcessingFailed).not.toHaveBeenCalled();
  });

  it('drains work that becomes pending while a batch is already running (rerun)', async () => {
    const markRenditionsBuilt = jest.fn();
    let call = 0;
    const listPendingProcessing = jest.fn(() => {
      call += 1;
      if (call === 1) return [pending('a')];
      if (call === 2) return [pending('b')];
      return [];
    });
    const repo = {
      listPendingProcessing,
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;
    const service = makeProcessingService(repo, settings);

    // second call coalesces into the first and flags a rerun; both drain.
    const first = service.processUnprocessed({ libraryId: 'lib' });
    const second = service.processUnprocessed({ libraryId: 'lib' });
    expect(second).toBe(first); // same in-flight promise
    await Promise.all([first, second]);

    // 'render', because that is what the viewer gets on this library. Not the tile's
    // own source, which is always the embedded JPEG and would say 'embedded' here for
    // every photo on every library.
    expect(markRenditionsBuilt).toHaveBeenCalledWith('a', expect.any(String), 'render', null, 'full');
    expect(markRenditionsBuilt).toHaveBeenCalledWith('b', expect.any(String), 'render', null, 'full');
  });

  it('leaves jobs pending (no hang, no throw) when a worker cannot be spawned', async () => {
    class ThrowingWorker {
      constructor(_url: string) {
        throw new Error('EAGAIN: thread exhaustion');
      }
    }
    (globalThis as { Worker?: unknown }).Worker = ThrowingWorker;
    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b')]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await expect(makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' })).resolves.toBeUndefined();
    expect(markRenditionsBuilt).not.toHaveBeenCalled(); // untouched -> both flags still set
  });

  it('stops handing out jobs once the run is stopped, and does not start the second pass', async () => {
    // What a stopped sync (§9.10) actually buys: the pool stops feeding its
    // workers rather than running the import out to the end. The two in flight
    // when the stop lands still finish - killing a worker mid-encode would leave
    // a half-written rendition - so the tiles already queued are the last of it.
    let stopped = false;
    const markTileBuilt = jest.fn(() => {
      stopped = true;
    });
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b'), pending('c'), pending('d')]),
      markTileBuilt,
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotoProcessingRepository;

    await makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' }, () => stopped);

    // Two workers, so two tiles were already posted when the first came back. Not
    // c or d, and no ':full' at all: the rendition pass never starts.
    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid', 'b:grid']);
  });

  it('does nothing when there is no pending work', async () => {
    const repo = { listPendingProcessing: jest.fn(() => []) } as unknown as PhotoProcessingRepository;
    await expect(makeProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' })).resolves.toBeUndefined();
  });
});
