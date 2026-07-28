import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../../../config';
import type { PendingPhoto, PhotosRepository } from '../../photos/photos_repository';
import { ProcessingService } from '../processing_service';
import type { RenditionJob, ProcessingResult, ThumbnailSource } from '../processing_types';

const CRASH = 'crash-photo';

/** Every job the service handed to a worker, so its shape can be asserted. */
const posted: RenditionJob[] = [];

// Fake Worker: a job for CRASH fires onerror (a native-crash-like event, which
// skips the worker's own catch); everything else reports success.
class MockWorker {
  onmessage: ((event: { data: ProcessingResult }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: string) {}
  postMessage(job: RenditionJob): void {
    posted.push(job);
    queueMicrotask(() => {
      if (job.photoId === CRASH) this.onerror?.({ message: 'segfault' });
      else this.onmessage?.({ data: { photoId: job.photoId, success: true } });
    });
  }
  terminate(): void {}
}

const config = {
  processingConcurrency: 2,
  smallThumbnailSize: 800,
  fullThumbnailSize: 3840,
  smallThumbnailQuality: 80,
  fullThumbnailQuality: 90,
} as Config;

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
    delete (globalThis as { Worker?: unknown }).Worker;
    rmSync(root, { recursive: true, force: true });
  });

  function pending(photoId: string): PendingPhoto {
    return {
      photo_id: photoId,
      file_path: `${photoId}.arw`,
      root_path: root,
      data_path: null,
      rendition_source: 'render',
      preview_source: 'render',
      preview_hdr: 0,
      preview_hdr_video: 0,
    };
  }

  it('passes the embedded-JPEG matching setting through to the worker', async () => {
    // The worker cannot read config, so a job that does not carry the flag leaves
    // the feature permanently off however the server is configured.
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a')]),
      markProcessed: jest.fn(),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    // Two jobs per photo now - the grid tile, then the renditions - and the flag has
    // to reach both, since the tile can fall back to a render and needs the match too.
    await new ProcessingService(repo, { ...config, matchEmbeddedJpeg: true } as Config).processUnprocessed('lib');
    expect(posted.map((job) => job.matchEmbeddedJpeg)).toEqual([true, true]);

    posted.length = 0;
    await new ProcessingService(repo, { ...config, matchEmbeddedJpeg: false } as Config).processUnprocessed('lib');
    expect(posted.map((job) => job.matchEmbeddedJpeg)).toEqual([false, false]);
  });

  it('marks each photo processed and drains the pool without hanging', async () => {
    const markProcessed = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b'), pending('c')]),
      markProcessed,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, config).processUnprocessed('lib');

    expect(markProcessed).toHaveBeenCalledTimes(3);
  });

  it('a DB write failure in applyResult does not hang the pool', async () => {
    const markProcessed = jest.fn(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b')]),
      markProcessed,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    // Must resolve (not hang): applyResult swallows the throw so the pool's
    // assignNext/terminate bookkeeping still runs for every job.
    await expect(new ProcessingService(repo, config).processUnprocessed('lib')).resolves.toBeUndefined();
    expect(markProcessed).toHaveBeenCalledTimes(2);
  });

  it('builds every grid tile before any rendition, and clears the flag only once both land', async () => {
    // The whole point of the split. A tile is ~125ms where a rendition is ~1.5s, so
    // interleaving them would make a 2000-frame shoot's grid take as long as the
    // renders do. Nothing else pins the ordering, so a future refactor that fused the
    // passes back together would be invisible.
    const markProcessed = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b')]),
      markProcessed,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, config).processUnprocessed('lib');

    const order = posted.map((job) => photoStage(job));
    expect(order).toEqual(['a:grid', 'b:grid', 'a:full', 'b:full']);
    // Not after the tile: a photo whose renditions are still outstanding has to stay
    // pending, or a crash between the passes would lose them with nothing to retry.
    expect(markProcessed).toHaveBeenCalledTimes(2);
  });

  it('announces a photo when its tile lands, not only when its renditions do', async () => {
    // Splitting the passes exists so a grid is browsable at the tile's pace (~125ms)
    // rather than the render's (~1.5s). A client hears about a photo through these
    // announcements, so raising one only at the end would hand that back: the tile
    // would be on disk with nobody told for a second and a half.
    const touchReprocessed = jest.fn();
    const markProcessed = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a')]),
      markProcessed,
      touchReprocessed,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    const announced: { photoId: string; version: string }[] = [];
    const service = new ProcessingService(repo, config);
    service.onProcessed((photoId, version) => announced.push({ photoId, version }));
    await service.processUnprocessed('lib');

    // Once for the tile, once when the renditions land.
    expect(announced.map((a) => a.photoId)).toEqual(['a', 'a']);
    // Each carries the stamp its own write put on the row: a client builds the URL
    // out of that, so an announcement ahead of the row would be walked back by the
    // next list read.
    expect(touchReprocessed).toHaveBeenCalledWith('a', announced[0]?.version);
    expect(markProcessed).toHaveBeenCalledWith('a', announced[1]?.version, 'render');
  });

  it('records what the viewer gets, so a second import still rebuilds the renditions', async () => {
    // `rendition_source` is written by markProcessed and read straight back by the
    // next import to decide whether the viewer's renditions get built. Recording the
    // tile's own source instead put 'embedded' there for every photo, whatever the
    // library said - so the second import built the tile alone, and the sweep then
    // deleted the `full` it had declined to rebuild, with nothing to ever restore it.
    let stored: ThumbnailSource | null = 'render';
    const repo = {
      listPendingProcessing: jest.fn(() => [{ ...pending('a'), rendition_source: stored }]),
      markProcessed: jest.fn((_id: string, _at: string, source: ThumbnailSource) => {
        stored = source;
      }),
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, config).processUnprocessed('lib');
    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid', 'a:full']);
    expect(stored).toBe('render');

    posted.length = 0;
    await new ProcessingService(repo, config).processUnprocessed('lib');
    expect(posted.map((job) => photoStage(job))).toEqual(['a:grid', 'a:full']);
  });

  it('on a worker crash of a present file: marks it failed and deletes stale renditions', async () => {
    const gridDir = path.join(root, '.bowerbird', 'renditions', 'grid');
    const fullDir = path.join(root, '.bowerbird', 'renditions', 'full');
    mkdirSync(gridDir, { recursive: true });
    mkdirSync(fullDir, { recursive: true });
    const staleSmall = path.join(gridDir, `${CRASH}.avif`);
    const staleFull = path.join(fullDir, `${CRASH}.avif`);
    writeFileSync(staleSmall, 'stale');
    writeFileSync(staleFull, 'stale');
    writeFileSync(path.join(root, `${CRASH}.arw`), ''); // source still present -> real failure

    const markProcessingFailed = jest.fn();
    const markProcessed = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('ok'), pending(CRASH)]),
      markProcessed,
      markProcessingFailed,
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, config).processUnprocessed('lib');

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
      markProcessed: jest.fn(),
      markProcessingFailed,
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, config).processUnprocessed('lib');

    expect(markProcessingFailed).not.toHaveBeenCalled();
  });

  it('drains work that becomes pending while a batch is already running (rerun)', async () => {
    const markProcessed = jest.fn();
    let call = 0;
    const listPendingProcessing = jest.fn(() => {
      call += 1;
      if (call === 1) return [pending('a')];
      if (call === 2) return [pending('b')];
      return [];
    });
    const repo = { listPendingProcessing, markProcessed, markProcessingFailed: jest.fn() } as unknown as PhotosRepository;
    const service = new ProcessingService(repo, config);

    // second call coalesces into the first and flags a rerun; both drain.
    const first = service.processUnprocessed('lib');
    const second = service.processUnprocessed('lib');
    expect(second).toBe(first); // same in-flight promise
    await Promise.all([first, second]);

    // 'render', because that is what the viewer gets on this library. Not the tile's
    // own source, which is always the embedded JPEG and would say 'embedded' here for
    // every photo on every library.
    expect(markProcessed).toHaveBeenCalledWith('a', expect.any(String), 'render');
    expect(markProcessed).toHaveBeenCalledWith('b', expect.any(String), 'render');
  });

  it('leaves jobs pending (no hang, no throw) when a worker cannot be spawned', async () => {
    class ThrowingWorker {
      constructor(_url: string) {
        throw new Error('EAGAIN: thread exhaustion');
      }
    }
    (globalThis as { Worker?: unknown }).Worker = ThrowingWorker;
    const markProcessed = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('a'), pending('b')]),
      markProcessed,
      markProcessingFailed: jest.fn(),
    } as unknown as PhotosRepository;

    await expect(new ProcessingService(repo, config).processUnprocessed('lib')).resolves.toBeUndefined();
    expect(markProcessed).not.toHaveBeenCalled(); // untouched -> still needs_processing=1
  });

  it('does nothing when there is no pending work', async () => {
    const repo = { listPendingProcessing: jest.fn(() => []) } as unknown as PhotosRepository;
    await expect(new ProcessingService(repo, config).processUnprocessed('lib')).resolves.toBeUndefined();
  });
});
