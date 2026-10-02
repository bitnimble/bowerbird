import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type OriginalElsewhere, type PhotoDetail } from '../../../../../../src/schemas/photos';
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
const absent = new Proxy({}, { get: () => () => undefined }) as never;

function open(
  elsewhere: OriginalElsewhere,
  renditions: Record<string, { built: boolean }> = {},
): { built: string[]; store: ViewerStore; presenter: PhotosPresenter } {
  const built: string[] = [];
  renditionsApi.build = (photoId, rendition): Promise<void> => {
    built.push(`${rendition} of ${photoId}`);
    return Promise.resolve();
  };
  photosApi.get = (): Promise<PhotoDetail> => Promise.resolve({ id: PHOTO } as PhotoDetail);
  const settings = { viewerRenditionMode: 'remember', lastViewerRendition: null } as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(
    listing,
    marks,
    stacks,
    store,
    absent,
    absent,
    absent,
    absent,
    settings,
    absent,
  );
  runInAction(() => {
    store.open = { id: PHOTO, status: 'ready' };
    store.details = new Map([
      [PHOTO, { id: PHOTO, is_missing: true, original_elsewhere: elsewhere, renditions } as never],
    ]);
  });
  return { built, store, presenter };
}

test.each([
  ['reachable', ['full of p0']],
  ['unreachable', []],
] as const)(
  'a missing rendition of a photo whose original is %s asks for a build: %p',
  async (elsewhere, expected) => {
    const { built, presenter } = open(elsewhere);
    await presenter.buildMissingRendition(PHOTO, 'full');
    expect(built).toEqual([...expected]);
  },
);

test('picking a rendition of an unreachable photo builds nothing, and keeps a copy already here', async () => {
  const unbuilt = open('unreachable');
  await unbuilt.presenter.chooseRendition(PHOTO, 'full');
  expect(unbuilt.built).toEqual([]);
  expect(unbuilt.store.rendition).toBeNull();

  const cached = open('unreachable', { full: { built: true } });
  await cached.presenter.chooseRendition(PHOTO, 'full');
  expect(cached.built).toEqual([]);
  expect(cached.store.rendition).toBe('full');
});
