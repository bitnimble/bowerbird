import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type PhotoListResponse } from '../../../../../../src/schemas/photos';
import { photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

function build(): { marks: MarksStore; presenter: PhotosPresenter } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  presenter.setViewport(1000, 1000);
  return { marks, presenter };
}

function pointer(coarse: boolean): void {
  globalThis.matchMedia = ((media: string) => ({ media, matches: coarse && media === '(pointer: coarse)' })) as never;
}

const original = { listLibrary: photosApi.listLibrary, matchMedia: globalThis.matchMedia };

describe('the marks a collection opens with', () => {
  beforeEach(() => {
    photosApi.listLibrary = () =>
      Promise.resolve({ photos: [], total: 0, offset: 0, limit: 1, ordering: 'taken_desc' } as PhotoListResponse);
  });

  afterEach(() => {
    photosApi.listLibrary = original.listLibrary;
    globalThis.matchMedia = original.matchMedia;
  });

  test('are on under a mouse', async () => {
    pointer(false);
    const { marks, presenter } = build();
    await presenter.open({ kind: 'library', libraryId: 'mouse' });
    expect([marks.showTriage, marks.showRating]).toEqual([true, true]);
  });

  test('are off under a finger', async () => {
    pointer(true);
    const { marks, presenter } = build();
    await presenter.open({ kind: 'library', libraryId: 'finger' });
    expect([marks.showTriage, marks.showRating]).toEqual([false, false]);
  });
});
