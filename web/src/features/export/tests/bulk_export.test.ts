// A selection's export is one render per photograph into a sink the reader chose, so what a
// test has to pin is the loop: that every photograph is asked for, that one that fails does
// not take the rest with it, and that a selection is resolved rather than assumed.
import { beforeEach, expect, test } from 'bun:test';
import { exportsApi } from '../../../api/exports';
import { photosApi } from '../../../api/photos';
import { restoreApiAfterTests } from '../../../test_api';
import type { ExportOptions } from '../../../../../src/schemas/export';
import type { QueuedExportsRequest, QueuedPhoto, RecordExportRequest } from '../../../../../src/schemas/exports';
import type { PhotoTarget } from '../../../../../src/schemas/photos';
import { ExportPresenter } from '../export_presenter';
import { ExportStore } from '../export_store';
import type { ExportSink } from '../export_sink';
import { MemoryStorage } from '../../../test_storage';
import { SidebarPresenter } from '../../../app/sidebar_presenter';
import { SidebarStore } from '../../../app/sidebar_store';
import { AppSettingsStore } from '../../settings/app_settings_store';
import { ToastsPresenter } from '../../toasts/toasts_presenter';
import { ToastsStore } from '../../toasts/toasts_store';

restoreApiAfterTests();

const saved: { photoId: string; options: ExportOptions; run: string }[] = [];
const recorded: RecordExportRequest[] = [];
const toasted: string[] = [];
let refuse: (photoId: string) => boolean = () => false;

const sink: ExportSink = {
  save: (photoId, options, run) => {
    if (refuse(photoId)) return Promise.reject(new Error('no reading that one'));
    saved.push({ photoId, options, run });
    return Promise.resolve(`/exports/${photoId}.jpg`);
  },
};
const savedIds = (): string[] => saved.map((each) => each.photoId);

const toasts = { show: (message: string) => toasted.push(message) } as never;
const sidebar = new SidebarStore(new AppSettingsStore());

function queuedPhoto(id: string): QueuedPhoto {
  return {
    photo_id: id,
    library_id: 'lib',
    library_name: 'Trips',
    shoot_id: null,
    shoot_name: null,
    source_path: `raw/${id}.arw`,
    edits: null,
    width: 6000,
    height: 4000,
    tile_built_at: null,
  };
}

function open(target: PhotoTarget, count: number): { store: ExportStore; presenter: ExportPresenter } {
  const store = new ExportStore();
  const presenter = new ExportPresenter(store, sidebar, toasts, () => Promise.resolve(sink));
  presenter.openFor(target, count, { width: 6000, height: 4000 });
  return { store, presenter };
}

beforeEach(() => {
  saved.length = 0;
  recorded.length = 0;
  toasted.length = 0;
  refuse = () => false;
  exportsApi.record = (body: RecordExportRequest): Promise<void> => {
    recorded.push(body);
    return Promise.resolve();
  };
  exportsApi.queued = (body: QueuedExportsRequest): Promise<QueuedPhoto[]> =>
    Promise.resolve(body.photo_ids.map(queuedPhoto));
});

test('every photograph named by id is rendered and written', async () => {
  const { store, presenter } = open({ photo_ids: ['a', 'b', 'c'] }, 3);
  await presenter.run();

  expect(savedIds()).toEqual(['a', 'b', 'c']);
  expect(store.queue).toEqual([]);
  expect(store.open).toBe(false);
  expect(toasted).toEqual(['Exported 3 photos.']);
});

// The dialog is a form, not a progress bar: a selection is one render per photograph, and the
// reader gets their library back the moment they have said what they want.
test('the dialog closes on the click that queues the run, before a file is written', async () => {
  const { store, presenter } = open({ photo_ids: ['a', 'b'] }, 2);

  const running = presenter.run();
  // The picker is a promise even when it answers at once, so the queue is filled a microtask
  // after the click rather than within it.
  await Promise.resolve();
  expect(store.open).toBe(false);
  expect(store.queue).toHaveLength(1);
  expect(store.queued).toBe(2);

  await running;
});

