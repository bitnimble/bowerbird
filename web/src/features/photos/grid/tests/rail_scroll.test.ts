// The scroller as a rail over the collection rather than a picture of it: what
// `anchorTop + railTop` has to mean, and the two things that go wrong if it stops
// meaning that - a tail nobody can scroll to, and a grid that re-renders on every
// frame of a scroll instead of on every row of one.
import { autorun, runInAction } from 'mobx';
import { afterEach, describe, expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { photosApi } from '../../../../api/photos';
import { stacksApi } from '../../../../api/stacks';
import { PhotosPresenter } from '../../photos_presenter';
import { BLOCK, GRID_GAP, LIST_ROW_H, RAIL_HEIGHT } from '../grid_layout';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const ROW_H = LIST_ROW_H + GRID_GAP;
// A whole number of rows, so both edges of the viewport sit at the same offset
// within their row: a viewport ending mid-row crosses a boundary at the bottom on
// a different frame from the top, and there is then no scroll distance at all
// over which the rows on screen are unchanged.
const V = 6 * ROW_H;
// Enough rows that the collection is far taller than the rail, which is the case
// every one of these numbers exists for.
const LONG = 200_000;
// A rail position aligned to a row, plus one pixel - so 64px of scrolling can
// follow without either edge of the viewport leaving the row it is in.
const ALIGNED_ANCHOR = 76_000 * ROW_H;
const ALIGNED_RAIL = 150 * ROW_H + 1;

function photo(id: string): PhotoSummary {
  return { id, width: 3000, height: 2000, stack_id: null, stack_size: 1 } as unknown as PhotoSummary;
}

// `source` is left null deliberately: it is the guard `ensureBlocks` returns on,
// so the presenter's block reaction never reaches the network and none of this
// needs a scripted list endpoint.
function build(total: number, viewportHeight = V): { store: ListingStore; stacks: StacksStore; presenter: PhotosPresenter } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => {
    store.mode = 'list'; // one column, a fixed row height, so the arithmetic is legible
    store.total = total;
  });
  presenter.setViewport(1000, viewportHeight);
  return { store, stacks, presenter };
}

// A masonry store, for the block-measurement path: `mode` is the only difference
// that matters, but the block heights and the estimate they average to are what
// the arithmetic is over.
function masonry(total: number): { store: ListingStore; stacks: StacksStore; presenter: PhotosPresenter } {
  const built = build(total);
  runInAction(() => (built.store.mode = 'masonry'));
  return built;
}

// What a masonry measurement has to preserve. `virtualTop` itself moves - one
// measurement moves the estimate every unmeasured block above the reader is sized
// by - so the invariant is the offset into the block they are looking at.
function offsetIntoBlock(store: ListingStore): number {
  return store.rail.at - (store.blockTops[store.visibleBlocks.from] ?? 0);
}

describe('the rail composes with the anchor', () => {
  test('the scroller is a rail, not the collection', () => {
    const { store } = build(LONG);
    expect(store.contentHeight).toBeGreaterThan(10_000_000);
    // The one number a browser would have to cope with. Nothing in the DOM is
    // millions of pixels tall, so there is no ceiling to scale into.
    expect(store.rail.length).toBe(RAIL_HEIGHT);
  });

  test('where the reader is, is the anchor plus the rail', () => {
    const { store, presenter } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    presenter.rail.setTop(40_000);
    expect(store.rail.at).toBe(5_040_000);
    expect(store.visibleSpan.from).toBe(Math.floor(5_040_000 / ROW_H) - 2);
  });

  test('the last screenful of the collection is reachable', () => {
    // The failure the old scaling existed to avoid and the rail has to keep
    // avoiding: everything past a browser's clamp being silently unreachable.
    const { store, presenter } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = Number.MAX_SAFE_INTEGER)); // as far down as anything can ask for
    presenter.rail.setTop(store.rail.length - V);
    expect(store.rail.at).toBeCloseTo(store.contentHeight - V, 6);
  });

  test('an anchor left past the end of a collection that shrank is clamped', () => {
    const { store } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    runInAction(() => (store.total = 100)); // a filter that emptied most of the library
    expect(store.rail.anchor).toBe(0);
  });

  test('and does not spring back when the collection returns', () => {
    const { store } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    runInAction(() => (store.total = 100)); // binned
    runInAction(() => (store.total = LONG)); // and undone
    expect(store.rail.anchor).toBe(0);
  });
});

