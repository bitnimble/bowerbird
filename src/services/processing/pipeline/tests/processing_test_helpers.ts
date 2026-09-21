import { afterEach, beforeEach } from 'bun:test';
import { DEFAULT_SETTINGS, type Settings } from '../../../../schemas/settings';
import type { SettingsRepository } from '../../../settings/settings_repository';
import type { CompositeJob, ProcessingMessage, RenditionJob } from '../../workers/processing_types';

export const CRASH = 'crash-photo';
export const LIB = 'processing-service-test';
export const posted: (RenditionJob | CompositeJob)[] = [];
export const built: MockWorker[] = [];
export const DESCRIPTOR = new Uint8Array([1, 2, 3]);

// Fake Worker: a job for CRASH fires onerror (a native-crash-like event, which
// skips worker's own catch); everything else reports success.
export class MockWorker {
  onmessage: ((event: { data: ProcessingMessage }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: string) {
    built.push(this);
  }
  postMessage(job: RenditionJob | CompositeJob): void {
    posted.push(job);
    queueMicrotask(() => {
      if (job.kind === 'composite') {
        if (job.photoId === CRASH || (job.want === 'seams' && job.volumePath === CRASH)) {
          return this.onerror?.({ message: 'segfault' });
        }
        return this.onmessage?.({ data: { photoId: job.photoId, success: true, composite: '{}' } });
      }
      if (job.photoId === CRASH) return this.onerror?.({ message: 'segfault' });
      const tile = job.targets.every((target) => target.rendition === 'grid');
      this.onmessage?.({
        data: { photoId: job.photoId, success: true, ...(tile ? { descriptor: DESCRIPTOR } : {}) },
      });
    });
  }

  terminate(): void {}
}

export const REAL_WORKER = globalThis.Worker;

export function settingsWith(overrides: Partial<Settings> = {}): SettingsRepository {
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 2, ...overrides };
  return { get: () => settings } as SettingsRepository;
}

export const settings = settingsWith();

export function usingMockWorker(): void {
  beforeEach(() => {
    posted.length = 0;
    built.length = 0;
    (globalThis as { Worker?: unknown }).Worker = MockWorker;
  });
  afterEach(() => {
    globalThis.Worker = REAL_WORKER;
  });
}
