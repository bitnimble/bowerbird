import { describe, it, expect, afterEach, beforeEach, jest, mock } from 'bun:test';
import type { Library } from '../../../../schemas/libraries';
import type { LibrariesRepository } from '../../../libraries/libraries_repository';
import type { LibraryScope } from '../../../../utils/scope';
import type { ScanService } from '../../scan/scan_service';

// Every attempt to watch fails, the way a permanently unmounted drive would.
// Mocked rather than pointed at a path that does not exist, so the test is about
// our retry loop rather than about how the watcher reports a missing root.
let attempts = 0;
mock.module('../watch_backend', () => ({
  subscribe: () => {
    attempts++;
    return Promise.reject(new Error('ENOENT'));
  },
}));

const { LibraryWatcher } = await import('../library_watcher');

const library: Library = { id: 'lib', root_path: '/definitely/not/a/real/root', bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  render_skip_full: [], render_skip_max: [], render_timings: {},
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
const DEBOUNCE = 1000;
const POLL = 20_000;
const TEN_MINUTES = 10 * 60 * 1000;

// The failure arrives as a rejected promise, so the retry it schedules is only
// armed once microtasks have run. Advancing fake timers alone would race it.
async function advance(ms: number): Promise<void> {
  const step = DEBOUNCE;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    jest.advanceTimersByTime(step);
    await Promise.resolve();
    await Promise.resolve();
  }
}

function build(): InstanceType<typeof LibraryWatcher> {
  const libraries = { list: () => [library], getById: () => library } as unknown as LibrariesRepository;
  const scan = {
    scanLibrary: () => Promise.resolve(),
    scopeFor: (): LibraryScope => ({
      rootPath: library.root_path,
      includeSubfolders: true,
      includeNonRaw: false,
      binName: 'Bin',
      excluded: new Set<string>(),
    }),
  } as unknown as ScanService;
  return new LibraryWatcher(libraries, scan, DEBOUNCE, POLL, () => 'ext4');
}

describe('LibraryWatcher watch-error backoff', () => {
  let watcher: InstanceType<typeof LibraryWatcher>;

  beforeEach(() => {
    jest.useFakeTimers();
    attempts = 0;
    watcher = build();
  });

  afterEach(() => {
    watcher.stop();
    jest.useRealTimers();
  });

  it('re-attempts a handful of times over ten minutes, not once per debounce window', async () => {
    watcher.start();
    await Promise.resolve();
    expect(attempts).toBe(1); // the initial failure

    await advance(TEN_MINUTES);

    // A fixed DEBOUNCE-interval retry would have attempted 600 times here.
    expect(attempts).toBeGreaterThan(1); // still retrying, not given up
    expect(attempts).toBeLessThan(20);
  });

  it('keeps re-attempting at the capped interval rather than backing off to never', async () => {
    watcher.start();
    await advance(TEN_MINUTES);
    const afterTenMinutes = attempts;

    await advance(TEN_MINUTES);
    // The cap means a drive that comes back is still picked up within minutes.
    expect(attempts).toBeGreaterThan(afterTenMinutes);
  });

  it('stops re-attempting once torn down', async () => {
    watcher.start();
    await Promise.resolve();
    watcher.stop();
    const atStop = attempts;
    await advance(TEN_MINUTES);
    expect(attempts).toBe(atStop);
  });
});