describe('a collection the rail covers whole is a plain native scroll', () => {
  const SHORT = 200; // 200 rows of 65px, well inside the rail

  test('the rail is the content and the anchor never moves', () => {
    const { store } = build(SHORT);
    expect(store.rail.length).toBe(store.contentHeight);
    expect(store.rail.limit).toBe(0);
  });

  test('nothing is ever recentred under the reader', () => {
    const { store, presenter } = build(SHORT);
    // Right at the top and right at the bottom, where a rail with walls would move
    // itself and take the collection's own ends out of reach. Left exactly where
    // the scroller put it, so the view has nothing to follow and no fling is cut.
    presenter.rail.setTop(0);
    expect(store.rail.top).toBe(0);
    presenter.rail.setTop(store.contentHeight - V);
    expect(store.rail.top).toBe(store.contentHeight - V);
    expect(store.rail.anchor).toBe(0);
  });
});

describe('recentring the rail', () => {
  test('is not done for the frames in the middle of it', () => {
    const { store, presenter } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    expect(store.rail.top).toBe(RAIL_HEIGHT / 2);
    expect(store.rail.anchor).toBe(5_000_000);
  });

  test('holds the view still when it does happen', () => {
    const { store, presenter } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const before = store.rail.at;

    // Into the top margin, which is the one thing that moves the scroller while the
    // reader may still be flinging.
    presenter.rail.setTop(100);

    // The rail was moved back to its middle and the reader did not move with it. If
    // these ever disagree the grid jumps by however far the rail went.
    expect(store.rail.at).toBeCloseTo(before + 100 - RAIL_HEIGHT / 2, 6);
    expect(store.rail.top).toBeGreaterThan(RAIL_HEIGHT / 4);
  });
});

describe('a scroll re-renders per row crossed, not per frame', () => {
  // What `visibleSpan` being a struct computed buys. Note the ceiling: the span's
  // two edges cross their row boundaries at different offsets unless the viewport
  // is an exact multiple of the row pitch, so the honest figure is *two*
  // invalidations per row at a real window height, not one - and at fling speed,
  // where a frame covers more than a row, it degrades to one per frame.
  function countSectionRuns(store: ListingStore, scroll: (to: number) => void, tops: number[]): number {
    let runs = 0;
    const stop = autorun(() => {
      void store.sections;
      runs++;
    });
    runs = 0;
    for (const top of tops) scroll(top);
    stop();
    return runs;
  }

  function scrolled(total: number, viewportHeight: number, from: number, step: number, frames: number): number {
    const { store, presenter } = build(total, viewportHeight);
    runInAction(() => (store.rail.rawAnchor = ALIGNED_ANCHOR));
    presenter.rail.setTop(from);
    // From one step in, so every entry is a frame that actually moved.
    const tops = Array.from({ length: frames }, (_, i) => from + (i + 1) * step);
    return countSectionRuns(store, (to) => presenter.rail.setTop(to), tops);
  }

  test('a viewport that is a whole number of rows crosses one boundary per row', () => {
    // Both edges of the span move together, which is the best case.
    expect(scrolled(LONG, 6 * ROW_H, ALIGNED_RAIL, ROW_H / 4, 60)).toBe(15);
  });

  test('a real viewport height crosses two per row, and no more', () => {
    // 823px is a 1512x982 window's grid. Fifteen rows of travel, so the ceiling is
    // thirty - the property is "bounded by the rows crossed", not "one per row".
    const runs = scrolled(LONG, 823, ALIGNED_RAIL, ROW_H / 4, 60);
    expect(runs).toBeGreaterThan(15);
    expect(runs).toBeLessThanOrEqual(30);
  });

  test('a slow scroll inside one row invalidates nothing at all', () => {
    // Sixty frames covering less than a row, from one pixel into it: no boundary is
    // reached by either edge, so a whole second of scrolling costs no render.
    expect(scrolled(LONG, 6 * ROW_H, ALIGNED_RAIL, (ROW_H - 2) / 60, 60)).toBe(0);
  });

  test('a fling degrades to one invalidation per frame', () => {
    // 200px a frame is inside what a trackpad fling reaches, and it crosses three
    // rows per frame - so every frame renders and the struct comparison buys
    // nothing. This is the honest ceiling on the optimisation.
    expect(scrolled(LONG, 823, ALIGNED_RAIL, 200, 60)).toBe(60);
  });

  test('the anchor is what the sections are placed against, so it holds too', () => {
    const { store, presenter } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = ALIGNED_ANCHOR));
    presenter.rail.setTop(ALIGNED_RAIL);
    const section = store.sections[0]!;
    const placed = store.rail.positionOf(section.top);

    presenter.rail.setTop(ALIGNED_RAIL + ROW_H / 3);
    // Same element, same transform: the native scroll moved it, not React.
    expect(store.sections[0]!.top).toBe(section.top);
    expect(store.rail.positionOf(section.top)).toBe(placed);
    // And it is genuinely placed against the anchor, not at its content pixel: the
    // rail is a hundred thousand pixels and this section is five million in, so
    // dropping the anchor would put every window outside the scroller entirely.
    expect(placed).toBeGreaterThanOrEqual(0);
    expect(placed).toBeLessThanOrEqual(store.rail.length);
    expect(section.top).toBeGreaterThan(store.rail.length);
  });

  test('a recentring moves what the sections are placed against, by exactly its own shift', () => {
    const { store, presenter } = build(LONG);
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const section = store.sections[0]!;
    const before = store.rail.positionOf(section.top);
    const anchorBefore = store.rail.anchor;

    presenter.rail.setTop(100); // into the wall, so the rail is put back to its middle

    // The section keeps its place on screen: it moved down the rail by exactly what
    // the anchor moved up the collection.
    expect(store.rail.positionOf(section.top) - before).toBeCloseTo(anchorBefore - store.rail.anchor, 6);
  });
});

