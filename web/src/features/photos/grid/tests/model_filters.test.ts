// Filtering a collection by the body and the lens it was shot with. A lens is only
// ever offered against the bodies it was mounted on, so the two lists cannot be
// ticked into a combination that lists nothing.
import { runInAction } from 'mobx';
import { afterEach, describe, expect, test } from 'bun:test';
import { type PhotoListResponse } from '../../../../../../src/schemas/photos';
import { type PhotoListParams, photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const A7 = 'ILCE-7RM5';
const R5 = 'Canon EOS R5';
const GM24 = 'FE 24-70mm F2.8 GM II';
const GM85 = 'FE 85mm F1.4 GM';
const RF24 = 'RF24-105mm F4 L IS USM';

const PAIRS = [
  { camera_model: A7, lens_model: GM24 },
  { camera_model: A7, lens_model: GM85 },
  { camera_model: R5, lens_model: RF24 },
  { camera_model: 'iPhone 17 Pro', lens_model: null },
];

function build(): { store: ListingStore; presenter: PhotosPresenter } {
  const absent = new Proxy({}, { get: () => () => undefined }) as never;
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => {
    store.source = { kind: 'library', libraryId: 'lib' };
    store.modelPairs = PAIRS;
  });
  presenter.setViewport(1000, 1000);
  return { store, presenter };
}

const stubbed = { listLibraryPhotos: photosApi.listLibrary };
let asked: PhotoListParams[] = [];

function serve(): void {
  asked = [];
  photosApi.listLibrary = (_libraryId, params) => {
    asked.push(params);
    return Promise.resolve({ photos: [], total: 0, offset: 0, limit: 1, ordering: 'taken_desc' } as PhotoListResponse);
  };
}

describe('the bodies and lenses a collection was shot with', () => {
  afterEach(() => {
    photosApi.listLibrary = stubbed.listLibraryPhotos;
  });

  test('offers each model once, however many photographs carry it', () => {
    const { store } = build();

    expect(store.cameraModelOptions).toEqual([R5, A7, 'iPhone 17 Pro']);
    expect(store.lensModelOptions).toEqual([GM24, GM85, RF24]);
  });

  test('a ticked body rules out the lenses that were never on it', async () => {
    const { store, presenter } = build();
    serve();

    await presenter.toggleModel('camera', A7, true);

    expect(store.filters.cameraModels).toEqual([A7]);
    expect([...store.enabledLensModels].sort()).toEqual([GM24, GM85].sort());
    // Its own list is untouched: ticking a second body is how the first one's
    // lenses are widened, so nothing there may be greyed.
    expect([...store.enabledCameraModels].sort()).toEqual([R5, A7, 'iPhone 17 Pro'].sort());
    expect(asked.at(-1)?.camera_models).toEqual([A7]);
  });

  test('a body that adds nothing under the ticked lenses is still the reader’s to keep', async () => {
    const { store, presenter } = build();
    serve();

    await presenter.toggleModel('camera', A7, true);
    await presenter.toggleModel('camera', R5, true);
    await presenter.toggleModel('lens', RF24, true);

    // The two lists still meet, at the R5: the listing is that body's RF24 frames,
    // and the A7 stands for a question the reader asked and can take back.
    expect(store.filters.cameraModels).toEqual([A7, R5]);
    expect(store.filters.lensModels).toEqual([RF24]);
  });

  test('unticking the last body a ticked lens was on unticks the lens too', async () => {
    const { store, presenter } = build();
    serve();

    await presenter.toggleModel('camera', A7, true);
    await presenter.toggleModel('camera', R5, true);
    await presenter.toggleModel('lens', RF24, true);
    await presenter.toggleModel('camera', R5, false);

    // The lens is only on the body that just left, so keeping it would be a pair
    // no photograph is.
    expect(store.filters.cameraModels).toEqual([A7]);
    expect(store.filters.lensModels).toBeUndefined();
    expect(asked.at(-1)?.lens_models).toBeUndefined();
  });

  test('a ticked model stays ticked and stays enabled', async () => {
    const { store, presenter } = build();
    serve();

    await presenter.toggleModel('lens', GM85, true);

    expect(store.enabledCameraModels.has(A7)).toBe(true);
    expect(store.enabledCameraModels.has(R5)).toBe(false);
    expect(store.enabledLensModels.has(GM85)).toBe(true);
    // One narrowing apiece, as the verdict set counts once however many verdicts.
    expect(store.activeFilterCount).toBe(1);
  });

  test('nothing ticked is no filter at all', async () => {
    const { store, presenter } = build();
    serve();

    await presenter.toggleModel('camera', A7, true);
    await presenter.toggleModel('camera', A7, false);

    expect(store.filters.cameraModels).toBeUndefined();
    expect(store.hasActiveFilters).toBe(false);
    expect(asked.at(-1)?.camera_models).toBeUndefined();
  });
});
