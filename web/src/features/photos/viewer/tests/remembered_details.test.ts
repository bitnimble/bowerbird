// A cull flips between two frames far more often than it walks forward, so the detail and the
// develop document behind a photograph are read once and kept. What is under test is that a
// second open costs no request, and that leaving the editor - the one writer the panel cannot
// see - puts the document back in play.
import { expect, test } from 'bun:test';
import { type EditState } from '../../../../../../src/schemas/photo_edits';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { photoEditsApi } from '../../../../api/photo_edits';
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

function detail(id: string): PhotoDetail {
  return { id, library_id: LIB, renditions: {} } as unknown as PhotoDetail;
}

function build(): { store: ViewerStore; presenter: PhotosPresenter; reads: string[]; docs: string[] } {
  const reads: string[] = [];
  const docs: string[] = [];
  photosApi.get = (photoId: string): Promise<PhotoDetail> => {
    reads.push(photoId);
    return Promise.resolve(detail(photoId));
  };
  photoEditsApi.get = (photoId: string): Promise<EditState> => {
    docs.push(photoId);
    return Promise.resolve({ doc: { exposure: 0 }, rev: 1, canUndo: false, canRedo: false } as unknown as EditState);
  };
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  // A source already in hand, so opening a photo does not go and read a collection as well.
  listing.source = { kind: 'library', libraryId: LIB };
  const presenter = new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, {} as never, absent);
  return { store, presenter, reads, docs };
}

test('a photograph opened twice is read once', async () => {
  const { store, presenter, reads } = build();

  await presenter.openDetail('p1');
  await presenter.openDetail('p2');
  await presenter.openDetail('p1');

  expect(reads).toEqual(['p1', 'p2']);
  expect(store.detailFor('p1')?.id).toBe('p1');
});

test('a develop document is read once, and again once the editor has been in it', async () => {
  const { presenter, docs } = build();

  await presenter.loadEdits('p1');
  await presenter.loadEdits('p1');
  expect(docs).toEqual(['p1']);

  presenter.forgetEdits('p1');
  await presenter.loadEdits('p1');
  expect(docs).toEqual(['p1', 'p1']);
});
