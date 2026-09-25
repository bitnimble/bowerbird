// The page reads the hidden shoots with everything else, so showing them is a filter over rows in
// hand (§12.4): the toggle is instant, and it drops a hidden shoot's folders along with the shoot.
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

let requests = 0;

function stubApi(): void {
  requests = 0;
  shootsApi.list = (_libraryId: string, includeHidden = false): Promise<Shoot[]> => {
    requests++;
    return Promise.resolve(includeHidden ? [REEF, WHARF] : [REEF]);
  };
  librariesApi.folders = (_libraryId: string, includeHidden = false): Promise<string[]> => {
    requests++;
    return Promise.resolve(includeHidden ? ['Reef', 'Wharf', 'Wharf/Day one'] : ['Reef']);
  };
  photosApi.listLibrary = (): Promise<PhotoListResponse> => {
    requests++;
    return Promise.resolve({ photos: [], offset: 0, limit: 1, ordering: 'taken_asc' });
  };
}

function build(): { store: ShootsStore; presenter: ShootsPresenter; sidebar: SidebarStore } {
  const store = new ShootsStore();
  const sidebar = new SidebarStore(new AppSettingsStore());
  return { store, presenter: new ShootsPresenter(store, new SidebarPresenter(sidebar)), sidebar };
}

test('the toggle shows and hides the hidden shoots without asking the server again', async () => {
  stubApi();
  const { store, presenter } = build();

  await presenter.load('lib');
  expect(store.rows.map((r) => r.key)).toEqual(['Reef']);
  const loaded = requests;

  presenter.setShowHidden(true);
  expect(store.rows.map((r) => r.key)).toEqual(['Reef', 'Wharf']);
  expect(store.rows.find((r) => r.key === 'Wharf')?.tone).toBe('hidden');

  presenter.setShowHidden(false);
  expect(store.rows.map((r) => r.key)).toEqual(['Reef']);
  expect(requests).toBe(loaded);
});

test('a hidden shoot’s folders leave the full tree with it', async () => {
  stubApi();
  const { store, presenter } = build();
  presenter.setView('tree_full');

  await presenter.load('lib');
  expect(store.rows.map((r) => r.key)).toEqual(['Reef']);

  presenter.setShowHidden(true);
  presenter.toggleExpanded('Wharf');
  expect(store.rows.map((r) => r.key)).toEqual(['Reef', 'Wharf', 'Wharf/Day one']);

  presenter.setShowHidden(false);
  expect(store.rows.map((r) => r.key)).toEqual(['Reef']);
});

// The page hands its read to the sidebar so a rename reaches it without a second request, less the
// hidden: the sidebar offers no way to put a shoot back, so one arriving there is a destination the
// reader cannot get rid of.
test('the sidebar takes the page’s read, but never a hidden shoot', async () => {
  stubApi();
  const { presenter, sidebar } = build();

  await presenter.load('lib');
  presenter.setShowHidden(true);

  expect(sidebar.shootsByLibrary.get('lib')).toEqual([REEF]);
});
