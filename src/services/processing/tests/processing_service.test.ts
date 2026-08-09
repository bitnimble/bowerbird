import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../../../schemas/settings';
import type { PendingPhoto, PhotosRepository } from '../../photos/photos_repository';
import type { SettingsRepository } from '../../settings/settings_repository';
import { dataPathForLibraryId } from '../../../utils/paths';
import { ProcessingService } from '../processing_service';
import type { RenditionJob, ProcessingResult, RenditionSource } from '../processing_types';

const CRASH = 'crash-photo';
// This file's own library id, because the data directory is keyed by one (§6)
// and two test files sharing a directory would race each other's cleanup.
const LIB = 'processing-service-test';

/** Every job the service handed to a worker, so its shape can be asserted. */
const posted: RenditionJob[] = [];

const DESCRIPTOR = new Uint8Array([1, 2, 3]);

// Fake Worker: a job for CRASH fires onerror (a native-crash-like event, which
// skips the worker's own catch); everything else reports success.
class MockWorker {
  onmessage: ((event: { data: ProcessingResult }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: string) {}
  postMessage(job: RenditionJob): void {
    posted.push(job);
    queueMicrotask(() => {
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

function photoStage(job: { photoId: string; targets: { rendition: string }[] }): string {
  return job.photoId + ':' + job.targets[0]!.rendition;
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
      file_path: `${photoId}.arw`,
      root_path: root,
      library_id: LIB,
      rendition_source: 'render',
      needs_tile: 1,
      needs_renditions: 1,
      library_rendition_source: 'render',
      rendition_hdr: 0,
      // Unedited, which is what every test in this file is about: the photo grades as the
      // camera metered it. `edits` is exercised in `exposure` below.
      edits: null,
    };
  }

  it('carries a saved exposure to every job as a gain, not as stops', async () => {
    // The shader's uniform is a multiplier and the document holds EV, so the conversion
    // has to happen somewhere. Pinned because sending stops would not fail: `2` is a legal
    // gain, so a photo edited to +2 EV would render four stops up and nothing would say so.
    const repo = {
      listPendingProcessing: jest.fn(() => [
        { ...pending('a'), edits: JSON.stringify({ version: 1, exposure: 2 }) },
      ]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    // Both jobs: the tile and the renditions are the same picture, so they cannot
    // disagree about the exposure it was taken at.
    expect(posted.map((job) => job.exposure)).toEqual([4, 4]);
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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settingsWith({})).processUnprocessed({ libraryId: 'lib' });

    // A rendition of the picture as the camera metered it is a worse rendition than the
    // reader asked for, and a far better outcome than a photo that never builds one. The
    // out-of-range document is the same case: the schema refuses it, so it reads as absent.
    expect(posted.map((job) => job.exposure)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('passes the embedded-JPEG matching setting through to the worker', async () => {
    // The worker cannot read config, so a job that does not carry the flag leaves
    // the feature permanently off however the server is configured.
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a')]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    // Two jobs per photo now - the grid tile, then the renditions - and the flag has
    // to reach both, since the tile can fall back to a render and needs the match too.
    await new ProcessingService(repo, settingsWith({ match_embedded_jpeg: true })).processUnprocessed({ libraryId: 'lib' });
    expect(posted.map((job) => job.matchEmbeddedJpeg)).toEqual([true, true]);

    posted.length = 0;
    await new ProcessingService(repo, settingsWith({ match_embedded_jpeg: false })).processUnprocessed({ libraryId: 'lib' });
    expect(posted.map((job) => job.matchEmbeddedJpeg)).toEqual([false, false]);
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
    } as unknown as PhotosRepository;

    await new ProcessingService(
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

  it('hands over the descriptor from a tile repaired on demand, not just a queued one', async () => {
    // The repair path builds a grid tile outside the queue (§18.6), so it computes a
    // descriptor exactly as an import does - and used to drop it on the floor, which
    // left a photo whose tile had been rebuilt permanently unstackable. Nothing
    // revisits a tile that is now on disk, so there was no second chance at it.
    const repo = { markTileBuilt: jest.fn(), markRenditionsBuilt: jest.fn() } as unknown as PhotosRepository;
    const service = new ProcessingService(repo, settingsWith({}));
    const seen: { photoId: string; descriptor: Uint8Array }[] = [];
    service.onDescribed((photoId, descriptor) => seen.push({ photoId, descriptor }));

    const library = { id: 'lib', root_path: root } as never;
    await service.renderOne('/lib/a.arw', 'p1', library, 'grid', false, 'embedded');

    expect(seen).toEqual([{ photoId: 'p1', descriptor: DESCRIPTOR }]);

    // A viewer rendition produces none, so this is not just "forward whatever came
    // back" - it is the tile that carries one.
    seen.length = 0;
    await service.renderOne('/lib/a.arw', 'p1', library, 'full', false);
    expect(seen).toEqual([]);
  });

  it('moves the stamp belonging to what a one-off job actually wrote', async () => {
    // The queue splits a photo into a tile job and a renditions job, so which stamp to
    // move is never in question there. A one-off job carries its own targets, and
    // deriving the stage from them wrongly is silent: a tile that lands with
    // `tile_built_at` unset is never revisited, because it is now on disk.
    const markTileBuilt = jest.fn();
    const markRenditionsBuilt = jest.fn();
    const repo = { markTileBuilt, markRenditionsBuilt } as unknown as PhotosRepository;
    const service = new ProcessingService(repo, settingsWith({}));
    const library = { id: 'lib', root_path: root, data_path: null } as never;

    await service.renderOne('/lib/a.arw', 'p1', library, 'grid', false, 'embedded');
    expect(markTileBuilt).toHaveBeenCalledTimes(1);
    expect(markRenditionsBuilt).not.toHaveBeenCalled();

    markTileBuilt.mockClear();
    await service.renderOne('/lib/a.arw', 'p1', library, 'full', false);
    expect(markRenditionsBuilt).toHaveBeenCalledTimes(1);
    expect(markTileBuilt).not.toHaveBeenCalled();

    // A max export moves neither. It is discovered by stat'ing the file, so no column
    // records it - and counted as the viewer's renditions it would stamp
    // `rendition_source` 'render' on a library serving the camera's JPEG, and clear
    // `needs_renditions` while a full rendition was still owed.
    markRenditionsBuilt.mockClear();
    await service.renderOne('/lib/a.arw', 'p1', library, 'max', false);
    expect(markRenditionsBuilt).not.toHaveBeenCalled();
    expect(markTileBuilt).not.toHaveBeenCalled();
  });

  it('refuses an HDR grid tile rather than quietly building an SDR one', async () => {
    // `hdr` is the caller's, unlike the chroma setting above, so a caller that asks
    // for something that cannot exist is told. Coercing instead put the mistake
    // somewhere nobody would ever read it, and the mistake is not harmless:
    // `renditionDir` gives no HDR grid path, so an honoured request would encode HDR
    // and file it as SDR - a tile that decodes wrong rather than one that is large.
    //
    // Rejecting is only half the claim; the test above is the other half, building a
    // grid target and asserting on it, so this cannot pass by refusing everything.
    // It rejects rather than throwing, which is also load-bearing: the tile repair
    // calls this fire-and-forget and clears its in-flight set in a `.finally()`.
    const service = new ProcessingService({} as unknown as PhotosRepository, settingsWith({}));
    const library = { id: 'lib', root_path: '/lib' } as never;

    await expect(service.renderOne('/lib/a.arw', 'p1', library, 'grid', true, 'embedded')).rejects.toThrow(
      /grid tile is always SDR/,
    );
  });

  it('marks each photo processed and drains the pool without hanging', async () => {
    const markRenditionsBuilt = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b'), pending('c')]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

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
    } as unknown as PhotosRepository;

    // Must resolve (not hang): applyResult swallows the throw so the pool's
    // assignNext/terminate bookkeeping still runs for every job.
    await expect(new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' })).resolves.toBeUndefined();
    expect(markRenditionsBuilt).toHaveBeenCalledTimes(2);
  });

  it('builds every grid tile before any rendition, and clears each flag as its stage lands', async () => {
    // The whole point of the split. A tile is ~125ms where a rendition is ~1.5s, so
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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    const order = posted.map((job) => photoStage(job));
    expect(order).toEqual(['a:grid', 'b:grid', 'a:full', 'b:full']);
    // Each stage clears its own, so a run interrupted between the passes comes back
    // owing only the second.
    //
    // The tile is stamped twice per photo, which is the point rather than a slip: the
    // first pass writes it from the camera's JPEG so the grid fills at ~125ms a photo,
    // and the render pass overwrites it from the same pixels the viewer gets. The stamp
    // has to move both times or a client keeps asking for the first one.
    expect(markTileBuilt.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'a', 'b']);
    expect(markRenditionsBuilt.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('resumes at the stage a photo still owes rather than rebuilding the tile', async () => {
    // What the split flags buy over one: an import interrupted after the tiles came
    // back needing both passes redone, and a tile is 125ms per photo of work that
    // was already on disk.
    const repo = {
      listPendingProcessing: jest.fn(() => [{ ...pending('a'), needs_tile: 0 }]),
      markTileBuilt: jest.fn(),
      markRenditionsBuilt: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid']);
    expect(markRenditionsBuilt).not.toHaveBeenCalled();
    // The sweep is fire-and-forget, so give it the chance to be wrong.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(full)).toBe(true);
  });

  it('announces each stage as it lands, with the stamp that stage wrote', async () => {
    // Splitting the passes exists so a grid is browsable at the tile's pace (~125ms)
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
    } as unknown as PhotosRepository;

    const announced: { photoId: string; stage: string; version: string }[] = [];
    const service = new ProcessingService(repo, settings);
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
    expect(markTileBuilt).toHaveBeenCalledWith('a', announced[0]?.version);
    expect(markRenditionsBuilt).toHaveBeenCalledWith('a', announced[1]?.version, 'render');
    expect(markTileBuilt).toHaveBeenCalledWith('a', announced[2]?.version);
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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });
    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid', 'a:full']);
    expect(stored).toBe('render');

    posted.length = 0;
    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });
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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' });

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
    } as unknown as PhotosRepository;
    const service = new ProcessingService(repo, settings);

    // second call coalesces into the first and flags a rerun; both drain.
    const first = service.processUnprocessed({ libraryId: 'lib' });
    const second = service.processUnprocessed({ libraryId: 'lib' });
    expect(second).toBe(first); // same in-flight promise
    await Promise.all([first, second]);

    // 'render', because that is what the viewer gets on this library. Not the tile's
    // own source, which is always the embedded JPEG and would say 'embedded' here for
    // every photo on every library.
    expect(markRenditionsBuilt).toHaveBeenCalledWith('a', expect.any(String), 'render');
    expect(markRenditionsBuilt).toHaveBeenCalledWith('b', expect.any(String), 'render');
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
    } as unknown as PhotosRepository;

    await expect(new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' })).resolves.toBeUndefined();
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
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' }, () => stopped);

    // Two workers, so two tiles were already posted when the first came back. Not
    // c or d, and no ':full' at all: the rendition pass never starts.
    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid', 'b:grid']);
  });

  it('does nothing when there is no pending work', async () => {
    const repo = { listPendingProcessing: jest.fn(() => []) } as unknown as PhotosRepository;
    await expect(new ProcessingService(repo, settings).processUnprocessed({ libraryId: 'lib' })).resolves.toBeUndefined();
  });
});
