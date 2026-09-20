// Setting a shoot's or an album's thumbnail from the grid: the collection owns one
// photograph, so the selection's first is what goes, and the write is the sibling
// presenter's rather than this one reaching into its store.
import { beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const absent = new Proxy({}, { get: () => () => undefined }) as never;

const shootBanners: [string, string][] = [];
const albumBanners: [string, string][] = [];
const shown: string[] = [];
const failed: string[] = [];
let refuse: Error | null = null;

const row = (id: string): PhotoSummary => ({ id, stack_id: null, stack_size: 1 }) as unknown as PhotoSummary;

function open(): { store: MarksStore; presenter: PhotosPresenter } {
  const shoots = {
    setBanner: (shootId: string, photoId: string) => {
      if (refuse != null) return Promise.reject(refuse);
      shootBanners.push([shootId, photoId]);
      return Promise.resolve();
    },
  } as never;
  const albums = {
    setBanner: (albumId: string, photoId: string) => {
      albumBanners.push([albumId, photoId]);
      return Promise.resolve();
    },
  } as never;
  const toasts = {
    show: (message: string) => shown.push(message),
    showError: (message: string) => failed.push(message),
  } as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const store = new MarksStore(listing, stacks);
  const viewer = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, store, stacks, viewer, absent, shoots, albums, toasts, absent, absent);
  runInAction(() => {
    listing.total = 3;
    listing.rows = new Map([
      [1, row('b')],
      [0, row('a')],
    ]);
    store.selection = SelectionRanges.of(0, 1);
  });
  return { store, presenter };
}

beforeEach(() => {
  shootBanners.length = 0;
  albumBanners.length = 0;
  shown.length = 0;
  failed.length = 0;
  refuse = null;
});

test('the selection goes to the shoot as its first photograph', async () => {
  const { presenter } = open();

  await presenter.setSelectionAsBanner({ kind: 'shoot', id: 'sh-1' });

  expect(shootBanners).toEqual([['sh-1', 'a']]);
  expect(albumBanners).toEqual([]);
  expect(shown).toHaveLength(1);
});

test('an album is written by the albums presenter, not the shoots one', async () => {
  const { presenter } = open();

  await presenter.setSelectionAsBanner({ kind: 'album', id: 'al-1' });

  expect(albumBanners).toEqual([['al-1', 'a']]);
  expect(shootBanners).toEqual([]);
});

// Nothing about the selection was consumed, so the reader can go on acting on it.
test('the selection survives', async () => {
  const { store, presenter } = open();

  await presenter.setSelectionAsBanner({ kind: 'shoot', id: 'sh-1' });

  expect(store.selectionCount).toBe(2);
});

// A Select all scrolled away from its own top: the first photograph is a row this
// client is not holding, so there is nothing to name and nothing to write.
test('a selection whose first photograph is not loaded writes nothing', async () => {
  const { store, presenter } = open();
  runInAction(() => (store.selection = SelectionRanges.of(5, 6)));

  await presenter.setSelectionAsBanner({ kind: 'shoot', id: 'sh-1' });

  expect(shootBanners).toEqual([]);
  expect(shown).toEqual([]);
});

test('a refused write is reported instead of announced', async () => {
  const { presenter } = open();
  refuse = new Error('nope');

  await presenter.setSelectionAsBanner({ kind: 'shoot', id: 'sh-1' });

  expect(shown).toEqual([]);
  expect(failed).toHaveLength(1);
});
