// The stack the viewer steps into (§19.6). A collapsed listing gives a member no
// row of its own, so until its stack's band is open the filmstrip has no cell to
// mark and reads as though nothing at all is open.
import { runInAction } from 'mobx';
import { afterEach, expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { photosApi } from '../../../../api/photos';
import { stacksApi } from '../../../../api/stacks';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { StripViewPresenter } from '../strip_view_presenter';
import { StripViewStore } from '../strip_view_store';
import { ViewerStore } from '../viewer_store';

const AT = 3;

function photo(id: string, stackId: string | null = null, stackSize = 1): PhotoSummary {
  return { id, width: 3000, height: 2000, stack_id: stackId, stack_size: stackSize } as unknown as PhotoSummary;
}

// The run the viewer steps along is uncollapsed (§19.5.3), so the stack is three
// photographs there and one row in the listing below.
const MEMBERS = [photo('p3', 's1', 3), photo('m1', 's1', 3), photo('m2', 's1', 3)];

function build(): {
  listing: ListingStore;
  store: StacksStore;
  viewer: ViewerStore;
  photos: PhotosPresenter;
  view: StripViewStore;
  strip: StripViewPresenter;
} {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const store = new StacksStore();
  const listing = new ListingStore(store);
  const marks = new MarksStore(listing, store);
  const viewer = new ViewerStore(listing, store);
  const photos = new PhotosPresenter(listing, marks, store, viewer, absent, absent, absent, absent, {} as never, absent);
  const view = new StripViewStore(listing, store, viewer);
  const strip = new StripViewPresenter(view, photos);
  runInAction(() => {
    listing.source = { kind: 'library', libraryId: 'lib' };
    listing.ordering = 'taken_desc';
    listing.total = 40;
    for (let index = 0; index < 40; index++) listing.rows.set(index, photo(`p${index}`));
    listing.rows.set(AT, photo('p3', 's1', 3));
    viewer.neighbourhood = MEMBERS;
  });
  return { listing, store, viewer, photos, view, strip };
}

function stepTo(store: ViewerStore, photoId: string): Promise<void> {
  runInAction(() => {
    store.open = { id: photoId, status: 'ready' };
  });
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const stubbed = {
  listStackPhotos: stacksApi.listPhotos,
  listLibraryPhotos: photosApi.listLibrary,
  photoNeighbours: photosApi.neighbours,
  photoPositions: photosApi.positions,
};

afterEach(() => {
  photosApi.listLibrary = stubbed.listLibraryPhotos;
  photosApi.neighbours = stubbed.photoNeighbours;
  photosApi.positions = stubbed.photoPositions;
  stacksApi.listPhotos = stubbed.listStackPhotos;
});

function stub(): void {
  stacksApi.listPhotos = () => Promise.resolve(MEMBERS);
  photosApi.listLibrary = () => Promise.reject(new Error('not asked here'));
  photosApi.neighbours = () => Promise.reject(new Error('not asked here'));
  photosApi.positions = () => Promise.resolve({ s1: [AT] });
}

test('the strip names the stack the open photograph is in', () => {
  const { viewer, view } = build();

  runInAction(() => {
    viewer.open = { id: 'm1', status: 'ready' };
  });

  expect(view.openPhotoStack).toBe('s1');
});

test('an uncollapsed listing has no band to open', () => {
  const { listing, viewer, view } = build();

  runInAction(() => {
    listing.expandStacks = true;
    viewer.open = { id: 'm1', status: 'ready' };
  });

  expect(view.openPhotoStack).toBeNull();
});

test('stepping into a stack opens its band, and stepping out closes it again', async () => {
  stub();
  const { store, viewer, view, strip } = build();
  strip.watch();

  await stepTo(viewer, 'm1');
  expect(store.expansions.get('s1')?.position).toBe(AT);
  // Which is what the strip needed: the member has a cell of its own now, inside
  // the band, rather than nowhere.
  expect(view.cellOf('m1')).toBe(AT + 2);

  await stepTo(viewer, 'p4');
  expect(store.expansions.size).toBe(0);
  strip.stop();
});

test('a band the reader opened themselves is left standing behind them', async () => {
  stub();
  const { store, viewer, photos, strip } = build();
  await photos.toggleBand('s1', AT);
  strip.watch();

  await stepTo(viewer, 'm1');
  await stepTo(viewer, 'p4');

  expect(store.expansions.size).toBe(1);
  strip.stop();
});

// The viewer opened straight onto a member - a link, a reload - and nothing has
// asked for the block the stack's own row is in: a member has no row to place the
// window around (`neededBlocks`), so the loaded rows cannot answer where its stack
// is and the server has to.
test('a stack whose row this client is not holding is placed by the server', async () => {
  stub();
  const { listing, store, viewer, view, strip } = build();
  runInAction(() => listing.rows.clear());
  strip.watch();

  await stepTo(viewer, 'm1');

  expect(store.expansions.get('s1')?.position).toBe(AT);
  expect(view.cellOf('m1')).toBe(AT + 2);
  strip.stop();
});

// Arrow keys held down: a step lands while the members of the stack behind it are
// still on the wire, and the band that opens for one the reader has already left
// has to close itself.
test('stepping on before the band arrives leaves no band standing', async () => {
  stub();
  const { store, viewer, strip } = build();
  strip.watch();

  runInAction(() => {
    viewer.open = { id: 'm1', status: 'ready' };
  });
  await stepTo(viewer, 'p4');

  expect(store.expansions.size).toBe(0);
  strip.stop();
});

test('leaving the viewer takes the band it opened with it', async () => {
  stub();
  const { store, viewer, strip } = build();
  strip.watch();
  await stepTo(viewer, 'm1');
  expect(store.expansions.size).toBe(1);

  strip.stop();

  expect(store.expansions.size).toBe(0);
});
