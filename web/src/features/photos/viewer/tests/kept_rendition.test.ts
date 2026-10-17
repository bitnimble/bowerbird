// The reader's pick of rendition belongs to the photograph they are on. Into the mockup or the
// editor and back, or out to the grid and back, they are still on it; a step is a new photograph.
import { expect, test } from 'bun:test';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

restoreApiAfterTests();

const LIB = 'lib-1';

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function build(): { store: ViewerStore; presenter: PhotosPresenter } {
  photosApi.get = (photoId: string): Promise<PhotoDetail> =>
    Promise.resolve({
      id: photoId,
      library_id: LIB,
      renditions: {},
      shown_rendition: 'embedded',
    } as unknown as PhotoDetail);
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  listing.source = { kind: 'library', libraryId: LIB };
  const presenter = new PhotosPresenter(
    listing,
    marks,
    stacks,
    store,
    absent,
    absent,
    absent,
    absent,
    {} as never,
    absent,
  );
  return { store, presenter };
}

test('a pick outlives the photograph being opened again, and not a step', async () => {
  const { store, presenter } = build();

  await presenter.openDetail('p1');
  presenter.holdRendition('p1', 'max');
  await presenter.openDetail('p1');
  expect(store.frameOf('p1').rendition).toBe('max');

  await presenter.openDetail('p2');
  expect(store.frameOf('p2').rendition).toBe('embedded');
});

test('a finished picture its browser cannot draw is shown rendered, and only that one', async () => {
  const { store, presenter } = build();

  await presenter.openDetail('p1');
  await presenter.frameMissing('p1', 'embedded', false);
  expect(store.frameOf('p1').rendition).toBe('embedded');
  await presenter.frameMissing('p1', 'embedded', true);
  expect(store.frameOf('p1').rendition).toBe('full');
  expect(store.frameOf('p2').rendition).toBe('embedded');
});

test('a row with no camera picture behind it offers only the renders', async () => {
  const { store, presenter } = build();
  const raw = photosApi.get;
  photosApi.get = async (photoId: string): Promise<PhotoDetail> => ({
    ...(await raw(photoId)),
    is_raw: true,
    has_embedded: false,
  });

  await presenter.openDetail('p1');
  expect(store.renditionChoices('p1')).toEqual(['full', 'max']);
  const asked = store.retryEpoch;
  await presenter.chooseRendition('p1', 'embedded');
  expect(store.retryEpoch).toBe(asked);
});

test('a finished picture offers no rendition to choose, and a key asking for one changes nothing', async () => {
  const { store, presenter } = build();
  const raw = photosApi.get;
  photosApi.get = async (photoId: string): Promise<PhotoDetail> => ({
    ...(await raw(photoId)),
    is_raw: false,
  });

  await presenter.openDetail('p1');
  expect(store.renditionChoices('p1')).toEqual([]);
  const asked = store.retryEpoch;
  await presenter.chooseRendition('p1', 'max');
  expect(store.retryEpoch).toBe(asked);
  expect(store.frameOf('p1').rendition).toBe('embedded');
});

test("a photo's own file is HDR when what it decoded to holds light above SDR white", async () => {
  const { store, presenter } = build();

  await presenter.openDetail('p1');
  expect(store.proofOf('p1')).toBe('srgb');
  presenter.imageShown('p1', 'embedded', 3000, 4000, true);
  expect(store.proofOf('p1')).toBe('hdr');
  presenter.imageShown('p1', 'embedded', 3000, 4000, false);
  expect(store.proofOf('p1')).toBe('srgb');
});

test('leaving the editor keeps a render picked and drops the camera JPEG, which has no edits in it', async () => {
  const { store, presenter } = build();

  await presenter.openDetail('p1');
  presenter.holdRendition('p1', 'max');
  presenter.forgetEdits('p1');
  expect(store.rendition).toBe('max');

  presenter.holdRendition('p1', 'embedded');
  presenter.forgetEdits('p1');
  expect(store.rendition).toBeNull();
});
