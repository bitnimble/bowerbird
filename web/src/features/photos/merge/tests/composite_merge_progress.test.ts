// What the grid shows while a merge runs. The call itself is minutes long and answers once, so
// everything a reader sees in between comes from the progress stream - and the two things that
// must hold are that the frames being merged are marked from the click rather than from the first
// event, and that the toast is one toast whose bar moves.
import { runInAction } from 'mobx';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type PhotoListResponse } from '../../../../../../src/schemas/photos';
import { compositesApi } from '../../../../api/composites';
import { photosApi } from '../../../../api/photos';
import { ApiError } from '../../../../api/request';
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

function progressed(
  phase: CompositeProgress['phase'],
  fraction: number,
  mergeId: string | null = lastAsked,
): CompositeProgress {
  return { mergeId, photoId: 'panorama1', photoIds: ['a', 'b', 'c'], phase, fraction };
}

// The merge answers as soon as the test lets it; what it answers is not what these are about.
const stubbed = {
  createPanorama: compositesApi.createPanorama,
  cancelMerge: compositesApi.cancelMerge,
  photoPositions: photosApi.positions,
  listLibraryPhotos: photosApi.listLibrary,
};

let cancelled: string[] = [];
/** The id the latest merge was asked under, which is what the server's events for it carry. */
let lastAsked: string | null = null;

beforeEach(() => {
  cancelled = [];
  lastAsked = null;
  compositesApi.cancelMerge = (mergeId) => {
    cancelled.push(mergeId);
    return Promise.resolve();
  };
  compositesApi.createPanorama = (_target, mergeId) => {
    lastAsked = mergeId;
    return Promise.resolve({ photoId: 'panorama1' });
  };
  photosApi.positions = () => Promise.resolve({});
  photosApi.listLibrary = () =>
    Promise.resolve({
      photos: [],
      total: 20,
      offset: 0,
      limit: 1,
      ordering: 'taken_desc',
    } as PhotoListResponse);
});

afterEach(() => {
  compositesApi.createPanorama = stubbed.createPanorama;
  compositesApi.cancelMerge = stubbed.cancelMerge;
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

/** The merge id each panorama call was asked under, and a way to answer the call at `at`. */
function heldPanoramas(): {
  asked: string[];
  answer: (at: number, outcome: Error | null) => void;
} {
  const asked: string[] = [];
  const answers: ((outcome: Error | null) => void)[] = [];
  compositesApi.createPanorama = (_target, mergeId) => {
    asked.push(mergeId);
    return new Promise((resolve, reject) => {
      answers.push((outcome) =>
        outcome == null ? resolve({ photoId: mergeId }) : reject(outcome),
      );
    });
  };
  return { asked, answer: (at, outcome) => answers[at]?.(outcome) };
}

test('Cancel on the toast cancels the merge this client asked for, once, and its answer is no error', async () => {
  const { presenter, toasts } = build();
  const held = heldPanoramas();
  const merging = presenter.mergeSelectionToPanorama();

  toasts.toasts[0]?.cancel?.();
  toasts.toasts[0]?.cancel?.();
  expect(held.asked).toHaveLength(1);
  expect(cancelled).toEqual(held.asked);
  expect(toasts.toasts[0]?.cancelling).toBe(true);
  expect(toasts.toasts[0]?.message).toBe('Cancelling merge…');
  presenter.compositeProgressed(progressed('picture', 0.5, held.asked[0]));
  expect(toasts.toasts[0]?.message).toBe('Cancelling merge…');

  held.answer(0, new ApiError('CANCELLED', 'cancelled', 409));
  await merging;
  expect(toasts.toasts).toEqual([]);
});

test('a cancel the server never heard leaves the merge offering Cancel again', async () => {
  const { presenter, toasts } = build();
  const held = heldPanoramas();
  compositesApi.cancelMerge = () => Promise.reject(new ApiError('INTERNAL_ERROR', 'down', 500));
  const merging = presenter.mergeSelectionToPanorama();
  presenter.compositeProgressed(progressed('picture', 0.5, held.asked[0]));

  toasts.toasts[0]?.cancel?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const toast = toasts.toasts.find((shown) => shown.progress != null);
  expect([toast?.cancelling, toast?.message]).toEqual([false, 'Merging… rendering the photo']);
  held.answer(0, null);
  await merging;
});

test('a finished merge answering after the next one began leaves the next one alone', async () => {
  const { presenter, toasts, store } = build();
  const held = heldPanoramas();
  const first = presenter.mergeSelectionToPanorama();
  presenter.compositeProgressed(progressed('done', 1, held.asked[0]));
  const second = presenter.mergeSelectionToPanorama();
  expect(held.asked).toHaveLength(2);

  held.answer(0, null);
  await first;

  expect(toasts.toasts).toHaveLength(1);
  expect(store.waitingOnMerge(3, 'nothing')).toBe(true);
  held.answer(1, null);
  await second;
  expect(toasts.toasts).toEqual([]);
});

test('a merge another view started can be cancelled from this one', () => {
  const { presenter, toasts } = build();
  presenter.compositeProgressed(progressed('picture', 0.5, 'theirs'));

  toasts.toasts[0]?.cancel?.();

  expect(cancelled).toEqual(['theirs']);
  expect(toasts.toasts[0]?.cancelling).toBe(true);
});

test('a merge with no id has no Cancel', () => {
  const { presenter, toasts } = build();
  presenter.compositeProgressed(progressed('picture', 0.5, null));

  expect(toasts.toasts).toHaveLength(1);
  expect(toasts.toasts[0]?.cancel).toBeUndefined();
});