// Two exports asked for in a row are two runs, in the order they were asked for: one at a time,
// because each is a decode per photograph and two at once only makes both slower.
test('a second export queues behind the first rather than running with it', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const store = new ExportStore();
  const presenter = new ExportPresenter(store, sidebar, toasts, () =>
    Promise.resolve({
      save: async (photoId, options, run) => {
        if (photoId === 'a2') await held;
        saved.push({ photoId, options, run });
        return `/exports/${photoId}.jpg`;
      },
    }),
  );

  presenter.openFor({ photo_ids: ['a1', 'a2'] }, 2, null);
  const first = presenter.run();
  await Promise.resolve();
  presenter.openFor({ photo_ids: ['b'] }, 1, null);
  const second = presenter.run();
  await Promise.resolve();

  // Out to the macrotask queue, so the first run has reached the photograph it is held on
  // rather than being somewhere in the microtasks before it.
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(store.queue).toHaveLength(2);
  expect(store.active?.running).toBe(true);
  // Nothing of the second has been asked for while the first is held.
  expect(store.queue[1]?.running).toBe(false);
  expect(savedIds()).toEqual(['a1']);
  // What the sidebar draws: every photograph queued, and the one of them already written.
  expect(store.queued).toBe(3);
  expect(store.written).toBe(1);

  release();
  await Promise.all([first, second]);
  expect(savedIds()).toEqual(['a1', 'a2', 'b']);
  expect(store.queue).toEqual([]);
});

// The whole point of the announcement: a run of one photograph is minutes inside a single
// request, so counting files leaves the bar at nothing until the file is on disk.
test('how far into a photograph the render is moves the bar, and settling the file resets it', async () => {
  let releaseFirst = (): void => {};
  let releaseSecond = (): void => {};
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  const second = new Promise<void>((resolve) => (releaseSecond = resolve));
  const store = new ExportStore();
  const presenter = new ExportPresenter(store, sidebar, toasts, () =>
    Promise.resolve({
      save: async (photoId, options, run) => {
        await (photoId === 'a' ? first : second);
        saved.push({ photoId, options, run });
        return `/exports/${photoId}.jpg`;
      },
    }),
  );

  presenter.openFor({ photo_ids: ['a', 'b'] }, 2, null);
  const running = presenter.run();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const run = store.active?.id ?? '';
  presenter.progressed({ run_id: run, photo_id: 'a', fraction: 0.6 });
  expect(store.written).toBeCloseTo(0.6);
  // A run that is not the one in flight says nothing about this bar.
  presenter.progressed({ run_id: 'somebody else', photo_id: 'a', fraction: 1 });
  expect(store.written).toBeCloseTo(0.6);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The file it was about is counted, and the next one has not reported anything yet.
  expect(store.written).toBe(1);

  releaseSecond();
  await running;
  expect(store.queue).toEqual([]);
});

// A run that has not begun is dropped whole; the one in flight finishes the file it is on.
test('a queued run the reader takes back is never rendered', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const store = new ExportStore();
  const presenter = new ExportPresenter(store, sidebar, toasts, () =>
    Promise.resolve({
      save: async (photoId, options, run) => {
        if (photoId === 'a') await held;
        saved.push({ photoId, options, run });
        return `/exports/${photoId}.jpg`;
      },
    }),
  );

  presenter.openFor({ photo_ids: ['a'] }, 1, null);
  const first = presenter.run();
  await Promise.resolve();
  presenter.openFor({ photo_ids: ['b'] }, 1, null);
  const second = presenter.run();
  await Promise.resolve();

  presenter.stop(store.queue[1]!.id);
  expect(store.queue).toHaveLength(1);

  release();
  await Promise.all([first, second]);
  expect(savedIds()).toEqual(['a']);
});

// The history is what the Exports page lists, and only this loop knows where each file went.
// One run id across the selection is what makes it one entry there rather than three - and it
// goes into the render as well as the report, because the row and its tile are written there.
test('every file that lands is reported against the one run it was rendered under', async () => {
  const { presenter } = open({ photo_ids: ['a', 'b'] }, 2);
  await presenter.run();

  expect(recorded.map((each) => each.photo_id)).toEqual(['a', 'b']);
  expect(recorded.map((each) => each.output_path)).toEqual(['/exports/a.jpg', '/exports/b.jpg']);

  const runs = new Set(recorded.map((each) => each.run_id));
  expect(runs.size).toBe(1);
  // The same run the sink was told to render under: a report naming a run nothing was
  // rendered against would leave every row of it waiting for a destination and swept.
  expect(new Set(saved.map((each) => each.run))).toEqual(runs);
});

