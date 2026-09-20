// The verdict the viewer's control keeps lit after the stage has stepped on.
import { expect, test } from 'bun:test';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function build(): { store: ViewerStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  return {
    store,
    presenter: new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, {} as never, absent),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

test('a verdict is held for a beat and then let go', async () => {
  const { store, presenter } = build();
  expect(store.heldVerdict).toBe(null);

  presenter.holdVerdict('picked');
  expect(store.heldVerdict).toBe('picked');

  await sleep(400);
  expect(store.heldVerdict).toBe(null);
});

// Judging twice in quick succession holds the second verdict for its own full beat,
// rather than letting the first one's timer cut it short.
test('a second verdict restarts the hold', async () => {
  const { store, presenter } = build();
  presenter.holdVerdict('picked');
  await sleep(100);
  presenter.holdVerdict('rejected');
  await sleep(100);
  expect(store.heldVerdict).toBe('rejected');

  await sleep(300);
  expect(store.heldVerdict).toBe(null);
});

// Clearing a verdict does not step on, so there is nothing to hold - and a hold left over
// from the press before would light a verdict the reader has just taken back.
test('clearing drops the hold at once', async () => {
  const { store, presenter } = build();
  presenter.holdVerdict('picked');
  presenter.holdVerdict(null);
  expect(store.heldVerdict).toBe(null);

  await sleep(300);
  expect(store.heldVerdict).toBe(null);
});
