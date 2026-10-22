import { afterEach, expect, it, mock } from 'bun:test';
import type { Library } from '../../../../schemas/libraries';
import type { LibrariesRepository } from '../../../libraries/libraries_repository';
import type { LibraryScope } from '../../../../utils/scope';
import type { ScanService } from '../../scan/scan_service';

let calls: string[] = [];
let subscribed: string[] = [];
mock.module('@parcel/watcher', () => ({
  subscribe: async (dir: string) => {
    calls.push('subscribe');
    subscribed.push(dir);
    return {
      unsubscribe: async () => {
        calls.push('unsubscribe begun');
        await Bun.sleep(20);
        calls.push('unsubscribe done');
      },
    };
  },
}));

const { LibraryWatcher } = await import('../library_watcher');

const library = { id: 'lib', root_path: '/not/a/real/root', bin_name: 'Bin' } as Library;
let current = library;
let includeNonRaw = false;

function build(): InstanceType<typeof LibraryWatcher> {
  const libraries = {
    list: () => [current],
    getById: () => current,
  } as unknown as LibrariesRepository;
  const scan = {
    scanLibrary: () => Promise.resolve(),
    scopeFor: (): LibraryScope => ({
      rootPath: current.root_path,
      includeSubfolders: true,
      includeNonRaw,
      binName: 'Bin',
      excluded: new Set<string>(),
    }),
  } as unknown as ScanService;
  return new LibraryWatcher(libraries, scan, 1000, 20_000, () => 'ext4');
}

let watcher: InstanceType<typeof LibraryWatcher>;

afterEach(async () => {
  watcher.stop();
  await Bun.sleep(50);
  calls = [];
  subscribed = [];
  current = library;
  includeNonRaw = false;
});

it('re-watches a library moved to another root', async () => {
  watcher = build();
  watcher.start();
  await watcher.whenReady();

  current = { ...library, root_path: '/not/a/real/elsewhere' };
  watcher.onLibraryUpdated(current);
  await watcher.whenReady();

  expect(subscribed).toEqual(['/not/a/real/root', '/not/a/real/elsewhere']);
});

it('re-watches only once the watch it replaces is released', async () => {
  watcher = build();
  watcher.start();
  await watcher.whenReady();

  includeNonRaw = true;
  watcher.onLibraryUpdated(library);
  await watcher.whenReady();

  expect(calls).toEqual(['subscribe', 'unsubscribe begun', 'unsubscribe done', 'subscribe']);
});

it('a watch replaced before it was established is released rather than kept', async () => {
  watcher = build();
  watcher.start();
  includeNonRaw = true;
  watcher.onLibraryUpdated(library);
  await watcher.whenReady();
  await Bun.sleep(50);

  expect(calls).toEqual(['subscribe', 'subscribe', 'unsubscribe begun', 'unsubscribe done']);
});
