// A first import is a scan and then an hour of renditions, and the sidebar's photo
// count comes off the library list.
import { expect, jest, test } from 'bun:test';
import { type LibraryScanStatus } from '../../../../../src/schemas/libraries';
import { librariesApi } from '../../../api/libraries';
import { ScanPresenter } from '../scan_presenter';
import { ScanStore } from '../scan_store';
import { restoreApiAfterTests } from '../../../test_api';

restoreApiAfterTests();

const IDLE: LibraryScanStatus = {
  library_id: 'lib',
  status: 'idle',
  photos_to_scan: 0,
  photos_scanned: 0,
  photos_added: 0,
  photos_removed: 0,
  photos_moved: 0,
  photos_modified: 0,
  photos_processing: 0,
  photos_processed: 0,
  photos_per_second: null,
};

// `api` is a module singleton, so this is the seam.
function reporting(status: LibraryScanStatus['status']): void {
  librariesApi.scanStatus = (library_id: string): Promise<LibraryScanStatus> => Promise.resolve({ ...IDLE, library_id, status });
}

async function loadsWhile(status: LibraryScanStatus['status']): Promise<number> {
  reporting(status);
  let loads = 0;
  const presenter = new ScanPresenter(
    new ScanStore(),
    { reload: () => Promise.resolve() },
    { load: () => Promise.resolve(void loads++) },
  );
  await presenter.watch('lib');
  presenter.stop();
  return loads;
}

test('the library list is re-read as the scan places its photos, not only once the run is over', async () => {
  expect(await loadsWhile('processing')).toBe(1);
});

// The long half, where the row set is settled and nothing the sidebar shows moves.
test('the library list is left alone through the rendition phase', async () => {
  expect(await loadsWhile('rendition')).toBe(0);
});

function watching(): { store: ScanStore; presenter: ScanPresenter } {
  const store = new ScanStore();
  const presenter = new ScanPresenter(
    store,
    { reload: () => Promise.resolve() },
    { load: () => Promise.resolve() },
  );
  return { store, presenter };
}

const at = (seconds: number): void => jest.setSystemTime(new Date(2026, 0, 1, 0, 0, seconds));

function scanning(scanned: number, perSecond: number | null = null): void {
  librariesApi.scanStatus = (): Promise<LibraryScanStatus> =>
    Promise.resolve({ ...IDLE, status: 'processing', photos_to_scan: 100, photos_scanned: scanned, photos_per_second: perSecond });
}

test("the scan's own rate is preferred, and counting polls covers the phase that has none", async () => {
  const { store, presenter } = watching();

  at(0);
  scanning(10);
  await presenter.watch('lib');
  // One reading is a count, not a rate.
  expect(store.rate).toBeNull();

  at(4);
  scanning(30);
  await presenter.watch('lib');
  expect(store.rate).toBeCloseTo(5);
  expect(store.secondsLeft).toBeCloseTo(14);

  // What the last batch of rows actually managed, which is not what the poll counted.
  at(5);
  scanning(31, 2.5);
  await presenter.watch('lib');
  expect(store.rate).toBeCloseTo(2.5);
  expect(store.secondsLeft).toBeCloseTo(27.6);

  at(6);
  librariesApi.scanStatus = (): Promise<LibraryScanStatus> =>
    Promise.resolve({ ...IDLE, status: 'rendition', photos_processing: 100, photos_processed: 0 });
  await presenter.watch('lib');
  expect(store.rate).toBeNull();
  expect(store.secondsLeft).toBeNull();

  presenter.stop();
  jest.useRealTimers();
});

test('the counted rate is what the last few seconds managed, not the whole phase', async () => {
  const { store, presenter } = watching();

  // Ten a second for five seconds, then one a second: the phase average is 5.5, and
  // a window that reported that would have the ETA out by a factor of five.
  for (let second = 0; second <= 10; second++) {
    at(second);
    scanning(second <= 5 ? second * 10 : 50 + (second - 5));
    await presenter.watch('lib');
  }
  expect(store.rate).toBeCloseTo(1);

  presenter.stop();
  jest.useRealTimers();
});

// One presenter serves every library, and the two phases are called the same thing
// on all of them, so nothing downstream would notice the counts of the last one.
test('a library that is no longer the one being watched takes its counts with it', async () => {
  const { store, presenter } = watching();

  at(0);
  scanning(10);
  await presenter.watch('one');
  at(1);
  scanning(20);
  await presenter.watch('one');
  expect(store.rate).toBeCloseTo(10);

  at(2);
  scanning(60);
  await presenter.watch('two');
  expect(store.rate).toBeNull();

  presenter.stop();
  jest.useRealTimers();
});
