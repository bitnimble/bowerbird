import { expect, test } from 'bun:test';
import { DEFAULT_LIBRARY_SETTINGS, LibrarySchema } from '../../../../../src/schemas/libraries';
import type { ActivitySnapshot } from '../../../../../src/schemas/activity';
import { librariesApi } from '../../../api/libraries';
import { restoreApiAfterTests } from '../../../test_api';
import { LibrariesPresenter } from '../libraries_presenter';
import { LibrariesStore } from '../libraries_store';
import { ToastsPresenter } from '../../toasts/toasts_presenter';
import { ToastsStore } from '../../toasts/toasts_store';

restoreApiAfterTests();

const LIBRARY = LibrarySchema.parse({
  id: 'lib00001',
  root_path: '/photos',
  bin_name: 'Bin',
  name: 'Reef',
  ordering: 'taken_asc',
  last_synced_at: null,
  photo_count: 10,
  missing_photo_count: 4,
  unavailable_photo_count: 1,
  rendered_photo_count: 5,
});

function snapshot(library = LIBRARY, processing = 0): ActivitySnapshot {
  return {
    libraries: [
      {
        ...library,
        activities: [],
        scan: {
          library_id: library.id,
          status: 'idle',
          photos_to_scan: 0,
          photos_scanned: 0,
          photos_added: 0,
          photos_removed: 0,
          photos_moved: 0,
          photos_modified: 0,
          photos_processing: processing,
          photos_processed: 0,
          photos_per_second: null,
        },
      },
    ],
    global: [],
  };
}

test('leaving the library list aborts its read and a late answer cannot overwrite held counts', async () => {
  const store = new LibrariesStore();
  store.libraries = [LIBRARY];
  const pending = Promise.withResolvers<ActivitySnapshot>();
  let signal: AbortSignal | undefined;
  let statuses = 0;
  librariesApi.activity = (askedSignal) => {
    signal = askedSignal;
    return pending.promise;
  };
  librariesApi.scanStatus = () => {
    statuses++;
    throw new Error('a stopped watcher must not read status');
  };
  const presenter = new LibrariesPresenter(store, new ToastsPresenter(new ToastsStore()));
  const stop = presenter.watch();
  expect(signal?.aborted).toBe(false);
  stop();
  expect(signal?.aborted).toBe(true);
  pending.resolve(snapshot({ ...LIBRARY, rendered_photo_count: 10 }));
  await Bun.sleep(0);
  expect(store.libraries[0]?.rendered_photo_count).toBe(5);
  expect(statuses).toBe(0);
});

test('an overlapping library load preserves newer counts and still receives live queue status', async () => {
  const store = new LibrariesStore();
  const pending = Promise.withResolvers<ActivitySnapshot>();
  librariesApi.activity = () => pending.promise;
  librariesApi.list = () => Promise.resolve([{ ...LIBRARY, rendered_photo_count: 10 }]);
  librariesApi.getDefaults = () => Promise.resolve(DEFAULT_LIBRARY_SETTINGS);
  const presenter = new LibrariesPresenter(store, new ToastsPresenter(new ToastsStore()));
  const stop = presenter.watch();
  try {
    await Bun.sleep(0);
    await presenter.load();
    pending.resolve(snapshot(LIBRARY, 3));
    await Bun.sleep(0);
    expect(store.libraries[0]?.rendered_photo_count).toBe(10);
    expect(store.statuses.get(LIBRARY.id)?.photos_processing).toBe(3);
  } finally {
    stop();
  }
});

test('canceling a watcher does not discard an overlapping initial library load', async () => {
  const store = new LibrariesStore();
  const pendingLoad = Promise.withResolvers<Awaited<ReturnType<typeof librariesApi.list>>>();
  const pendingWatch = Promise.withResolvers<ActivitySnapshot>();
  librariesApi.list = () => pendingLoad.promise;
  librariesApi.activity = () => pendingWatch.promise;
  librariesApi.getDefaults = () => Promise.resolve(DEFAULT_LIBRARY_SETTINGS);
  const presenter = new LibrariesPresenter(store, new ToastsPresenter(new ToastsStore()));
  const loading = presenter.load();
  const stop = presenter.watch();
  stop();
  pendingLoad.resolve([LIBRARY]);
  await loading;
  expect(store.loading).toBe(false);
  expect(store.libraries).toEqual([LIBRARY]);
  pendingWatch.resolve(snapshot({ ...LIBRARY, photo_count: 99 }));
  await Bun.sleep(0);
  expect(store.libraries[0]?.photo_count).toBe(10);
});

test('local GPU work counts each photo once and clears after its last render', () => {
  const store = new LibrariesStore();
  const presenter = new LibrariesPresenter(store, new ToastsPresenter(new ToastsStore()));
  const first = presenter.startLocalRender('library', 'photo');
  const second = presenter.startLocalRender('library', 'photo');
  expect(store.localRendering.get('library')?.size).toBe(1);
  first();
  first();
  expect(store.localRendering.get('library')?.size).toBe(1);
  second();
  expect(store.localRendering.has('library')).toBe(false);
});
