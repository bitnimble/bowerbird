import { describe, it, expect, afterEach, beforeEach, jest, mock } from 'bun:test';
import type { Library } from '../../../schemas/libraries';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { LibraryScope } from '../../../utils/scope';
import type { SyncService } from '../sync_service';

// Every attempt to watch fails, the way a permanently unmounted drive would.
// Mocked rather than pointed at a path that does not exist, because chokidar
// reports that asynchronously and this is about our own retry loop.
mock.module('chokidar', () => ({
  default: {
    watch: () => {
      throw new Error('ENOENT');
    },
  },
}));

const { LibraryWatcher } = await import('../library_watcher');

const library: Library = { id: 'lib', root_path: '/definitely/not/a/real/root', data_path: null, name: null, ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  rendition_hdr_video: false, include_subfolders: true, mirror_shoots: true, last_synced_at: null, photo_count: 0 };
const DEBOUNCE = 1000;
const TEN_MINUTES = 10 * 60 * 1000;

function build(): InstanceType<typeof LibraryWatcher> {
  const libraries = { list: () => [library], getById: () => library } as unknown as LibrariesRepository;
  const sync = {
    syncLibrary: () => Promise.resolve(),
    scopeFor: (): LibraryScope => ({
      rootPath: library.root_path,
      dataPath: '/x',
      includeSubfolders: true,
      excluded: new Set<string>(),
    }),
  } as unknown as SyncService;
  return new LibraryWatcher(libraries, sync, DEBOUNCE);
}

describe('LibraryWatcher watch-error backoff', () => {
  let watcher: InstanceType<typeof LibraryWatcher>;
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
