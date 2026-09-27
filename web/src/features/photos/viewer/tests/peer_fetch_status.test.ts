import { expect, test } from 'bun:test';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function open(): { store: ViewerStore; presenter: PhotosPresenter } {
  const settings = { viewerRenditionMode: 'remember', lastViewerRendition: null } as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, settings, absent);
  return { store, presenter };
}

test('a rendition waited on from a peer reads as that wait until it settles', () => {
  const { store, presenter } = open();

  presenter.renditionFetch('p0', 'full', 'rendering');
  presenter.renditionFetch('p0', 'max', 'fetching');
  expect(store.fetchPhaseOf('p0', 'full')).toBe('rendering');
  expect(store.fetchPhaseOf('p0', 'max')).toBe('fetching');
  expect(store.fetchPhaseOf('p1', 'full')).toBeNull();

  presenter.renditionFetch('p0', 'full', null);
  expect(store.fetchPhaseOf('p0', 'full')).toBeNull();
  expect(store.fetchPhaseOf('p0', 'max')).toBe('fetching');
});

test('a server that came back is waiting on nothing it announced before', () => {
  const { store, presenter } = open();
  presenter.renditionFetch('p0', 'full', 'fetching');
  presenter.serverReachable();
  expect(store.fetchPhaseOf('p0', 'full')).toBeNull();
});
