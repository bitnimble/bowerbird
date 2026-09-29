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