// The file is on the reader's disk either way, so a history that could not be written must not
// report an export that plainly happened as one that failed.
test('a history that cannot be written does not fail the export', async () => {
  exportsApi.record = (): Promise<void> => Promise.reject(new Error('no catalogue'));
  const { store, presenter } = open({ photo_ids: ['a'] }, 1);

  await presenter.run();

  expect(savedIds()).toEqual(['a']);
  expect(toasted).toEqual(['Photo exported.']);
  expect(store.error).toBeNull();
});

// The sink is handed `honoured` options, not the raw ones, for the same reason the route asks
// the same function: a JPEG cannot signal HDR, so an export asked for one with no gain map has
// to arrive at the render as SDR rather than as a setting the encoder quietly drops.
test('what the sink is handed is what the format can honour', async () => {
  const { presenter } = open({ photo_ids: ['a'] }, 1);
  presenter.set('format', 'jpeg');
  presenter.set('exportHdr', true);
  presenter.set('gainMap', false);

  await presenter.run();

  expect(saved[0]?.options.exportHdr).toBe(false);
});

// The whole reason the dialog takes a target rather than a list: a selection can name more
// photographs than the grid has ever held rows for, so the ids come from the server.
test('a selection is resolved to its photographs before the loop', async () => {
  const asked: PhotoTarget[] = [];
  photosApi.ids = (target: PhotoTarget): Promise<{ photo_ids: string[] }> => {
    asked.push(target);
    return Promise.resolve({ photo_ids: ['x', 'y'] });
  };
  const target: PhotoTarget = {
    selection: { scope: { kind: 'library', id: 'lib' }, filters: {}, ranges: [{ start: 0, end: 1 }], members: [] },
  };

  const counted: number[] = [];
  const store = new ExportStore();
  const presenter = new ExportPresenter(store, sidebar, toasts, () =>
    Promise.resolve({
      save: (photoId, options, run) => {
        counted.push(store.queued);
        saved.push({ photoId, options, run });
        return Promise.resolve(`/exports/${photoId}.jpg`);
      },
    }),
  );
  presenter.openFor(target, 900, null);

  await presenter.run();

  expect(asked).toEqual([target]);
  expect(savedIds()).toEqual(['x', 'y']);
  // The count the dialog was opened with was a floor; what the queue holds is what the server
  // said, which is what the sidebar counts down and what the bar is drawn against.
  expect(counted[0]).toBe(2);
});

// The queue lists what is waiting rather than counting it, so the rows come with the run.
test('a queued run is described by the photographs it names', async () => {
  const asked: QueuedExportsRequest[] = [];
  exportsApi.queued = (body: QueuedExportsRequest): Promise<QueuedPhoto[]> => {
    asked.push(body);
    return Promise.resolve([queuedPhoto('a'), queuedPhoto('b')]);
  };
  const { store, presenter } = open({ photo_ids: ['a', 'b'] }, 2);
  presenter.set('includeEdits', false);

  const running = presenter.run();
  await Promise.resolve();
  const job = store.active!;
  await running;

  expect(asked).toEqual([{ photo_ids: ['a', 'b'], include_edits: false }]);
  expect(job.photos.map((photo) => photo.source_path)).toEqual(['raw/a.arw', 'raw/b.arw']);
});

// The rows are what the queue shows, not what it exports: a page that could not be described
// still writes every file it was asked for.
test('a run whose rows cannot be fetched exports anyway', async () => {
  exportsApi.queued = (): Promise<QueuedPhoto[]> => Promise.reject(new Error('no catalogue'));
  const { store, presenter } = open({ photo_ids: ['a'] }, 1);

  await presenter.run();

  expect(savedIds()).toEqual(['a']);
  expect(store.error).toBeNull();
  expect(toasted).toEqual(['Photo exported.']);
});

// One unreadable RAW should not decide that the rest stay in the library.
test('a photograph that fails is counted and the others still land', async () => {
  refuse = (photoId) => photoId === 'b';
  const { store, presenter } = open({ photo_ids: ['a', 'b', 'c'] }, 3);
  const running = presenter.run();
  await Promise.resolve();
  const job = store.active!;
  await running;

  expect(savedIds()).toEqual(['a', 'c']);
  expect(job.done).toBe(2);
  expect(job.failed).toBe(1);
  // No history for a file that was never written: a row here is a file the reader can go and
  // find, and one naming a photograph that failed sends them looking for nothing.
  expect(recorded.map((each) => each.photo_id)).toEqual(['a', 'c']);
  expect(toasted[0]).toContain("We couldn't export 1 photo. 2 photos were exported.");
});

