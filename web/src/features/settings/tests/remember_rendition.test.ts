// The write behind "reopen at whatever was chosen last". A settings change makes
// the server re-configure its watcher and its schedulers, so a pick that chose
// what was already showing is a round trip worth not making.
import { beforeEach, expect, test } from 'bun:test';
import { type Settings, type UpdateSettingsRequest, type ViewerRendition, type ViewerRenditionMode } from '../../../../../src/schemas/settings';
import { settingsApi } from '../../../api/settings';
import { AppSettingsPresenter } from '../app_settings_presenter';
import { AppSettingsStore } from '../app_settings_store';
import { restoreApiAfterTests } from '../../../test_api';

restoreApiAfterTests();

const patches: UpdateSettingsRequest[] = [];

// `api` is a module singleton, so this is the seam.
settingsApi.update = (body: UpdateSettingsRequest): Promise<Settings> => {
  patches.push(body);
  return Promise.resolve({ ...body } as Settings);
};

beforeEach(() => {
  patches.length = 0;
});

function build(mode: ViewerRenditionMode, last: ViewerRendition | null): AppSettingsPresenter {
  const store = new AppSettingsStore();
  store.settings = { viewer_rendition_mode: mode, last_viewer_rendition: last } as Settings;
  return new AppSettingsPresenter(store, { showError: () => {} } as never);
}

test('choosing the rendition already remembered writes nothing', async () => {
  await build('remember', 'full').rememberRendition('full');
  expect(patches).toEqual([]);
});

test('choosing a different rendition writes it', async () => {
  await build('remember', 'embedded').rememberRendition('full');
  expect(patches).toEqual([{ last_viewer_rendition: 'full' }]);
});

// Nothing has been chosen yet, so there is something to record even though the
// viewer is showing a rendition already.
test('the first choice is written', async () => {
  await build('remember', null).rememberRendition('embedded');
  expect(patches).toEqual([{ last_viewer_rendition: 'embedded' }]);
});

test('the per-photo mode writes nothing here', async () => {
  await build('remember_per_photo', 'embedded').rememberRendition('full');
  expect(patches).toEqual([]);
});
