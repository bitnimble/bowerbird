// Leaving the viewer and landing back where you were: the collection is not
// re-opened from scratch, the cursor is left on the photo that was on screen, and
// the way out points at the grid the photo was opened from.
import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { api, type PhotoListParams, type PhotoListResponse, type PhotoSummary } from '../../../api/client';
import { PhotosPresenter } from '../photos_presenter';
import { PhotosStore } from '../photos_store';

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

api.listLibraryPhotos = (_libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> => {
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

const absent = new Proxy({}, { get: () => () => undefined }) as never;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function build(): { store: PhotosStore; presenter: PhotosPresenter } {
  const store = new PhotosStore({ viewerRenditionMode: 'library' } as never, { byId: new Map() } as never);
  const presenter = new PhotosPresenter(store, absent, absent, absent, absent, {} as never, absent);
  return { store, presenter };
}

async function openAt(count: number): Promise<{ store: PhotosStore; presenter: PhotosPresenter }> {
  collection = Array.from({ length: count }, (_, i) => `p${i}`);
  const built = build();
  built.presenter.setViewport(1000, 400);
  await built.presenter.open({ kind: 'library', libraryId: LIB });
  await tick();
  return built;
}

test('re-opening the collection the reader never left keeps their place in it', async () => {
  const { store, presenter } = await openAt(600);
  presenter.scrollTo(4000);
  await tick();
  const was = store.virtualTop;
  expect(was).toBeGreaterThan(0);

  // What stepping back out of the viewer runs: the grid page mounts and opens
  // the same collection again.
  await presenter.open({ kind: 'library', libraryId: LIB });
  await tick();

  expect(store.virtualTop).toBe(was);
  expect(store.rows.size).toBeGreaterThan(0);
});

test('opening a different collection starts at the top of it', async () => {
  const { store, presenter } = await openAt(600);
  presenter.scrollTo(4000);
  await tick();

  await presenter.open({ kind: 'library', libraryId: 'lib-2' });
  await tick();

  expect(store.virtualTop).toBe(0);
});

test('leaving the viewer puts the cursor on the photo it was showing', async () => {
  const { store, presenter } = await openAt(300);
  runInAction(() => (store.open = { id: 'p42', status: 'ready' }));

  presenter.focusOpenPhoto();

  expect(store.focusIndex).toBe(42);
  // Which is what the grid scrolls to: the tile is well past a 400px viewport.
  expect(store.focusContentTop).toBeGreaterThan(0);
});

test('a photo this client holds no row for leaves the view where it was', async () => {
  const { store, presenter } = await openAt(300);
  runInAction(() => {
    store.focusIndex = 7;
    store.open = { id: 'not-in-this-collection', status: 'ready' };
  });

  presenter.focusOpenPhoto();

  expect(store.focusIndex).toBe(7);
});

test('the way out of the viewer is the collection the photo was opened from', () => {
  const { store } = build();

  store.source = { kind: 'shoot', shootId: 's1' };
  expect(store.openedFrom).toEqual({ path: '/shoots/s1', label: 'Shoot' });

  store.source = { kind: 'album', albumId: 'a1' };
  expect(store.openedFrom).toEqual({ path: '/albums/a1', label: 'Album' });

  store.source = { kind: 'bin', libraryId: LIB };
  expect(store.openedFrom).toEqual({ path: `/libraries/${LIB}/bin`, label: 'Bin' });

  store.source = { kind: 'library', libraryId: LIB };
  expect(store.openedFrom).toEqual({ path: `/libraries/${LIB}`, label: 'Library' });
});
