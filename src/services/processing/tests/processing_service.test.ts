import { jest } from '@jest/globals';
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
    return { photo_id: photoId, file_path: `${photoId}.arw`, root_path: root, data_path: null };
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

  it('on a worker crash: marks the job failed and deletes its stale thumbnails', async () => {
    const smallDir = path.join(root, '.bowerbird', 'thumbnails', 'small');
    const fullDir = path.join(root, '.bowerbird', 'thumbnails', 'full');
    mkdirSync(smallDir, { recursive: true });
    mkdirSync(fullDir, { recursive: true });
    const staleSmall = path.join(smallDir, `${CRASH}.webp`);
    const staleFull = path.join(fullDir, `${CRASH}.webp`);
    writeFileSync(staleSmall, 'stale');
    writeFileSync(staleFull, 'stale');

    const markProcessingFailed = jest.fn();
    const markProcessed = jest.fn();
    const repo = {
      listPendingProcessing: jest.fn(() => [pending('ok'), pending(CRASH)]),
      markProcessed,
      markProcessingFailed,
    } as unknown as PhotosRepository;

    await new ProcessingService(repo, config).processUnprocessed('lib');

    expect(markProcessed).toHaveBeenCalledWith('ok', expect.any(String));
    expect(markProcessingFailed).toHaveBeenCalledWith(CRASH, expect.stringContaining('crashed'));
    // thumbnail cleanup is best-effort (fire-and-forget); let it settle
    for (let i = 0; i < 25 && (existsSync(staleSmall) || existsSync(staleFull)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(staleSmall)).toBe(false);
    expect(existsSync(staleFull)).toBe(false);
  });

  it('does nothing when there is no pending work', async () => {
    const repo = { listPendingProcessing: jest.fn(() => []) } as unknown as PhotosRepository;
    await expect(new ProcessingService(repo, config).processUnprocessed('lib')).resolves.toBeUndefined();
  });
});