describe('what displaced the reader goes to the anchor, not the rail', () => {
  test('closing a band above the viewport leaves the rail where it was', async () => {
    const { store, stacks, presenter } = build(LONG);
    const members = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
    runInAction(() => (stacks.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]])));
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const anchor = store.rail.anchor;
    const rail = store.rail.top;

    await presenter.toggleBand('s1', 0);

    // Ten member rows went from above the reader, so the anchor came up by exactly
    // their height. The rail did not move, which is what stops a fling being
    // cancelled: the view only follows `railTop`, and it is unchanged.
    expect(store.rail.anchor).toBe(anchor - 10 * ROW_H);
    expect(store.rail.top).toBe(rail);
  });

  test('a collection with no anchor travel moves the rail instead', async () => {
    const { store, stacks, presenter } = build(200);
    const members = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
    runInAction(() => (stacks.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]])));
    presenter.rail.setTop(30 * ROW_H);

    // No room for the anchor to absorb anything, so the whole shift lands on the
    // rail and the view follows it there.
    await presenter.toggleBand('s1', 0);
    expect(store.rail.anchor).toBe(0);
    expect(store.rail.top).toBe(20 * ROW_H);
  });

  test('a band opening below the reader displaces nothing, so nothing is corrected', async () => {
    const { store, stacks, presenter } = build(LONG);
    const members = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
    runInAction(() => (store.rail.rawAnchor = 5_000_000));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const before = store.rail.at;

    // A stack far below the fold: everything it inserts is below everything the
    // reader can see, so correcting for it would jerk the view by a band's height.
    const below = Math.floor((store.rail.at + store.viewportHeight * 4) / ROW_H) * store.columns;
    runInAction(() => (stacks.expansions = new Map([['s1', { stackId: 's1', position: below, photos: members }]])));
    await presenter.toggleBand('s1', below);

    expect(store.rail.at).toBe(before);
  });
});

describe('a jump is clamped to a position the collection actually has', () => {
  test('masonry asks to scroll past the end, and is not taken there', () => {
    // `focusContentTop` answers with a block top, and the last block holds whatever
    // is left over - so for a short final block the cursor's own block starts past
    // the furthest the collection can be scrolled.
    const { store, presenter } = masonry(100_007);
    const last = store.blockCount - 1;
    runInAction(() => store.blockHeights.set(last, 40));
    const travel = store.contentHeight - store.viewportHeight;

    presenter.rail.scrollTo(store.blockTops[last] ?? 0);

    expect(store.blockTops[last]!).toBeGreaterThan(travel);
    expect(store.rail.at).toBeCloseTo(travel, 6);
  });

  test('and never above the top of it', () => {
    const { store, presenter } = build(LONG);
    presenter.rail.scrollTo(-5000);
    expect(store.rail.at).toBe(0);
  });
});

