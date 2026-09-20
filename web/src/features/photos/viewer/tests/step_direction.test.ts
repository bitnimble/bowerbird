// Which way the viewer's frames slide. The direction is read off the run - the
// same ordering the arrows themselves step through - rather than off the
// collapsed listing, which has no row for a stack's members and so reported
// every step inside a stack as directionless.
import { expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

restoreApiAfterTests();

const LIB = 'lib-1';

function member(id: string, stackId: string | null): PhotoSummary {
  return {
    id,
    library_id: LIB,
    shoot_id: null,
    stack_id: stackId,
    file_path: `${id}.arw`,
    width: 3,
    height: 2,
    ordering_date: null,
    triage: 'untriaged',
    rating: 0,
    is_missing: false,
    is_deleted: false,
    tile_built_at: null,
    renditions_built_at: null,
    date_updated: null,
    viewer_rendition: null,
  } as unknown as PhotoSummary;
}

// Nothing here waits on the detail: the direction is settled before the fetch
// goes out, so the read can simply fail.
photosApi.get = (): Promise<never> => Promise.reject(new Error('not under test'));

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function build(): { listing: ListingStore; store: ViewerStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, {} as never, absent);
  return { listing, store, presenter };
}

test('stepping between two frames of one stack slides the way the reader moved', () => {
  const { listing, store, presenter } = build();
  store.neighbourhood = [member('a', 'stack-1'), member('b', 'stack-1')];
  // A collapsed listing stands the whole stack up as one row, so neither frame
  // has a position in it. This is the state an animation keyed on one gives up on.
  expect(listing.indexOf('a')).toBe(-1);
  expect(listing.indexOf('b')).toBe(-1);

  void presenter.openDetail('a');
  expect(store.stepTo('a')).toBeNull();

  void presenter.openDetail('b');
  expect(store.stepTo('b')).toBe('next');

  void presenter.openDetail('a');
  expect(store.stepTo('a')).toBe('prev');
});

// The frame is promoted well after the route changed - it has to decode first -
// so a re-open landing in between must not take the direction away from it.
test('re-opening the photo already on screen keeps the direction that got there', () => {
  const { store, presenter } = build();
  store.neighbourhood = [member('a', 'stack-1'), member('b', 'stack-1')];

  void presenter.openDetail('a');
  void presenter.openDetail('b');
  void presenter.openDetail('b');

  expect(store.stepTo('b')).toBe('next');
});

test('a photo the run does not hold is not a step', () => {
  const { store, presenter } = build();
  store.neighbourhood = [member('a', null), member('b', null)];

  void presenter.openDetail('a');
  void presenter.openDetail('elsewhere');

  expect(store.stepTo('elsewhere')).toBeNull();
});
