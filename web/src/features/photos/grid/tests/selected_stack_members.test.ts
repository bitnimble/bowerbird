// Picking a stack is picking what is in it (§19.6.1). The store says so through
// `selectedLoadedPhotos`, and this is the half that puts the members there: a reader who selects a
// stack tile without ever opening its band still has to be able to merge it.
import { runInAction } from 'mobx';
import { afterEach, expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { stacksApi } from '../../../../api/stacks';
import { PhotosPresenter } from '../../photos_presenter';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

function photo(id: string, stackId: string | null = null, stackSize = 1): PhotoSummary {
  return { id, library_id: 'lib', stack_id: stackId, stack_size: stackSize } as unknown as PhotoSummary;
}

const MEMBERS = [photo('m0'), photo('m1'), photo('m2')];

function build(): { store: MarksStore; presenter: PhotosPresenter } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const store = new MarksStore(listing, stacks);
  const viewer = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, store, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => {
    listing.source = { kind: 'library', libraryId: 'lib' };
    listing.ordering = 'taken_desc';
    listing.total = 2;
    listing.rows.set(0, photo('a'));
    listing.rows.set(1, photo('s', 's1', 3));
  });
  return { store, presenter };
}

const stubbed = { listStackPhotos: stacksApi.listPhotos };
afterEach(() => {
  stacksApi.listPhotos = stubbed.listStackPhotos;
});

test('selecting a stack tile fetches what it stands for, once', async () => {
  const { store } = build();
  let asked = 0;
  stacksApi.listPhotos = () => {
    asked += 1;
    return Promise.resolve(MEMBERS);
  };

  runInAction(() => (store.selection = SelectionRanges.of(1, 1)));
  await Promise.resolve();
  await Promise.resolve();

  expect(asked).toBe(1);
  expect(store.selectedLoadedPhotos.map((p) => p.id)).toEqual(['m0', 'm1', 'm2']);
  // The row is still one row: what changed is what it is taken to stand for.
  expect(store.selectedLoadedRows.map((p) => p.id)).toEqual(['s']);
  expect(store.mergeCandidate.kind).toBe('ready');

  // Selecting the loose one beside it asks for nothing more.
  runInAction(() => (store.selection = SelectionRanges.of(0, 1)));
  await Promise.resolve();
  expect(asked).toBe(1);
});

// A stack nobody picked is a request nobody needs, and a listing of them would be one apiece.
test('an unselected stack is never fetched', async () => {
  const { store } = build();
  let asked = 0;
  stacksApi.listPhotos = () => {
    asked += 1;
    return Promise.resolve(MEMBERS);
  };

  runInAction(() => (store.selection = SelectionRanges.of(0, 0)));
  await Promise.resolve();

  expect(asked).toBe(0);
  expect(store.selectedLoadedPhotos.map((p) => p.id)).toEqual(['a']);
});