// The last block holds whatever is left over, so its height describes a part-block.
// Averaged in as a full one it drags every unmeasured block with it, and which block
// is last moves in both directions.
describe('a part-block height never sizes the blocks around it', () => {
  const real = photosApi.listLibrary;
  afterEach(() => (photosApi.listLibrary = real));

  test('the block that is last is left out of the estimate', () => {
    const { store } = masonry(930); // ten blocks, the last holding thirty photos
    const full = store.estimatedBlockHeight;
    runInAction(() => store.blockHeights.set(store.blockCount - 1, full / 3));
    expect(store.estimatedBlockHeight).toBe(full);
  });

  test('a height recorded past the end of a collection that shrank is too', () => {
    const { store } = masonry(2430);
    const full = store.estimatedBlockHeight;
    runInAction(() => store.blockHeights.set(20, full / 3));
    runInAction(() => (store.total = 930)); // a filter, leaving block 20 beyond the end
    expect(store.estimatedBlockHeight).toBe(full);
  });

  test('and one the collection has since grown past is dropped, not promoted', async () => {
    const { store, presenter } = masonry(930);
    const full = store.estimatedBlockHeight;
    // Every block measured, the last one a third as tall because it is a part-block.
    const partBlock = store.blockCount - 1;
    runInAction(() => {
      for (let block = 0; block < partBlock; block++) store.blockHeights.set(block, full);
      store.blockHeights.set(partBlock, full / 3);
    });
    expect(store.estimatedBlockHeight).toBeCloseTo(full, 6);

    // An import moves the end past it, through the read that reports the new count.
    photosApi.listLibrary = () =>
      Promise.resolve({ photos: [], total: 2430, offset: 0, limit: BLOCK, ordering: 'taken_asc' } as never);
    runInAction(() => (store.source = { kind: 'library', libraryId: 'lib' }));
    await presenter.reload();

    expect(store.total).toBe(2430);
    // Kept, that part-block would now be averaged in as a full one and drag every
    // unmeasured block above it down with it.
    expect(store.blockHeights.has(partBlock)).toBe(false);
    expect(store.estimatedBlockHeight).toBeCloseTo(full, 6);
  });
});

// Masonry opens a stack's band as a full-width item inside the block's own flex
// line rather than on the row model, so `bandShift` deliberately does nothing there
// and the block's re-measurement is the whole correction (§19.6).
describe('a masonry band is corrected by measurement, not by row arithmetic', () => {
  test('a band growing the block above the reader keeps their offset into their own', () => {
    const { store, presenter } = masonry(100_000);
    runInAction(() => (store.rail.rawAnchor = 2_000_000));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const first = store.visibleBlocks.from;
    const before = offsetIntoBlock(store);

    presenter.measuredBlock(
      first - 1,
      (store.blockHeights.get(first - 1) ?? store.estimatedBlockHeight) + 900,
      store.viewportWidth,
    );

    expect(store.visibleBlocks.from).toBe(first);
    expect(offsetIntoBlock(store)).toBeCloseTo(before, 0);
  });

  test('opening the band moves nothing until the block reports its new height', () => {
    const { store, stacks, presenter } = masonry(100_000);
    runInAction(() => (store.rail.rawAnchor = 2_000_000));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const first = store.visibleBlocks.from;
    const before = offsetIntoBlock(store);

    runInAction(() => {
      stacks.expansions = new Map([['s1', { stackId: 's1', position: first * BLOCK + 5, photos: [photo('m0'), photo('m1')] }]]);
    });
    expect(offsetIntoBlock(store)).toBeCloseTo(before, 6);

    presenter.measuredBlock(first, (store.blockHeights.get(first) ?? store.estimatedBlockHeight) + 500, store.viewportWidth);
    expect(store.visibleBlocks.from).toBe(first);
    expect(offsetIntoBlock(store)).toBeCloseTo(before, 0);
  });

  test('a collection that collapses under the reader cannot leave them past its end', () => {
    const { store, presenter } = masonry(100_000);
    runInAction(() => (store.rail.rawAnchor = store.rail.limit));
    presenter.rail.setTop(RAIL_HEIGHT / 2);

    // Every block measuring a fraction of its estimate, which is the worst the
    // average can do to the collection's height in one pass.
    for (const block of [0, 1, 2, store.blockCount - 1, store.visibleBlocks.from]) {
      presenter.measuredBlock(block, 60, store.viewportWidth);
      expect(store.rail.at).toBeGreaterThanOrEqual(0);
      expect(store.rail.at).toBeLessThanOrEqual(Math.max(0, store.contentHeight - store.viewportHeight) + 1);
    }
  });

  test('a resize reported by the blocks before the scroller keeps what it just measured', () => {
    const { store, presenter } = masonry(100_000);
    presenter.measuredBlock(0, 900, 1000);
    presenter.measuredBlock(1, 900, 1000);

    // The order a resize arrives in: both boxes are in one observer batch, and the
    // blocks are ahead of the scroller in it.
    presenter.measuredBlock(0, 700, 600);
    presenter.setViewport(600, V);

    expect(store.blockHeights.get(0)).toBe(700);
    // And what nothing re-measured is gone, being a height at the old width.
    expect(store.blockHeights.has(1)).toBe(false);
  });
});

