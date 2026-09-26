// Typing a path walks as it goes, so the picker asks for several folders in a
// row and they answer out of order.
import { expect, test } from 'bun:test';
import { type BrowseResponse } from '../../../../../src/schemas/browse';
import { browseApi } from '../../../api/browse';
import { FolderBrowserPresenter } from '../folder_browser_presenter';
import { FolderBrowserStore } from '../folder_browser_store';
import { restoreApiAfterTests } from '../../../test_api';

restoreApiAfterTests();

const pending = new Map<string, (listing: BrowseResponse) => void>();

// `api` is a module singleton, so this is the seam.
browseApi.get = (path?: string): Promise<BrowseResponse> =>
  new Promise((resolve) => pending.set(path ?? '', resolve));

function land(path: string): void {
  pending.get(path)?.({ path, parent: null, directories: [], writable: true });
  pending.delete(path);
}

test('a slower earlier walk does not land on top of a later one', async () => {
  const store = new FolderBrowserStore();
  const presenter = new FolderBrowserPresenter(store);

  const first = presenter.open('/photos');
  const second = presenter.open('/photos/2024');
  land('/photos/2024');
  land('/photos');
  await Promise.all([first, second]);

  expect(store.listing?.path).toBe('/photos/2024');
  expect(store.loading).toBe(false);
});

test('a new folder is made inside the one listed, and the walk lands in it', async () => {
  const store = new FolderBrowserStore();
  const presenter = new FolderBrowserPresenter(store);
  const asked: string[] = [];
  browseApi.createFolder = (parent, name) => {
    asked.push(`${parent} ${name}`);
    return Promise.resolve({ path: `${parent}/${name}`, parent, directories: [], writable: true });
  };
  const opened = presenter.open('/pictures');
  land('/pictures');
  await opened;

  expect(await presenter.createFolder(' Trip ')).toBe(true);

  expect(asked).toEqual(['/pictures Trip']);
  expect(store.listing?.path).toBe('/pictures/Trip');
});

test('a refused folder says why and leaves the listing where it was', async () => {
  const store = new FolderBrowserStore();
  const presenter = new FolderBrowserPresenter(store);
  browseApi.createFolder = () => Promise.reject(new Error('/pictures/Trip already exists'));
  const opened = presenter.open('/pictures');
  land('/pictures');
  await opened;

  expect(await presenter.createFolder('Trip')).toBe(false);

  expect(store.listing?.path).toBe('/pictures');
  expect(store.error).toBe('/pictures/Trip already exists');
});
