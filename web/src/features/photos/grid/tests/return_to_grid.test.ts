// Leaving the viewer and landing back where you were: the collection is not
// re-opened from scratch, the cursor is left on the photo that was on screen, and
// the way out points at the grid the photo was opened from.
import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { PathSegment, route } from '../../../../../../src/schemas/route';
import { type PhotoListResponse, type PhotoSummary } from '../../../../../../src/schemas/photos';
import { type PhotoListParams, photosApi } from '../../../../api/photos';
import { renditionsApi } from '../../../../api/renditions';
import { shootsApi } from '../../../../api/shoots';
import { PhotosPresenter } from '../../photos_presenter';
import { photoPath, sourceOfPath, triagePath, type PhotoSource } from '../../photos_store';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

restoreApiAfterTests();

const LIB = 'lib-1';

let collection: string[] = [];

function row(id: string): PhotoSummary {
  return {
    id,
    library_id: LIB,
    shoot_id: null,
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

photosApi.listLibrary = (_libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> => {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  return Promise.resolve({
    photos: collection.slice(offset, offset + limit).map(row),
    total: collection.length,
    offset,
    limit,
    ordering: 'taken_asc',
  } as PhotoListResponse);
};

// openDetail builds the opening rendition; another test file's module-level patch
// of this seam would otherwise leak in here with a promise that never resolves.
renditionsApi.build = () => Promise.resolve();

const absent = new Proxy({}, { get: () => () => undefined }) as never;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function build(): { store: ListingStore; marks: MarksStore; viewer: ViewerStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  return { store, marks, viewer, presenter };
}

async function openAt(count: number): Promise<{
  store: ListingStore;
  marks: MarksStore;
  viewer: ViewerStore;
  presenter: PhotosPresenter;
}> {
  collection = Array.from({ length: count }, (_, i) => `p${i}`);
  const built = build();
  built.presenter.setViewport(1000, 400);
  await built.presenter.open({ kind: 'library', libraryId: LIB });
  await tick();
  return built;
}

test('re-opening the collection the reader never left keeps their place in it', async () => {
  const { store, presenter } = await openAt(600);
  presenter.rail.scrollTo(4000);
  await tick();
  const was = store.rail.at;
  expect(was).toBeGreaterThan(0);

  // What stepping back out of the viewer runs: the grid page mounts and opens
  // the same collection again.
  await presenter.open({ kind: 'library', libraryId: LIB });
  await tick();

  expect(store.rail.at).toBe(was);
  expect(store.rows.size).toBeGreaterThan(0);
});

// What a reload has to work from: the address bar carries a position, and the
// page that comes back turns it into pixels of a layout it has not laid out yet.
test('a position taken off the top of the viewport puts the reader back within a row of it', async () => {
  const { store, presenter } = await openAt(600);
  for (const mode of ['masonry', 'grid'] as const) {
    runInAction(() => (store.mode = mode));
    presenter.rail.scrollTo(4000);
    await tick();
    const at = store.topPosition;
    expect(at).toBeGreaterThan(0);

    presenter.rail.scrollTo(0);
    presenter.scrollToPosition(at);
    expect(Math.abs(store.rail.at - 4000)).toBeLessThan(store.rowHeight);
  }
});

test('a position from a collection that has since shrunk lands inside the one there is', async () => {
  const { store, presenter } = await openAt(20);
  presenter.scrollToPosition(5000);
  expect(store.rail.at).toBeGreaterThanOrEqual(0);
  expect(store.rail.at).toBeLessThanOrEqual(store.contentHeight);
});

test('opening a different collection starts at the top of it', async () => {
  const { store, presenter } = await openAt(600);
  presenter.rail.scrollTo(4000);
  await tick();

  await presenter.open({ kind: 'library', libraryId: 'lib-2' });
  await tick();

  expect(store.rail.at).toBe(0);
});

test('leaving the viewer puts the cursor on the photo it was showing', async () => {
  const { store, marks, viewer, presenter } = await openAt(300);
  runInAction(() => {
    // Row arithmetic, so grid: masonry only goes as far as the block, and p42's
    // block is the one already on screen.
    store.mode = 'grid';
    viewer.open = { id: 'p42', status: 'ready' };
  });

  presenter.focusOpenPhoto();

  expect(marks.focusIndex).toBe(42);
  // Which is what the grid scrolls to: the tile is well past a 400px viewport.
  expect(marks.focusContentTop).toBeGreaterThan(0);
});

test('a photo this client holds no row for leaves the view where it was', async () => {
  const { marks, viewer, presenter } = await openAt(300);
  runInAction(() => {
    marks.focusIndex = 7;
    viewer.open = { id: 'not-in-this-collection', status: 'ready' };
  });

  presenter.focusOpenPhoto();

  expect(marks.focusIndex).toBe(7);
});

test('the way out of the viewer is the collection the photo was opened from', () => {
  const { store, viewer } = build();

  store.source = { kind: 'shoot', shootId: 's1' };
  expect(viewer.openedFrom).toEqual({ path: route(PathSegment.shoots(), 's1'), label: 'Shoot' });

  store.source = { kind: 'album', albumId: 'a1' };
  expect(viewer.openedFrom).toEqual({ path: route(PathSegment.albums(), 'a1'), label: 'Album' });

  store.source = { kind: 'bin', libraryId: LIB };
  expect(viewer.openedFrom).toEqual({ path: route(PathSegment.libraries(), LIB, PathSegment.bin()), label: 'Bin' });

  store.source = { kind: 'no_shoot', libraryId: LIB };
  expect(viewer.openedFrom).toEqual({
    path: route(PathSegment.libraries(), LIB, PathSegment.noShoot()),
    label: 'Not in any shoot',
  });

  store.source = { kind: 'library', libraryId: LIB };
  expect(viewer.openedFrom).toEqual({ path: route(PathSegment.libraries(), LIB), label: 'Library' });
});

test('the viewer and triage URLs a grid produces name the collection they were opened from', () => {
  const sources: PhotoSource[] = [
    { kind: 'library', libraryId: LIB },
    { kind: 'shoot', shootId: 's1' },
    { kind: 'album', albumId: 'a1' },
    { kind: 'bin', libraryId: LIB },
    { kind: 'no_shoot', libraryId: LIB },
  ];

  for (const source of sources) {
    expect(sourceOfPath(photoPath('p1', source))).toEqual(source);
    expect(sourceOfPath(triagePath('stack-1', source))).toEqual(source);
  }

  // The missing view has no grid of its own, so it is read back as the library's.
  expect(sourceOfPath(photoPath('p1', { kind: 'missing', libraryId: LIB }))).toEqual({ kind: 'library', libraryId: LIB });

  expect(photoPath('p1', null)).toBe(route(PathSegment.photos(), 'p1'));
  expect(triagePath('stack-1', null)).toBe(route(PathSegment.stacks(), 'stack-1', PathSegment.triage()));
  expect(sourceOfPath(route(PathSegment.photos(), 'p1'))).toBeNull();
  expect(sourceOfPath(route(PathSegment.stacks(), 'stack-1', PathSegment.triage()))).toBeNull();
});

test('a reload inside the viewer returns to the collection the URL names, not the library', async () => {
  collection = ['p0', 'p1'];
  photosApi.get = (id: string) => Promise.resolve({ ...row(id), shoot_id: 's1' } as never);
  shootsApi.listPhotos = photosApi.listLibrary as never;

  const { store, viewer, presenter } = build();
  presenter.setViewport(1000, 400);
  // No collection loaded, which is what landing straight on the URL leaves.
  await presenter.openDetail('p1', sourceOfPath(route(PathSegment.shoots(), 's1', PathSegment.photos(), 'p1')));
  await tick();

  expect(store.source).toEqual({ kind: 'shoot', shootId: 's1' });
  expect(viewer.openedFrom).toEqual({ path: route(PathSegment.shoots(), 's1'), label: 'Shoot' });

  // Stepping on is the same call with the same collection, which must not
  // re-open it: that resets the rows and the scroll on every frame.
  const held = store.source;
  await presenter.openDetail('p0', sourceOfPath(route(PathSegment.shoots(), 's1', PathSegment.photos(), 'p0')));
  await tick();
  expect(store.source).toBe(held);
});