// Stopping breaks the loop after the file in flight; nothing unwinds what is already written.
test('stopping a run ends it after the photograph it is on', async () => {
  const store = new ExportStore();
  const presenter: ExportPresenter = new ExportPresenter(store, sidebar, toasts, () =>
    Promise.resolve({
      save: (photoId, options, run) => {
        saved.push({ photoId, options, run });
        presenter.stop(run);
        return Promise.resolve(`/exports/${photoId}.jpg`);
      },
    }),
  );
  presenter.openFor({ photo_ids: ['a', 'b', 'c'] }, 3, null);

  await presenter.run();

  expect(savedIds()).toEqual(['a']);
  expect(store.queue).toEqual([]);
  // Singular, so this pins that one photograph landed rather than merely that a toast fired.
  expect(toasted).toEqual(['Photo exported.']);
});

// A reader who dismissed the folder picker has said no, which is not an error to show them.
test('declining the folder picker exports nothing and reports nothing', async () => {
  let asked = 0;
  const store = new ExportStore();
  const presenter = new ExportPresenter(store, sidebar, toasts, () => {
    asked += 1;
    return Promise.resolve(null);
  });
  presenter.openFor({ photo_ids: ['a'] }, 1, null);

  await presenter.run();

  // The picker was reached: without this every assertion below also holds for a `run` that
  // returned at its first line, which is the failure the re-entrancy guard makes plausible.
  expect(asked).toBe(1);
  expect(savedIds()).toEqual([]);
  expect(store.queue).toEqual([]);
  expect(store.error).toBeNull();
  // Still holding the settings they chose: a dismissed picker is a folder not yet decided on,
  // not an export they have to fill in again.
  expect(store.open).toBe(true);
});

test('a hidden sidebar shows the run as a progress toast, which stays dismissed until the next run', async () => {
  const toastsStore = new ToastsStore();
  const realToasts = new ToastsPresenter(toastsStore);
  const release: (() => void)[] = [];
  const held: ExportSink = {
    save: (photoId) => new Promise((resolve) => release.push(() => resolve(`/exports/${photoId}.jpg`))),
  };
  const store = new ExportStore();
  globalThis.localStorage = new MemoryStorage();
  const hideable = new SidebarStore(new AppSettingsStore());
  const sidebarPresenter = new SidebarPresenter(hideable);
  const presenter = new ExportPresenter(store, hideable, realToasts, () => Promise.resolve(held));
  const messages = (): string[] => toastsStore.toasts.map((toast) => toast.message);
  const progress = (): (number | undefined)[] => toastsStore.toasts.map((toast) => toast.progress);
  const dismissAll = (): void => toastsStore.toasts.forEach((toast) => realToasts.dismiss(toast.id));
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  sidebarPresenter.toggleOpen();
  expect(hideable.open).toBe(false);
  presenter.openFor({ photo_ids: ['a', 'b'] }, 2, null);
  const first = presenter.run();
  await flush();
  expect(messages()).toEqual(['Exporting 2 photos']);
  expect(progress()).toEqual([0]);

  release.shift()?.();
  await flush();
  expect(progress()).toEqual([0.5]);

  sidebarPresenter.toggleOpen();
  expect(messages()).toEqual([]);
  sidebarPresenter.toggleOpen();
  dismissAll();
  release.shift()?.();
  await first;
  expect(messages()).toEqual(['Exported 2 photos.']);

  dismissAll();
  presenter.openFor({ photo_ids: ['c'] }, 1, null);
  const second = presenter.run();
  await flush();
  expect(messages()).toEqual(['Exporting 1 photo']);
  release.shift()?.();
  await second;
});

/**
 * The invariant that breaks the picker silently if it is ever lost.
 *
 * `showDirectoryPicker` needs the click's transient activation, so the sink has to be asked
 * for in `run`'s synchronous prefix. An `await` moved in front of it still exports - to the
 * downloads folder, a file at a time - so nothing else here would report it.
 */
test('the sink is asked for before anything is awaited', async () => {
  let asked = 0;
  const store = new ExportStore();
  const presenter = new ExportPresenter(store, sidebar, toasts, () => {
    asked += 1;
    return Promise.resolve(sink);
  });
  presenter.openFor({ photo_ids: ['a'] }, 1, null);

  const running = presenter.run();
  // Read before awaiting: an `await` moved in front of `this.sink()` leaves this 0, because
  // the factory would then run a microtask later - which is a click's activation already gone.
  expect(asked).toBe(1);
  await running;
});
