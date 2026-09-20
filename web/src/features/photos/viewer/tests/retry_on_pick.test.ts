// A frame the stage gave up on is dropped from what it mounts, so the rendition beside it
// stays on screen and the picker reads as a control that does nothing. Pressing the key is
// the only way a reader can say "try again", so it has to be one.
import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../../src/schemas/settings';
import { photosApi } from '../../../../api/photos';
import { renditionsApi } from '../../../../api/renditions';
import { PhotosPresenter } from '../../photos_presenter';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

restoreApiAfterTests();

const PHOTO = 'p0';

renditionsApi.build = (): Promise<void> => Promise.resolve();
photosApi.get = (): Promise<PhotoDetail> => Promise.resolve({ id: PHOTO } as PhotoDetail);

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function open(): { store: ViewerStore; presenter: PhotosPresenter } {
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
            (['embedded', 'full', 'max'] as ViewerRendition[]).map((each) => [each, { built: true }]),
          ),
        } as unknown as PhotoDetail,
      ],
    ]);
  });
  return { store, presenter };
}

test('every pick asks the stage to try the frame again', async () => {
  const { store, presenter } = open();
  const before = store.retryEpoch;

  await presenter.chooseRendition(PHOTO, 'embedded');
  expect(store.retryEpoch).toBeGreaterThan(before);

  // Including the one already on screen: that is what a reader presses when the picture did
  // not appear, and it is the press that has to reach a frame the stage has written off.
  const again = store.retryEpoch;
  await presenter.chooseRendition(PHOTO, 'embedded');
  expect(store.retryEpoch).toBeGreaterThan(again);
});

// The other half of the same number, so a reconnect and a keypress cannot cancel out.
test('a server that came back asks too', () => {
  const { store, presenter } = open();
  const before = store.retryEpoch;
  presenter.serverReachable();
  expect(store.retryEpoch).toBeGreaterThan(before);
});
