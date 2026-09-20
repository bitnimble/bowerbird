// What the grid shows while a merge runs. The call itself is minutes long and answers once, so
// everything a reader sees in between comes from the progress stream - and the two things that
// must hold are that the frames being merged are marked from the click rather than from the first
// event, and that the toast is one toast whose bar moves.
import { runInAction } from 'mobx';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type PhotoListResponse } from '../../../../../../src/schemas/photos';
import { compositesApi } from '../../../../api/composites';
import { photosApi } from '../../../../api/photos';
import type { CompositeProgress } from '../../../../../../src/schemas/composition';
import { PhotosPresenter } from '../../photos_presenter';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

function build(): { store: StacksStore; presenter: PhotosPresenter; toasts: ToastsStore } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const store = new StacksStore();
  const listing = new ListingStore(store);
  const marks = new MarksStore(listing, store);
  const viewer = new ViewerStore(listing, store);
  const toasts = new ToastsStore();
  const presenter = new PhotosPresenter(
    listing,
    marks,
    store,
    viewer,
    absent,
    absent,
    absent,
    new ToastsPresenter(toasts),
    {} as never,
    absent,
  );
  runInAction(() => {
    listing.source = { kind: 'library', libraryId: 'lib' };
    listing.total = 20;
    marks.selection = SelectionRanges.of(2, 4);
  });
  return { store, presenter, toasts };
}

function progressed(phase: CompositeProgress['phase'], fraction: number): CompositeProgress {
  return { photoId: 'panorama1', photoIds: ['a', 'b', 'c'], phase, fraction };
}

// The merge answers as soon as the test lets it; what it answers is not what these are about.
const stubbed = {
  createPanorama: compositesApi.createPanorama,
  photoPositions: photosApi.positions,
  listLibraryPhotos: photosApi.listLibrary,
};

beforeEach(() => {
  compositesApi.createPanorama = () => Promise.resolve({ photoId: 'panorama1' });
  photosApi.positions = () => Promise.resolve({});
  photosApi.listLibrary = () =>
    Promise.resolve({ photos: [], total: 20, offset: 0, limit: 1, ordering: 'taken_desc' } as PhotoListResponse);
});

afterEach(() => {
  compositesApi.createPanorama = stubbed.createPanorama;
  photosApi.positions = stubbed.photoPositions;
  photosApi.listLibrary = stubbed.listLibraryPhotos;
});

test('the rows a merge is about are marked, by position before the stream says anything', async () => {
  const { store, presenter } = build();
  const merging = presenter.mergeSelectionToPanorama();

  expect(store.waitingOnMerge(3, 'nothing')).toBe(true);
  expect(store.waitingOnMerge(9, 'nothing')).toBe(false);
  // And by id once the server has named them, which is how a second view of the same library
  // marks rows this client never selected.
  presenter.compositeProgressed(progressed('picture', 0.4));
  expect(store.waitingOnMerge(9, 'b')).toBe(true);

  presenter.compositeProgressed(progressed('done', 1));
  expect(store.waitingOnMerge(3, 'a')).toBe(false);
  await merging;
});

test('one toast, whose bar moves with the merge', async () => {
  const { presenter, toasts } = build();
  const merging = presenter.mergeSelectionToPanorama();
  expect(toasts.toasts).toHaveLength(1);
  expect(toasts.toasts[0]?.progress).toBe(0);

  presenter.compositeProgressed(progressed('tile', 0.2));
  presenter.compositeProgressed(progressed('picture', 0.55));
  expect(toasts.toasts).toHaveLength(1);
  expect(toasts.toasts[0]?.progress).toBe(0.55);
  expect(toasts.toasts[0]?.message).toContain('rendering the photo');

  presenter.compositeProgressed(progressed('done', 1));
  expect(toasts.toasts).toHaveLength(0);
  await merging;
});
