// Where an on-demand rendition is rendered is this device's setting; the server keeps it either way.
import { beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../../src/schemas/settings';
import { type Rendition } from '../../../../../../src/services/processing/renditions/renditions';
import { photosApi } from '../../../../api/photos';
import { renditionsApi } from '../../../../api/renditions';
import { PhotosPresenter } from '../../photos_presenter';
import { DeviceSettingsStore } from '../../../settings/device_settings_store';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

restoreApiAfterTests();

const PHOTO = 'p0';

const calls: string[] = [];
let answer: () => Promise<Awaited<ReturnType<typeof renditionsApi.job>>> = () => Promise.resolve({ job: null });

renditionsApi.build = (_photoId: string, rendition: Rendition, force = false): Promise<void> => {
  calls.push(`build ${rendition} ${force}`);
  return Promise.resolve();
};
renditionsApi.job = (_photoId: string, rendition: Rendition, force = false) => {
  calls.push(`job ${rendition} ${force}`);
  return answer();
};
photosApi.get = (): Promise<PhotoDetail> => Promise.resolve({ id: PHOTO } as PhotoDetail);

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function open(renderOnThisDevice: boolean): { store: ViewerStore; presenter: PhotosPresenter } {
  const settings = { viewerRenditionMode: 'remember', lastViewerRendition: null } as never;
  const device = new DeviceSettingsStore();
  runInAction(() => (device.renderOnThisDevice = renderOnThisDevice));
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, settings, absent, device);
  runInAction(() => {
    store.open = { id: PHOTO, status: 'ready' };
    store.rendition = 'max';
    store.details = new Map([
      [
        PHOTO,
        {
          id: PHOTO,
          renditions: Object.fromEntries(
            (['embedded', 'full', 'max'] as ViewerRendition[]).map((each) => [each, { built: true }]),
          ),
        } as unknown as PhotoDetail,
      ],
    ]);
  });
  return { store, presenter };
}

beforeEach(() => {
  calls.length = 0;
  answer = () => Promise.resolve({ job: null });
});

test('off, the server builds it and is never asked for a job', async () => {
  const { presenter } = open(false);
  await presenter.rerenderRenditions(PHOTO);
  expect(calls).toEqual(['build max true']);
});

test('on, a photograph the server has no job for is built by the server', async () => {
  const { presenter } = open(true);
  await presenter.rerenderRenditions(PHOTO);
  expect(calls).toEqual(['job max true', 'build max true']);
});

test('on, a render this device cannot make is built by the server instead', async () => {
  answer = () => Promise.reject(new Error('no WebGPU'));
  const { presenter, store } = open(true);
  await presenter.rerenderRenditions(PHOTO);
  expect(calls).toEqual(['job max true', 'build max true']);
  expect(store.buildingRendition).toBe(false);
});
