// Reset puts the collection back to what it opens at, which is the working set in a
// gallery and nothing at all in a view that is already a slice of one.
import { runInAction } from 'mobx';
import { afterEach, describe, expect, test } from 'bun:test';
import { type PhotoListResponse } from '../../../../../../src/schemas/photos';
import { photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { type PhotoSource } from '../../photos_store';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

function build(source: PhotoSource): { store: ListingStore; presenter: PhotosPresenter } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => (store.source = source));
  presenter.setViewport(1000, 1000);
  return { store, presenter };
}

const stubbed = { listLibraryPhotos: photosApi.listLibrary };

function serve(): void {
  photosApi.listLibrary = () =>
    Promise.resolve({ photos: [], total: 0, offset: 0, limit: 1, ordering: 'taken_desc' } as PhotoListResponse);
}

describe('resetting every filter', () => {
  afterEach(() => {
    photosApi.listLibrary = stubbed.listLibraryPhotos;
  });

  test('drops every question and leaves the gallery on its working set', async () => {
    const { store, presenter } = build({ kind: 'library', libraryId: 'lib' });
    serve();
    runInAction(() => {
      store.filters = {
        triage: ['rejected'],
        rated: true,
        isMissing: true,
        search: 'alpha',
        takenFrom: '2026-01-01',
        takenTo: '2026-02-01',
        cameraModels: ['ILCE-7RM5'],
        lensModels: ['FE 85mm F1.4 GM'],
        match: 'any',
      };
    });

    await presenter.resetFilters();

    expect(store.filters).toEqual({ triage: ['untriaged', 'picked'] });
    // Where the gallery opens is not something the reader asked for, so the badge
    // this control exists to clear reads zero afterwards.
    expect(store.activeFilterCount).toBe(0);
  });

  test('leaves the Bin the Bin, which is a slice rather than a working set', async () => {
    const { store, presenter } = build({ kind: 'bin', libraryId: 'lib' });
    serve();
    runInAction(() => (store.filters = { rated: false, search: 'alpha' }));

    await presenter.resetFilters();

    expect(store.filters).toEqual({});
  });
});
