// The page's three actions, against a recording API: what the reader can do to a history is
// read it, forget one file of it, and ask the shell to show that file - and each of those has
// a failure the page has to survive rather than a happy path worth restating.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { exportsApi } from '../../../api/exports';
import { type ExportRun } from '../../../../../src/schemas/exports';
import { restoreApiAfterTests } from '../../../test_api';
import { ExportHistoryPresenter } from '../export_history_presenter';
import { ExportHistoryStore } from '../export_history_store';

restoreApiAfterTests();

const toasted: string[] = [];
const toasts = { show: (message: string) => toasted.push(message) } as never;

function run(id: string, photoIds: string[]): ExportRun {
  return {
    id,
    exported_at: '2026-09-09T00:00:00.000Z',
    photos: photoIds.map((photoId) => ({
      id: `${id}-${photoId}`,
      photo_id: photoId,
      library_id: 'lib',
      library_name: 'Trips',
      shoot_id: null,
      shoot_name: null,
      source_path: `raw/${photoId}.arw`,
      output_path: `/exports/${photoId}.jpg`,
      edits: null,
      width: 6000,
      height: 4000,
      has_thumbnail: false,
      exported_at: '2026-09-09T00:00:00.000Z',
    })),
  };
}

function open(runs: ExportRun[]): { store: ExportHistoryStore; presenter: ExportHistoryPresenter } {
  const store = new ExportHistoryStore();
  exportsApi.list = () => Promise.resolve(runs);
  return { store, presenter: new ExportHistoryPresenter(store, toasts) };
}

beforeEach(() => {
  toasted.length = 0;
  exportsApi.forget = () => Promise.resolve();
});

afterEach(() => {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});

test('a history that will not load says why rather than reading as an empty one', async () => {
  const store = new ExportHistoryStore();
  exportsApi.list = () => Promise.reject(new Error('no catalogue'));
  await new ExportHistoryPresenter(store, toasts).load();

  expect(store.loading).toBe(false);
  expect(store.error).toBe("We couldn't load your export history. Try again.");
  expect(store.runs).toEqual([]);
});

test('forgetting a file takes it out of the run it was in', async () => {
  const { store, presenter } = open([run('r1', ['a', 'b'])]);
  await presenter.load();

  await presenter.forget('r1-a');

  expect(store.runs[0]?.photos.map((photo) => photo.photo_id)).toEqual(['b']);
});

// A run is the files in it, so the last one leaving takes the run rather than leaving a
// heading over nothing - the same rule the server's own listing follows.
test('forgetting the last file of a run takes the run with it', async () => {
  const { store, presenter } = open([run('r1', ['a']), run('r2', ['b'])]);
  await presenter.load();

  await presenter.forget('r1-a');

  expect(store.runs.map((each) => each.id)).toEqual(['r2']);
});

test('forgetting a run takes every file of it out of the list', async () => {
  const forgotten: string[] = [];
  exportsApi.forgetRun = (runId: string) => {
    forgotten.push(runId);
    return Promise.resolve();
  };
  const { store, presenter } = open([run('r1', ['a', 'b', 'c']), run('r2', ['d'])]);
  await presenter.load();

  await presenter.forgetRun('r1');

  expect(forgotten).toEqual(['r1']);
  expect(store.runs.map((each) => each.id)).toEqual(['r2']);
});

// The row stays: it is still in the history until the server says otherwise, and a page that
// removed it anyway would say the file was forgotten when the next load brings it back.
test('a forget the server refused leaves the row where it is', async () => {
  const { store, presenter } = open([run('r1', ['a'])]);
  await presenter.load();
  exportsApi.forget = () => Promise.reject(new Error('not this one'));

  await presenter.forget('r1-a');

  expect(store.runs[0]?.photos).toHaveLength(1);
  expect(store.error).toBe("We couldn't remove that export from history. Try again.");
});

// The same rule as a single file's: the run is still in the history until the server says
// otherwise, and a page that removed it anyway would bring it back on the next load.
test('a run the server refused to forget stays in the list', async () => {
  exportsApi.forgetRun = () => Promise.reject(new Error('not this one'));
  const { store, presenter } = open([run('r1', ['a', 'b'])]);
  await presenter.load();

  await presenter.forgetRun('r1');

  expect(store.runs.map((each) => each.id)).toEqual(['r1']);
  expect(store.error).toBe("We couldn't remove that export from history. Try again.");
});

// The button is offered only where there is a file manager to open, which is the shell.
test('showing a file in its folder is asked of the shell, and only offered there', async () => {
  const { presenter } = open([]);
  expect(presenter.canReveal).toBe(false);
  // Reached anyway, which is what a stale render would do: it must ask nothing rather than throw.
  await presenter.reveal('/exports/a.jpg');

  const asked: { command: string; args: unknown }[] = [];
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke: (command: string, args: unknown) => { asked.push({ command, args }); return Promise.resolve(); } },
  };

  expect(presenter.canReveal).toBe(true);
  await presenter.reveal('/exports/a.jpg');
  expect(asked).toEqual([{ command: 'reveal_file', args: { path: '/exports/a.jpg' } }]);
});

// A file the reader has since moved or deleted is the ordinary case, and it is their filing
// rather than a failure of this page - so it is a toast, not the page's error line.
test('a file the shell cannot show is reported and leaves the page alone', async () => {
  const { store, presenter } = open([]);
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke: () => Promise.reject('/exports/a.jpg is no longer there') },
  };

  await presenter.reveal('/exports/a.jpg');

  expect(toasted).toEqual(["We couldn't show that export in its folder. Check if it moved."]);
  expect(store.error).toBeNull();
});
