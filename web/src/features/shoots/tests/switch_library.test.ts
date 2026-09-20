// Everything the list remembers is about the rows it is showing, and two
// libraries name their folders independently, so the second one starts clean
// rather than resuming somebody else's place in it.
import { beforeEach, expect, test } from 'bun:test';
import { type PhotoListResponse } from '../../../../../src/schemas/photos';
import { type Shoot } from '../../../../../src/schemas/shoots';
import { librariesApi } from '../../../api/libraries';
import { photosApi } from '../../../api/photos';
import { shootsApi } from '../../../api/shoots';
import { SidebarPresenter } from '../../../app/sidebar_presenter';
import { SidebarStore } from '../../../app/sidebar_store';
import { AppSettingsStore } from '../../settings/app_settings_store';
import { restoreApiAfterTests } from '../../../test_api';
import { MemoryStorage } from '../../../test_storage';
import { ShootsPresenter } from '../shoots_presenter';
import { ShootsStore } from '../shoots_store';

restoreApiAfterTests();
// The sidebar presenter this builds reads its remembered sections as it is constructed,
// and the runner is shared: without this, what another file wrote decides what it holds.
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

function shoot(library_id: string, folder_path: string): Shoot {
  return {
    id: `${library_id}:${folder_path}`,
    parent_id: null,
    library_id,
    folder_path,
    name: folder_path,
    description: null,
    banner_photo_id: null,
    ordering: 'taken_asc',
    photo_count: 0,
    is_hidden: false,
    hidden_directly: false,
  };
}

// 'Reef' is in both, which is the collision a remembered rename would land on.
const SHOOTS: Record<string, Shoot[]> = {
  a: [shoot('a', 'Kelp'), shoot('a', 'Reef')],
  b: [shoot('b', 'Reef'), shoot('b', 'Wharf')],
};

// `api` is a module singleton, so this is the seam.
shootsApi.list = (libraryId: string): Promise<Shoot[]> => Promise.resolve(SHOOTS[libraryId] ?? []);
librariesApi.folders = (): Promise<string[]> => Promise.resolve([]);
photosApi.listLibrary = (): Promise<PhotoListResponse> =>
  Promise.resolve({ photos: [], offset: 0, limit: 1, ordering: 'taken_asc' });

test('a different library starts the list clean', async () => {
  const store = new ShootsStore();
  const sidebar = new SidebarStore(new AppSettingsStore());
  const presenter = new ShootsPresenter(store, new SidebarPresenter(sidebar));
  await presenter.load('a');
  // The sidebar lists the same shoots, so this read is handed over rather than made
  // twice - and each library keeps its own, the sidebar listing every one of them.
  expect(sidebar.shootsByLibrary.get('a')).toEqual(SHOOTS.a!);
  presenter.setCursor('Reef');
  presenter.startRename('Reef', 'Reef');
  expect(store.lastCursorIndex).toBe(1);

  await presenter.load('b');

  expect(sidebar.shootsByLibrary.get('a')).toEqual(SHOOTS.a!);
  expect(sidebar.shootsByLibrary.get('b')).toEqual(SHOOTS.b!);
  expect(store.cursorKey).toBeNull();
  expect(store.renamingKey).toBeNull();
  expect(store.renameDraft).toBe('');

  // The first arrow lands on the first row, not one past where the last list
  // was left.
  presenter.moveCursor(1);
  expect(store.cursorRow?.key).toBe('Reef');
});
