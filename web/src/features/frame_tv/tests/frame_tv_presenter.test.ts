import { beforeEach, expect, test } from 'bun:test';
import type { SendToFrameTvRequest } from '../../../../../src/schemas/frame_tv';
import type { PhotoTarget } from '../../../../../src/schemas/photos';
import { DEFAULT_SETTINGS } from '../../../../../src/schemas/settings';
import { frameTvsApi } from '../../../api/frame_tvs';
import { photosApi } from '../../../api/photos';
import { ApiError } from '../../../api/request';
import { restoreApiAfterTests } from '../../../test_api';
import { AppSettingsStore } from '../../settings/app_settings_store';
import { ToastsPresenter } from '../../toasts/toasts_presenter';
import { ToastsStore } from '../../toasts/toasts_store';
import { FrameTvPresenter } from '../frame_tv_presenter';
import { FrameTvStore } from '../frame_tv_store';

restoreApiAfterTests();

const LIVING_ROOM = { id: 'uuid:living', name: 'Living room', host: '10.0.0.5' };
const sent: SendToFrameTvRequest[] = [];
let refuse: (photoId: string) => Error | null = () => null;

function presenter(target: PhotoTarget | null = null, enabled = true): { store: FrameTvStore; toasts: ToastsStore; presenter: FrameTvPresenter } {
  const store = new FrameTvStore();
  store.tvs = [LIVING_ROOM];
  const settings = new AppSettingsStore();
  settings.settings = { ...DEFAULT_SETTINGS, frame_tv_enabled: enabled };
  const toasts = new ToastsStore();
  const viewer = { frameOf: () => ({ source: '', rendition: 'max' as const }) };
  const photos = { selectionTarget: () => target };
  return {
    store,
    toasts,
    presenter: new FrameTvPresenter(store, settings, viewer as never, photos as never, new ToastsPresenter(toasts)),
  };
}

beforeEach(() => {
  sent.length = 0;
  refuse = () => null;
  frameTvsApi.send = (body: SendToFrameTvRequest): Promise<undefined> => {
    const refusal = refuse(body.photo_id);
    if (refusal != null) return Promise.reject(refusal);
    sent.push(body);
    return Promise.resolve(undefined);
  };
});

test('sends the photo at the rendition on screen and shows it', async () => {
  const { toasts, presenter: frameTv } = presenter();

  await frameTv.sendPhoto('aaaaaaaa', LIVING_ROOM.id);

  expect(sent).toEqual([{ tv_id: LIVING_ROOM.id, photo_id: 'aaaaaaaa', rendition: 'max', show: true }]);
  expect(toasts.toasts.map((toast) => toast.message)).toEqual(['Sent 1 photo to Living room.']);
});

test('sends a resolved selection in order, showing only the first', async () => {
  photosApi.ids = (): Promise<{ photo_ids: string[] }> => Promise.resolve({ photo_ids: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] });
  const { toasts, presenter: frameTv } = presenter({ selection: { ranges: [], members: ['aaaaaaaa'] } } as never);

  await frameTv.sendSelection(LIVING_ROOM.id);

  expect(sent.map((each) => [each.photo_id, each.rendition, each.show])).toEqual([
    ['aaaaaaaa', null, true],
    ['bbbbbbbb', null, false],
    ['cccccccc', null, false],
  ]);
  expect(toasts.toasts.map((toast) => toast.message)).toEqual(['Sent 3 photos to Living room.']);
});

test('keeps going past a photo that fails, and says how many did not arrive', async () => {
  refuse = (photoId) => (photoId === 'bbbbbbbb' ? new ApiError('NOT_FOUND', 'image not found on disk', 404) : null);
  const { toasts, presenter: frameTv } = presenter({ photo_ids: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] });

  await frameTv.sendSelection(LIVING_ROOM.id);

  expect(sent.map((each) => each.photo_id)).toEqual(['aaaaaaaa', 'cccccccc']);
  expect(toasts.toasts.map((toast) => [toast.message, toast.detail])).toEqual([
    ["We couldn't send 1 photo to Living room. Try again.", 'image not found on disk'],
  ]);
});

test('stops at the first photo the TV does not answer for', async () => {
  refuse = () => new ApiError('UNAVAILABLE', 'Living room: could not connect', 503);
  const { toasts, presenter: frameTv } = presenter({ photo_ids: ['aaaaaaaa', 'bbbbbbbb'] });
  let asked = 0;
  const send = frameTvsApi.send;
  frameTvsApi.send = (body) => {
    asked += 1;
    return send(body);
  };

  await frameTv.sendSelection(LIVING_ROOM.id);

  expect(asked).toBe(1);
  expect(toasts.toasts.map((toast) => toast.message)).toEqual(["We couldn't send 2 photos to Living room. Try again."]);
});

test('does not search the network while the integration is off', async () => {
  let searched = false;
  frameTvsApi.list = () => {
    searched = true;
    return Promise.resolve({ tvs: [] });
  };
  const { store, presenter: frameTv } = presenter(null, false);

  await frameTv.search();

  expect(searched).toBe(false);
  expect(store.tvs).toEqual([LIVING_ROOM]);
});

test('lists what the search finds', async () => {
  const bedroom = { id: 'uuid:bedroom', name: 'Bedroom', host: '10.0.0.6' };
  frameTvsApi.list = () => Promise.resolve({ tvs: [LIVING_ROOM, bedroom] });
  const { store, presenter: frameTv } = presenter();

  await frameTv.search();

  expect(store.tvs).toEqual([LIVING_ROOM, bedroom]);
  expect(store.searching).toBe(false);
});
