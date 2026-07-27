import { describe, it, expect, afterEach, beforeEach, jest } from 'bun:test';
import type { Library } from '../../../schemas/libraries';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import { LibraryWatcher } from '../library_watcher';
import type { SyncService } from '../sync_service';

// watch() on this path throws synchronously, so every re-attempt fails the same
// way a permanently unmounted drive would.
const library: Library = { id: 'lib', root_path: '/definitely/not/a/real/root', data_path: null, ordering: 'taken_desc',
  preview_source: 'embedded' as const,
  preview_hdr: false,
  preview_hdr_video: false, last_synced_at: null, photo_count: 0 };
const DEBOUNCE = 1000;
const TEN_MINUTES = 10 * 60 * 1000;

function build(): LibraryWatcher {
  const libraries = { list: () => [library], getById: () => library } as unknown as LibrariesRepository;
  const sync = { syncLibrary: () => Promise.resolve() } as unknown as SyncService;
  return new LibraryWatcher(libraries, sync, DEBOUNCE);
}

describe('LibraryWatcher watch-error backoff', () => {
  let watcher: LibraryWatcher;
  let attempts: number;
  let error: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    attempts = 0;
    // One log line per failed attempt is the thing that used to run away.
    error = jest.spyOn(console, 'error').mockImplementation(() => {
      attempts++;
    });
    watcher = build();
  });

  afterEach(() => {
    watcher.stop();
    error.mockRestore();
    jest.useRealTimers();
  });

  it('re-attempts a handful of times over ten minutes, not once per debounce window', () => {
    watcher.start();
    expect(attempts).toBe(1); // the initial failure

    jest.advanceTimersByTime(TEN_MINUTES);

    // A fixed DEBOUNCE-interval retry would have logged 600 times here.
    expect(attempts).toBeGreaterThan(1); // still retrying, not given up
    expect(attempts).toBeLessThan(20);
  });

  it('keeps re-attempting at the capped interval rather than backing off to never', () => {
    watcher.start();
    jest.advanceTimersByTime(TEN_MINUTES);
    const afterTenMinutes = attempts;

    jest.advanceTimersByTime(TEN_MINUTES);
    // The cap means a drive that comes back is still picked up within minutes.
    expect(attempts).toBeGreaterThan(afterTenMinutes);
  });

  it('stops re-attempting once torn down', () => {
    watcher.start();
    watcher.stop();
    const atStop = attempts;
    jest.advanceTimersByTime(TEN_MINUTES);
    expect(attempts).toBe(atStop);
  });
});
