// The write behind "reopen at whatever was chosen last". Every pick used to reach
// the server, including the one that chose what was already showing, and the
// server re-configures its watcher and its schedulers from a settings change.
import { beforeEach, expect, test } from 'bun:test';
import { api, type Settings, type UpdateSettingsRequest, type ViewerRendition, type ViewerRenditionMode } from '../../../api/client';
import { AppSettingsPresenter } from '../app_settings_presenter';
import { AppSettingsStore } from '../app_settings_store';

const patches: UpdateSettingsRequest[] = [];

// `api` is a module singleton, so this is the seam.
api.updateSettings = (body: UpdateSettingsRequest): Promise<Settings> => {
  patches.push(body);
  return Promise.resolve({ ...body } as Settings);
};

beforeEach(() => {
  patches.length = 0;
});

function build(mode: ViewerRenditionMode, last: ViewerRendition | null): AppSettingsPresenter {
  const store = new AppSettingsStore();
  store.settings = { viewer_rendition_mode: mode, last_viewer_rendition: last } as Settings;
  return new AppSettingsPresenter(store);
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
