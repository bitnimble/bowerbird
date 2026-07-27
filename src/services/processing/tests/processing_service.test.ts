import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../../../config';
import type { PendingPhoto, PhotosRepository } from '../../photos/photos_repository';
import { ProcessingService } from '../processing_service';
import type { ProcessingJob, ProcessingResult } from '../processing_types';

const CRASH = 'crash-photo';

// Fake Worker: a job for CRASH fires onerror (a native-crash-like event, which
// skips the worker's own catch); everything else reports success.
class MockWorker {
  onmessage: ((event: { data: ProcessingResult }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: string) {}
  postMessage(job: ProcessingJob): void {
    queueMicrotask(() => {
      if (job.photoId === CRASH) this.onerror?.({ message: 'segfault' });
      else this.onmessage?.({ data: { photoId: job.photoId, success: true, source: job.source, hdr: job.hdr } });
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

describe('ProcessingService.processUnprocessed', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bb-proc-'));
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
      thumbnail_source: 'render',
      preview_source: 'embedded',
      preview_hdr: 0,
      preview_hdr_video: 0,
    };
  }

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

  it('on a worker crash of a present file: marks it failed and deletes stale thumbnails', async () => {
    const smallDir = path.join(root, '.bowerbird', 'thumbnails', 'small');
    const fullDir = path.join(root, '.bowerbird', 'thumbnails', 'full');
    mkdirSync(smallDir, { recursive: true });
    mkdirSync(fullDir, { recursive: true });
    const staleSmall = path.join(smallDir, `${CRASH}.avif`);
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

    expect(markProcessed).toHaveBeenCalledWith('a', expect.any(String), 'render', false);
    expect(markProcessed).toHaveBeenCalledWith('b', expect.any(String), 'render', false);
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
