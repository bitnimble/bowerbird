// What a masonry block is, once its lines rather than the paging boundary decide
// where it ends: a block runs on to the end of the line the boundary falls in, and
// the next one begins where it stopped. Without that the seam between two blocks
// cuts a line in half and the leftovers are drawn alone on a row of their own.
import { runInAction } from 'mobx';
import { describe, expect, test } from 'bun:test';
import { PhotosPresenter } from '../../photos_presenter';
import { BLOCK } from '../grid_layout';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

function build(total: number): { store: ListingStore; presenter: PhotosPresenter } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => {
    store.mode = 'masonry';
    store.total = total;
  });
  presenter.setViewport(1000, 800);
  return { store, presenter };
}

describe('a masonry block starts where the one before it packed to', () => {
  test('the paging boundary, until the block before has said otherwise', () => {
    const { store } = build(10 * BLOCK);
    expect(store.startOf(0)).toBe(0);
    expect(store.startOf(3)).toBe(3 * BLOCK);
  });

  test('a reported end is the next block’s start, and its own block’s end', () => {
    const { store, presenter } = build(10 * BLOCK);
    presenter.packedBlock(3, 3 * BLOCK + 104);
    expect(store.startOf(4)).toBe(3 * BLOCK + 104);
  });

  test('past the end of the collection, a start is the end of the collection', () => {
    const { store, presenter } = build(BLOCK + 5);
    presenter.packedBlock(0, BLOCK + 2);
    expect(store.startOf(1)).toBe(BLOCK + 2);
    expect(store.startOf(2)).toBe(BLOCK + 5);
  });

  test('what is fetched covers the photos a block ran on to collect', () => {
    const { store, presenter } = build(10 * BLOCK);
    presenter.packedBlock(0, BLOCK + 4);
    presenter.rail.setTop(0);
    // What `visible` covers has to follow the starts, or the photographs a block
    // ran on to collect are never fetched - they sit past the paging boundary a
    // span that ignores the starts stops at.
    expect(store.visible.from).toBe(0);
    expect(store.visible.to).toBeGreaterThanOrEqual(BLOCK + 4);
  });

  test('which block draws a position follows the drift', () => {
    const { store, presenter } = build(10 * BLOCK);
    presenter.packedBlock(0, BLOCK + 4);
    presenter.packedBlock(1, 2 * BLOCK + 2);
    expect(store.blockOf(BLOCK + 3)).toBe(0);
    expect(store.blockOf(BLOCK + 4)).toBe(1);
    expect(store.blockOf(2 * BLOCK + 1)).toBe(1);
    expect(store.blockOf(2 * BLOCK + 2)).toBe(2);
  });

  test('a layout the starts no longer describe is forgotten, not carried over', () => {
    const { store, presenter } = build(10 * BLOCK);
    presenter.packedBlock(0, BLOCK + 4);
    presenter.setViewport(1400, 800);
    expect(store.startOf(1)).toBe(BLOCK);
  });
});