describe('a re-read that re-places every band holds the reader on their row', () => {
  // `replaceBands` closes bands whose stack has left the collection and re-places
  // the rest, and it runs on every refresh - a bin, a restore, a verdict under a
  // filter, a sync poll.
  const stubbed = {
    photoPositions: photosApi.positions,
    listStackPhotos: stacksApi.listPhotos,
    listLibraryPhotos: photosApi.listLibrary,
  };
  afterEach(() => {
    photosApi.positions = stubbed.photoPositions;
    photosApi.listLibrary = stubbed.listLibraryPhotos;
    stacksApi.listPhotos = stubbed.listStackPhotos;
  });

  test('a band leaving the collection above the reader keeps their row under them', async () => {
    const { store, stacks, presenter } = build(LONG);
    const members = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
    // The stack is gone from the collection, which is what closes a band.
    photosApi.positions = () => Promise.resolve({});
    stacksApi.listPhotos = () => Promise.resolve([]);
    photosApi.listLibrary = () =>
      Promise.resolve({ photos: [], total: LONG, offset: 0, limit: 100, ordering: 'taken_asc' } as never);

    runInAction(() => {
      store.source = { kind: 'library', libraryId: 'lib' };
      // A band cannot be open before the first page has stated the collection's
      // sort, which is what a band's members are listed in.
      store.ordering = 'taken_asc';
      stacks.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]]);
      store.rail.rawAnchor = 5_000_000;
    });
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const rowBefore = store.sections.find((section) => section.kind === 'grid')?.from;

    await presenter.replaceBands();

    expect(stacks.expansions.size).toBe(0);
    // The same photographs are at the top of the viewport: uncorrected, the reader's
    // cursor row would hold a different photograph.
    expect(store.sections.find((section) => section.kind === 'grid')?.from).toBe(rowBefore);
  });
});

// Both of these displace the reader *and* shrink the collection in one action, so
// the anchor they are shifted from has to be the one from before the shrink.
// Measured against the anchor afterwards, the clamp a smaller `anchorLimit` has
// already applied gets counted a second time and the reader is thrown.
describe('a correction that also shrinks the collection is not double-counted', () => {
  test('closing a band with the anchor at its limit moves the view by the band, no more', async () => {
    const { store, stacks, presenter } = build(LONG);
    const members = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
    runInAction(() => (stacks.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]])));
    // Pinned at the limit, so closing the band lowers the limit under the anchor.
    runInAction(() => (store.rail.rawAnchor = store.rail.limit));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const before = store.rail.at;

    await presenter.toggleBand('s1', 0);

    // Ten rows left from above the reader, so they are ten rows earlier in the
    // collection - not twenty.
    expect(store.rail.at).toBeCloseTo(before - 10 * ROW_H, 6);
  });

  test('a masonry block measuring shorter than its estimate does not throw the reader to the top', async () => {
    const { store, presenter } = masonry(100_000);
    const estimate = store.estimatedBlockHeight;
    // Deep in the collection, and pinned at the limit so the shrink clamps it.
    runInAction(() => (store.rail.rawAnchor = store.rail.limit));
    presenter.rail.setTop(RAIL_HEIGHT / 2);
    const before = store.rail.at;
    const first = store.visibleBlocks.from;
    const topOfFirst = store.blockTops[first] ?? 0;

    // A third of the estimate. One measurement moves the average, so every
    // unmeasured block above the reader shrinks with it - a far larger move than
    // this one block's own difference.
    presenter.measuredBlock(first, estimate / 3, store.viewportWidth);

    // The reader keeps their offset into the block they were looking at. The anchor
    // is out of travel here - the collection lost two thirds of its height - so the
    // rest of the move lands on the rail.
    const moved = (store.blockTops[first] ?? 0) - topOfFirst;
    expect(store.rail.at).toBeCloseTo(before + moved, 6);
    expect(store.rail.at).toBeGreaterThan(store.contentHeight / 2);
  });
});
