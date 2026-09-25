// The client half of hiding (§12.4): what the Hidden tick asks the server for, and what the bulk
// bar's two rows send. Against the presenter rather than a browser, because the question is which
// value the module is handed - a canvas comparison could say something changed and never that the
// value was right.
import { runInAction } from 'mobx';
import { afterEach, describe, expect, test } from 'bun:test';
import { type PhotoListResponse, type PhotoTarget } from '../../../../../../src/schemas/photos';
import { type PhotoListParams, photosApi } from '../../../../api/photos';
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

const stubbed = { listLibraryPhotos: photosApi.listLibrary, hidePhotos: photosApi.hide };

/** Every listing request the presenter made, so the filters it carried can be read back. */
let asked: PhotoListParams[];
let hidden: { target: PhotoTarget; hidden: boolean }[];

function serve(): void {
  asked = [];
  hidden = [];
  photosApi.listLibrary = (_libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> => {
    asked.push(params);
    return Promise.resolve({ photos: [], total: 0, offset: 0, limit: 1, ordering: 'taken_desc' } as PhotoListResponse);
  };
  photosApi.hide = (target: PhotoTarget, on: boolean): Promise<{ updated: number }> => {
    hidden.push({ target, hidden: on });
    return Promise.resolve({ updated: 1 });
  };
}

describe('what the Hidden tick asks for', () => {
  afterEach(() => {
    photosApi.listLibrary = stubbed.listLibraryPhotos;
    photosApi.hide = stubbed.hidePhotos;
  });

  // A chip, not a swap: the request carries `match: 'any'` beside it, so the grid holds the put-away
  // and the picks together rather than the hidden picks alone.
  test('carries is_hidden with the union, beside whatever else is ticked', async () => {
    const { presenter } = build({ kind: 'library', libraryId: 'lib' });
    serve();

    await presenter.setFilters({ isHidden: true, triage: ['picked'], match: 'any' });

    expect(asked.at(-1)?.is_hidden).toBe(true);
    expect(asked.at(-1)?.match).toBe('any');
    // Spread, because the store hands the presenter an observable array and its proxy is not a plain
    // one to compare against.
    expect([...(asked.at(-1)?.triage ?? [])]).toEqual(['picked']);
  });

  // Unticked it is absent rather than false: there is no "not hidden" to ask for, hiding being the
  // default the other ticks are read against.
  test('says nothing at all when it is not ticked', async () => {
    const { presenter } = build({ kind: 'library', libraryId: 'lib' });
    serve();

    await presenter.setFilters({ triage: ['picked'] });

    expect(asked.at(-1)?.is_hidden).toBeUndefined();
  });

  // A selection resolves against the listing it was made in, so the same filter has to travel with it
  // or the server reads positions off a different collection than the grid showed.
  test('travels with a selection made under it', async () => {
    const { presenter } = build({ kind: 'library', libraryId: 'lib' });
    serve();
    await presenter.setFilters({ isHidden: true, match: 'any' });
    presenter.toggle(0);

    const target = presenter.selectionTarget();

    expect(target).not.toBeNull();
    expect(target != null && 'selection' in target && target.selection.filters).toMatchObject({ is_hidden: true });
  });
});

describe('putting a selection away and bringing it back', () => {
  afterEach(() => {
    photosApi.listLibrary = stubbed.listLibraryPhotos;
    photosApi.hide = stubbed.hidePhotos;
  });

  // A mixed selection is offered both directions at once, so both have to reach the server as
  // asked - neither row may infer its direction from the other.
  test('sends the direction it was asked for, either way', async () => {
    const { presenter } = build({ kind: 'library', libraryId: 'lib' });
    serve();
    presenter.toggle(0);

    await presenter.hideSelected(true);
    expect(hidden.at(-1)?.hidden).toBe(true);

    presenter.toggle(0);
    await presenter.hideSelected(false);
    expect(hidden.at(-1)?.hidden).toBe(false);
  });

  // One photograph by id, which is how the viewer asks: it has the open photo's own flag to read, so
  // its single row points rather than offering both.
  test('takes one photograph by id, for the viewer', async () => {
    const { presenter } = build({ kind: 'library', libraryId: 'lib' });
    serve();

    await presenter.hidePhotos({ photo_ids: ['p1'] }, true);

    expect(hidden.at(-1)).toEqual({ target: { photo_ids: ['p1'] }, hidden: true });
  });
});
