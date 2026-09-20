// The keyboard cursor: where it goes, and when it is drawn. A click moves it too,
// so that the cull keys carry on from what was last touched - but only the
// keyboard draws it (§18.3.1).
import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function build(total: number): { store: MarksStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const store = new MarksStore(listing, stacks);
  const viewer = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, store, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => (listing.total = total));
  return { store, presenter };
}

test('an arrow key draws the cursor and a click puts it away again', () => {
  const { store, presenter } = build(20);
  expect(store.showsCursor).toBe(false);

  presenter.moveFocus(1);
  expect(store.focusIndex).toBe(0);
  expect(store.showsCursor).toBe(true);

  presenter.moveFocus(3);
  expect(store.focusIndex).toBe(3);
  expect(store.showsCursor).toBe(true);

  // Which is what selecting a tile does, and what left a ring on a photograph
  // nobody was about to act on.
  presenter.focusAt(7);
  expect(store.focusIndex).toBe(7);
  expect(store.showsCursor).toBe(false);

  presenter.moveFocus(-1);
  expect(store.focusIndex).toBe(6);
  expect(store.showsCursor).toBe(true);
});

test('the cursor stays inside the collection at either end', () => {
  const { store, presenter } = build(5);
  presenter.moveFocus(-3);
  expect(store.focusIndex).toBe(0);
  presenter.moveFocus(99);
  expect(store.focusIndex).toBe(4);
});

// Nothing to point at, so nothing moves - and in particular the cursor is not
// dragged to 0 in a collection that has no row there.
test('an empty collection takes no cursor', () => {
  const { store, presenter } = build(0);
  presenter.moveFocus(1);
  expect(store.focusIndex).toBe(-1);
  expect(store.showsCursor).toBe(false);
});

// Shift-click reaches the cursor through extendTo rather than through focusAt
// directly, which is the path a regression would take.
test('shift-clicking puts the ring away as any other click does', () => {
  const { store, presenter } = build(20);
  presenter.moveFocus(4);
  expect(store.showsCursor).toBe(true);

  presenter.extendTo(9);
  expect(store.focusIndex).toBe(9);
  expect(store.showsCursor).toBe(false);
});

// A verdict, a rating or Space does not move the cursor, so nothing would draw it
// - and a cull key firing on a tile nothing marks is a bin the reader cannot see
// the target of.
test('a key that acts on the cursor without moving it still draws it', () => {
  const { store, presenter } = build(20);
  presenter.focusAt(6);
  expect(store.showsCursor).toBe(false);

  presenter.showCursor();
  expect(store.showsCursor).toBe(true);
  expect(store.focusIndex).toBe(6);
});

// Nothing to point at yet, so there is nothing to draw either.
test('nothing draws a cursor the grid has never had', () => {
  const { store, presenter } = build(20);
  presenter.showCursor();
  expect(store.showsCursor).toBe(false);
});

test('Clear leaves the cursor where it was, and Escape takes it away', () => {
  const { store, presenter } = build(20);
  presenter.moveFocus(1); // into the grid, which lands on the first tile
  presenter.moveFocus(3);
  expect(store.focusIndex).toBe(3);
  presenter.toggle(store.focusIndex);
  expect(store.hasSelection).toBe(true);

  // The bar's Clear: the reader has unchosen, not left.
  presenter.clearSelection();
  expect(store.hasSelection).toBe(false);
  expect(store.focusIndex).toBe(3);
  expect(store.showsCursor).toBe(true);

  presenter.toggle(store.focusIndex);
  presenter.dismissSelection();
  expect(store.hasSelection).toBe(false);
  expect(store.focusIndex).toBe(3);
  expect(store.showsCursor).toBe(false);
});
