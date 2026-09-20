// Listing the collection uncollapsed and back again (§19.5.4). Every position in
// it changes, so the two things the reader would otherwise lose - where they were
// and what they had chosen - are re-expressed against the new listing rather than
// thrown away.
import { runInAction } from 'mobx';
import { afterEach, describe, expect, test } from 'bun:test';
import { type PhotoListResponse, type PhotoSummary } from '../../../../../../src/schemas/photos';
import { photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { GRID_GAP, LIST_ROW_H } from '../grid_layout';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const ROW_H = LIST_ROW_H + GRID_GAP;
// What the uncollapsed listing is long enough to be: the collapsed one is 100.
const EXPANDED = 140;

function photo(id: string, stackId: string | null = null, stackSize = 1): PhotoSummary {
  return { id, width: 3000, height: 2000, stack_id: stackId, stack_size: stackSize } as unknown as PhotoSummary;
}

// List mode, so one column and a fixed row height make the scroll arithmetic
// legible: a position is a row.
function build(): { store: ListingStore; marks: MarksStore; stacks: StacksStore; presenter: PhotosPresenter } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => {
    store.mode = 'list';
    store.source = { kind: 'library', libraryId: 'lib' };
    store.total = 100;
    for (let index = 0; index < 40; index++) store.rows.set(index, photo(`p${index}`));
  });
  presenter.setViewport(1000, 6 * ROW_H);
  return { store, marks, stacks, presenter };
}

const stubbed = { photoPositions: photosApi.positions, listLibraryPhotos: photosApi.listLibrary };

function serve(positions: Record<string, number[]>, total = EXPANDED): void {
  photosApi.positions = () => Promise.resolve(positions);
  photosApi.listLibrary = () =>
    Promise.resolve({ photos: [], total, offset: 0, limit: 1, ordering: 'taken_desc' } as PhotoListResponse);
}

describe('expanding every stack re-expresses the selection', () => {
  afterEach(() => {
    photosApi.positions = stubbed.photoPositions;
    photosApi.listLibrary = stubbed.listLibraryPhotos;
  });

  test('a selected stack row becomes every one of its frames', async () => {
    const { store, marks, presenter } = build();
    runInAction(() => {
      store.rows.set(3, photo('p3', 's1', 3));
      marks.selection = SelectionRanges.of(3, 3);
    });
    serve({ s1: [3, 4, 5], p0: [0] });

    await presenter.setExpandStacks(true);

    expect(store.expandStacks).toBe(true);
    expect(store.total).toBe(EXPANDED);
    expect(marks.selection.ranges).toEqual([{ start: 3, end: 5 }]);
  });

  test('a frame picked out of an open band becomes a row of the grid, and only that frame', async () => {
    const { store, marks, stacks, presenter } = build();
    runInAction(() => {
      store.rows.set(3, photo('p3', 's1', 3));
      stacks.expansions = new Map([['s1', { stackId: 's1', position: 3, photos: [photo('m0'), photo('m1'), photo('m2')] }]]);
      marks.selectedMembers = new Set(['m1']);
    });
    // The member by its own id; its stack's key would have named its siblings too.
    serve({ m1: [4], s1: [3, 4, 5], p0: [0] });

    await presenter.setExpandStacks(true);

    expect(marks.selection.ranges).toEqual([{ start: 4, end: 4 }]);
    // Nothing stands for a stack any more, so nothing is open and no member is
    // selected behind a band.
    expect(stacks.expansions.size).toBe(0);
    expect(marks.selectedMembers.size).toBe(0);
  });

  test('"everything" survives as everything, against the longer listing', async () => {
    const { marks, presenter } = build();
    runInAction(() => (marks.selection = SelectionRanges.of(0, 99)));
    expect(marks.allSelected).toBe(true);
    serve({ p0: [0] });

    await presenter.setExpandStacks(true);

    expect(marks.selection.ranges).toEqual([{ start: 0, end: EXPANDED - 1 }]);
    expect(marks.allSelected).toBe(true);
  });

  test('the reader keeps their own row, and their offset into it', async () => {
    const { store, presenter } = build();
    presenter.rail.scrollTo(20 * ROW_H + 7);
    const before = store.rail.at;
    expect(before).toBe(20 * ROW_H + 7);
    // The row they were on is the 30th of the uncollapsed listing.
    serve({ p20: [30] });

    await presenter.setExpandStacks(true);

    expect(store.rail.at).toBeCloseTo(30 * ROW_H + 7, 6);
  });

  // Coming back the other way, a frame is named by the stack it belongs to,
  // because that is the only row the collapsed listing has for it.
  test('collapsing again puts the frames back on the row that stands for them', async () => {
    const { store, marks, presenter } = build();
    runInAction(() => {
      store.expandStacks = true;
      store.rows.set(4, photo('m0', 's1'));
      store.rows.set(5, photo('m1', 's1'));
      marks.selection = SelectionRanges.of(4, 5);
    });
    serve({ s1: [3] }, 100);

    await presenter.setExpandStacks(false);

    expect(store.expandStacks).toBe(false);
    expect(marks.selection.ranges).toEqual([{ start: 3, end: 3 }]);
  });

  // The switch leaves the rows cleared for a round trip, and a sync poll ticks
  // once a second through an import. A re-read with nothing to compare against
  // observed no photograph at all, so it must not report the selection as gone.
  test('a refresh landing in the gap after the switch does not wipe the carried selection', async () => {
    const { store, marks, presenter } = build();
    runInAction(() => {
      store.rows.set(3, photo('p3', 's1', 3));
      marks.selection = SelectionRanges.of(3, 3);
    });
    serve({ s1: [3, 4, 5], p0: [0] });

    await presenter.setExpandStacks(true);
    expect(marks.selection.ranges).toEqual([{ start: 3, end: 5 }]);

    await presenter.reload();

    expect(marks.selection.ranges).toEqual([{ start: 3, end: 5 }]);
  });

  // Nothing is set until both reads are in hand, so a failure is the press lost
  // and no more - never a grid listing one collection and asking for another.
  test('a lookup that fails leaves the view listing what it is showing', async () => {
    const { store, presenter } = build();
    photosApi.positions = () => Promise.reject(new Error('nope'));
    photosApi.listLibrary = () =>
      Promise.resolve({ photos: [], total: EXPANDED, offset: 0, limit: 1, ordering: 'taken_desc' } as PhotoListResponse);

    await presenter.setExpandStacks(true);

    expect(store.expandStacks).toBe(false);
    expect(store.total).toBe(100);
  });
});
