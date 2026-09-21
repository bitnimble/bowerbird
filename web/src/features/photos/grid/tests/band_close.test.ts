// When a band closes without being asked to (§19.6). A band is pinned to its
// stack, so almost nothing closes it - but a stack the listing has stopped
// collapsing has an ordinary photograph for a row, and a band hanging off one is
// joined to nothing.
import { runInAction } from 'mobx';
import { afterEach, describe, expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import type { RequestActivity } from '../../../../../../src/schemas/request_activity';
import { photosApi } from '../../../../api/photos';
import { stacksApi } from '../../../../api/stacks';
import { PhotosPresenter } from '../../photos_presenter';
import { GRID_GAP, LIST_ROW_H } from '../grid_layout';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const ROW_H = LIST_ROW_H + GRID_GAP;
const AT = 3;

function photo(id: string, stackId: string | null = null, stackSize = 1): PhotoSummary {
  return { id, width: 3000, height: 2000, stack_id: stackId, stack_size: stackSize } as unknown as PhotoSummary;
}

const MEMBERS = [photo('m0', 's1', 3), photo('m1', 's1', 3), photo('m2', 's1', 3)];

// The row the band hangs off stands for one photograph: the rest of the stack is
// outside the filter, which is what a cull through an open band does to it.
function build(stackSize: number): {
  listing: ListingStore;
  marks: MarksStore;
  store: StacksStore;
  presenter: PhotosPresenter;
} {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const store = new StacksStore();
  const listing = new ListingStore(store);
  const marks = new MarksStore(listing, store);
  const viewer = new ViewerStore(listing, store);
  const presenter = new PhotosPresenter(listing, marks, store, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => {
    listing.mode = 'list';
    listing.source = { kind: 'library', libraryId: 'lib' };
    listing.ordering = 'taken_desc';
    listing.total = 100;
    for (let index = 0; index < 40; index++) listing.rows.set(index, photo(`p${index}`));
    listing.rows.set(AT, photo('p3', 's1', stackSize));
  });
  presenter.setViewport(1000, 6 * ROW_H);
  return { listing, marks, store, presenter };
}

const stubbed = { photoPositions: photosApi.positions, listStackPhotos: stacksApi.listPhotos };

describe('a band whose row has stopped standing for a stack', () => {
  afterEach(() => {
    photosApi.positions = stubbed.photoPositions;
    stacksApi.listPhotos = stubbed.listStackPhotos;
  });

  test('closes on the re-read that follows the cull', async () => {
    const { store, presenter } = build(1);
    photosApi.positions = () => Promise.resolve({ s1: [AT] });
    stacksApi.listPhotos = () => Promise.resolve(MEMBERS);
    runInAction(() => {
      store.expansions = new Map([['s1', { stackId: 's1', position: AT, photos: MEMBERS }]]);
    });

    await presenter.replaceBands();

    expect(store.expansions.size).toBe(0);
  });

  test('an automatic re-read keeps band requests in the background', async () => {
    const { store, presenter } = build(3);
    const activities: (RequestActivity | undefined)[] = [];
    photosApi.positions = () => Promise.resolve({ s1: [AT] });
    stacksApi.listPhotos = (_id, _options, _signal, activity?: RequestActivity) => {
      activities.push(activity);
      return Promise.resolve(MEMBERS);
    };
    runInAction(() => {
      store.expansions = new Map([['s1', { stackId: 's1', position: AT, photos: MEMBERS }]]);
    });

    await (presenter.replaceBands as (activity: RequestActivity) => Promise<void>)('background');

    expect(activities).toEqual(['background']);
  });

  test('stays open when the reader opened it from that row themselves', async () => {
    const { store, presenter } = build(1);
    photosApi.positions = () => Promise.resolve({ s1: [AT] });
    stacksApi.listPhotos = () => Promise.resolve(MEMBERS);

    await presenter.toggleBand('s1', AT);
    expect(store.expansions.size).toBe(1);

    await presenter.replaceBands();

    expect(store.expansions.size).toBe(1);
  });

  test('a band opened from a stack tile is not held open by that', async () => {
    const { listing, store, presenter } = build(3);
    photosApi.positions = () => Promise.resolve({ s1: [AT] });
    stacksApi.listPhotos = () => Promise.resolve(MEMBERS);

    await presenter.toggleBand('s1', AT);
    // The cull that leaves one member in the filter.
    runInAction(() => listing.rows.set(AT, photo('p3', 's1', 1)));

    await presenter.replaceBands();

    expect(store.expansions.size).toBe(0);
  });
});

describe('a band whose stack is stacked with more photos', () => {
  const originals = { ...stubbed, createStack: stacksApi.create, listLibraryPhotos: photosApi.listLibrary };
  afterEach(() => {
    photosApi.positions = originals.photoPositions;
    photosApi.listLibrary = originals.listLibraryPhotos;
    stacksApi.create = originals.createStack;
    stacksApi.listPhotos = originals.listStackPhotos;
  });

  const MERGED = [...MEMBERS.map((member) => photo(member.id, 's2', 4)), photo('p5', 's2', 4)];

  function stackWith(store: StacksStore, marks: MarksStore, picked: string[]): void {
    stacksApi.create = () => Promise.resolve({ id: 's2' } as never);
    photosApi.listLibrary = () =>
      Promise.resolve({
        photos: Array.from({ length: 40 }, (_, index) => (index === AT ? photo('p3', 's2', 4) : photo(`p${index}`))),
        total: 100,
        ordering: 'taken_desc',
      } as never);
    photosApi.positions = () => Promise.resolve({ s2: [AT] });
    stacksApi.listPhotos = (stackId) => Promise.resolve(stackId === 's2' ? MERGED : []);
    runInAction(() => {
      store.expansions = new Map([['s1', { stackId: 's1', position: AT, photos: MEMBERS }]]);
      marks.selection = SelectionRanges.EMPTY.add(5, 5);
      marks.selectedMembers = new Set(picked);
    });
  }

  test('stays open as the new stack when the whole stack went into it', async () => {
    const { marks, store, presenter } = build(3);
    stackWith(store, marks, []);
    runInAction(() => (marks.selection = marks.selection.add(AT, AT)));

    await presenter.stackSelection();

    expect([...store.expansions.keys()]).toEqual(['s2']);
    expect(store.expansions.get('s2')?.photos.map((member) => member.id)).toEqual(['m0', 'm1', 'm2', 'p5']);
  });

  test('stays open as the new stack when every member was picked out of it', async () => {
    const { marks, store, presenter } = build(3);
    stackWith(store, marks, ['m0', 'm1', 'm2']);

    await presenter.stackSelection();

    expect([...store.expansions.keys()]).toEqual(['s2']);
  });

  test('holds the members of every open stack that went into it', async () => {
    const { listing, marks, store, presenter } = build(3);
    stackWith(store, marks, []);
    const other = [photo('n0', 's3', 2), photo('n1', 's3', 2)];
    let reRead: string[] = [];
    photosApi.positions = () => {
      reRead = [...store.expansions.values()].flatMap((open) => open.photos.map((member) => member.id));
      return Promise.resolve({ s2: [AT] });
    };
    runInAction(() => {
      listing.rows.set(10, photo('p10', 's3', 2));
      store.expansions = new Map([...store.expansions, ['s3', { stackId: 's3', position: 10, photos: other }]]);
      marks.selection = marks.selection.add(AT, AT).add(10, 10);
    });

    await presenter.stackSelection();

    expect(reRead).toEqual(['m0', 'm1', 'm2', 'n0', 'n1']);
    expect([...store.expansions.keys()]).toEqual(['s2']);
  });

  test('is left to the re-read when only some of its members went', async () => {
    const { marks, store, presenter } = build(3);
    stackWith(store, marks, ['m0']);

    await presenter.stackSelection();

    expect(store.expansions.has('s2')).toBe(false);
  });

  test('is not carried into a collection opened while the stack was being made', async () => {
    const { marks, store, presenter } = build(3);
    stackWith(store, marks, ['m0', 'm1', 'm2']);
    stacksApi.create = () => {
      runInAction(() => (store.expansions = new Map()));
      return Promise.resolve({ id: 's2' } as never);
    };

    await presenter.stackSelection();

    expect(store.expansions.size).toBe(0);
  });
});

describe('the badge that opens the band again', () => {
  test('is drawn on a lone survivor of a stack', () => {
    const { listing } = build(1);

    expect(listing.stackBadgeId(photo('p3', 's1', 1))).toBe('s1');
  });

  test('is not drawn on a tile that stands for a stack, or on one in no stack', () => {
    const { listing } = build(3);

    expect(listing.stackBadgeId(photo('p3', 's1', 3))).toBeNull();
    expect(listing.stackBadgeId(photo('p3'))).toBeNull();
  });

  test('is not drawn in an uncollapsed listing, where every row is a stack of one', () => {
    const { listing } = build(1);
    runInAction(() => {
      listing.expandStacks = true;
    });

    expect(listing.stackBadgeId(photo('p3', 's1', 1))).toBeNull();
  });

  test('is not drawn in an album, whose band would hold only the survivor', () => {
    const { listing } = build(1);
    runInAction(() => {
      listing.source = { kind: 'album', albumId: 'a1' };
    });

    expect(listing.stackBadgeId(photo('p3', 's1', 1))).toBeNull();
  });
});
