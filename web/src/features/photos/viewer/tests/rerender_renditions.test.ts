// Re-rendering is the one build that runs against a file that is already there,
// and it is not a way of choosing a rendition: the reader stays on whatever they
// were looking at, and it is that one which gets remade.
import { beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../../src/schemas/settings';
import { type Rendition } from '../../../../../../src/services/processing/renditions/renditions';
import { photosApi } from '../../../../api/photos';
import { renditionsApi } from '../../../../api/renditions';
import { PhotosPresenter } from '../../photos_presenter';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';
import type { RequestActivity } from '../../../../../../src/schemas/request_activity';

restoreApiAfterTests();

const PHOTO = 'p0';

const builds: { rendition: Rendition; force: boolean }[] = [];
let finish = (): void => undefined;
const activities: (RequestActivity | undefined)[] = [];

// `api` is a module singleton, so this is the seam.
renditionsApi.build = (_photoId: string, rendition: Rendition, force = false): Promise<void> => {
  builds.push({ rendition, force });
  return new Promise((resolve) => (finish = () => resolve()));
};
photosApi.get = (_id, activity): Promise<PhotoDetail> => {
  activities.push(activity);
  return Promise.resolve({ id: PHOTO } as PhotoDetail);
};

const absent = new Proxy({}, { get: () => () => undefined }) as never;

// `built` names the renditions on disk: this action remakes a file rather than making one,
// so what it offers is what the detail statted.
function open(built: ViewerRendition[] = ['full', 'max']): { store: ViewerStore; presenter: PhotosPresenter } {
  const settings = { viewerRenditionMode: 'remember', lastViewerRendition: null } as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, settings, absent);
  runInAction(() => {
    store.open = { id: PHOTO, status: 'ready' };
    store.details = new Map([
      [
        PHOTO,
        {
          id: PHOTO,
          renditions: Object.fromEntries(
            (['embedded', 'full', 'max'] as ViewerRendition[]).map((each) => [each, { built: built.includes(each) }]),
          ),
        } as unknown as PhotoDetail,
      ],
    ]);
  });
  return { store, presenter };
}

beforeEach(() => {
  builds.length = 0;
  activities.length = 0;
});

test('a rendition event refreshes detail in the background while an explicit build stays interactive', async () => {
  const { presenter } = open();
  const running = presenter.rerenderRenditions(PHOTO);
  finish();
  await running;
  expect(activities).toEqual(['interactive']);
  presenter.renditionsRebuilt(PHOTO, 'renditions', 'version');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(activities).toEqual(['interactive', 'background']);
});

// The bug this pins: it rebuilt `full` whatever was on screen, so a reader on the
// max-quality render asked for a re-render and was handed back the same file - the
// pipeline change they were checking for invisible, because that rendition was never
// remade. `max` is the one where it matters most, being the pixel-peeping view.
test('the rendition on screen is the one remade', async () => {
  const { store, presenter } = open();
  runInAction(() => (store.rendition = 'max'));

  const running = presenter.rerenderRenditions(PHOTO);
  expect(store.buildingRendition).toBe(true);
  finish();
  await running;

  expect(builds).toEqual([{ rendition: 'max', force: true }]);
  // Remade, not swapped to: the reader is left where they were.
  expect(store.showing).toBe('max');
  expect(store.buildingRendition).toBe(false);
});

test('the render is remade past the cache while the reader stays on it', async () => {
  const { store, presenter } = open();
  runInAction(() => (store.rendition = 'full'));

  const running = presenter.rerenderRenditions(PHOTO);
  finish();
  await running;

  expect(builds).toEqual([{ rendition: 'full', force: true }]);
  expect(store.showing).toBe('full');
});

// The RAW's own bytes cannot be rebuilt, and a photograph with no render behind them has
// nothing to remake - so this asks for nothing rather than forcing a rendition the reader
// is not looking at and cannot see. Off what is on disk rather than off what the library
// serves: an embedded library holding a render built on request has one to remake.
test('nothing is built for a photograph with no render behind the camera JPEG', async () => {
  const { presenter } = open([]);
  await presenter.rerenderRenditions(PHOTO);
  expect(builds).toEqual([]);
});

test('the render behind the camera JPEG is what a re-render remakes', async () => {
  const { presenter } = open(['full']);
  const running = presenter.rerenderRenditions(PHOTO);
  finish();
  await running;
  expect(builds).toEqual([{ rendition: 'full', force: true }]);
});
