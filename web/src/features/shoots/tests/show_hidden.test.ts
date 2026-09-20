// Whether the shoots put away are on the page is the server's answer, not a filter this client
// lifts (§12.4) - so the toggle has to re-read, and it has to carry the same flag to both readings
// or the tree keeps a hidden shoot's folders after the shoot has gone from it.
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
// The sidebar presenter these build reads its remembered sections as it is constructed,
// and the runner is shared: without this, what another file wrote decides what it holds.
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

function shoot(folderPath: string, isHidden: boolean): Shoot {
  return {
    id: `id:${folderPath}`,
    parent_id: null,
    library_id: 'lib',
    folder_path: folderPath,
    name: folderPath,
    description: null,
    banner_photo_id: null,
    ordering: 'taken_asc',
    photo_count: 0,
    is_hidden: isHidden,
    hidden_directly: isHidden,
  };
}

const REEF = shoot('Reef', false);
const WHARF = shoot('Wharf', true);

/** What each reading was asked for, so the pair can be held against each other. */
let asked: { shoots: boolean[]; folders: boolean[] };

function stubApi(): void {
  asked = { shoots: [], folders: [] };
  shootsApi.list = (_libraryId: string, includeHidden = false): Promise<Shoot[]> => {
    asked.shoots.push(includeHidden);
    return Promise.resolve(includeHidden ? [REEF, WHARF] : [REEF]);
  };
  librariesApi.folders = (_libraryId: string, includeHidden = false): Promise<string[]> => {
    asked.folders.push(includeHidden);
    return Promise.resolve(includeHidden ? ['Reef', 'Wharf'] : ['Reef']);
  };
  photosApi.listLibrary = (): Promise<PhotoListResponse> =>
    Promise.resolve({ photos: [], offset: 0, limit: 1, ordering: 'taken_asc' });
}

test('the toggle re-reads, and asks both readings the same thing', async () => {
  stubApi();
  const store = new ShootsStore();
  const presenter = new ShootsPresenter(store, new SidebarPresenter(new SidebarStore(new AppSettingsStore())));

  await presenter.load('lib');
  expect([asked.shoots, asked.folders]).toEqual([[false], [false]]);
  expect(store.shoots.map((s) => s.folder_path)).toEqual(['Reef']);

  // Awaited, not given a few microtasks and hoped for: the toggle hands its re-read back, so this
  // is the rows having actually landed rather than the test having waited long enough.
  await presenter.setShowHidden(true);

  expect([asked.shoots.at(-1), asked.folders.at(-1)]).toEqual([true, true]);
  expect(store.shoots.map((s) => s.folder_path)).toEqual(['Reef', 'Wharf']);
});

// The page draws what it was served; nothing here filters, so a hidden shoot arriving is a hidden
// shoot on screen.
test('what the server sent is what the page draws', async () => {
  stubApi();
  const store = new ShootsStore();
  const presenter = new ShootsPresenter(store, new SidebarPresenter(new SidebarStore(new AppSettingsStore())));
  store.showHidden = true;

  await presenter.load('lib');

  expect(store.rows.map((r) => r.key)).toEqual(['Reef', 'Wharf']);
  expect(store.rows.find((r) => r.key === 'Wharf')?.tone).toBe('hidden');
});

// The page hands its read to the sidebar so a rename reaches it without a second request. The Hidden
// reading is the one it must keep: the sidebar offers no way to put a shoot back, so one arriving
// there is a destination the reader cannot get rid of.
test('the sidebar takes the page’s read, but never the Hidden one', async () => {
  stubApi();
  const store = new ShootsStore();
  const sidebar = new SidebarStore(new AppSettingsStore());
  const presenter = new ShootsPresenter(store, new SidebarPresenter(sidebar));

  await presenter.load('lib');
  expect(sidebar.shootsByLibrary.get('lib')).toEqual([REEF]);

  await presenter.setShowHidden(true);

  expect(store.shoots.map((s) => s.folder_path)).toEqual(['Reef', 'Wharf']);
  expect(sidebar.shootsByLibrary.get('lib')).toEqual([REEF]);
});
