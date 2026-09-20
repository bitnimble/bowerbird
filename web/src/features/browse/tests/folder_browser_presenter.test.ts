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
