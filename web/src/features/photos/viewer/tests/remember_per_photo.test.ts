// The other half of "reopen at whatever was chosen last": the per-photo memory,
// which is a column on the row rather than a setting. Choosing the rendition
// already on the row wrote it back anyway, once per pick.
import { beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoDetail, type PhotoListResponse, type PhotoSummary } from '../../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../../src/schemas/settings';
import { type PhotoListParams, photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';
import { restoreApiAfterTests } from '../../../../test_api';

restoreApiAfterTests();

const LIB = 'lib-1';
const PHOTO = 'p0';

let remembered: ViewerRendition | null = null;
const written: ViewerRendition[] = [];

function row(): PhotoSummary {
  return {
    id: PHOTO,
    library_id: LIB,
    shoot_id: null,
    file_path: `${PHOTO}.arw`,
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
    viewer_rendition: remembered,
  } as unknown as PhotoSummary;
}

// `api` is a module singleton, so this is the seam.
photosApi.listLibrary = (_libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> =>
  Promise.resolve({
    photos: [row()],
    total: 1,
    offset: params.offset ?? 0,
    limit: params.limit ?? 100,
    ordering: 'taken_asc',
  } as PhotoListResponse);

photosApi.update = (_photoId: string, fields: Parameters<typeof photosApi.update>[1]) => {
  written.push(fields.viewer_rendition as ViewerRendition);
  remembered = fields.viewer_rendition as ViewerRendition;
  // The row is what this test reads back; the fields a detail carries beyond it are nobody's here.
  return Promise.resolve(row() as unknown as PhotoDetail);
};

const absent = new Proxy({}, { get: () => () => undefined }) as never;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function open(): Promise<PhotosPresenter> {
  const settings = { viewerRenditionMode: 'remember_per_photo' } as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, settings, absent);
  presenter.setViewport(1000, 400);
  await presenter.open({ kind: 'library', libraryId: LIB });
  runInAction(() => (store.open = { id: PHOTO, status: 'ready' }));
  await tick();
  return presenter;
}

beforeEach(() => {
  remembered = null;
  written.length = 0;
});

test('the first choice is written to the photo', async () => {
  const presenter = await open();
  await presenter.chooseRendition(PHOTO, 'embedded');
  expect(written).toEqual(['embedded']);
});

test('choosing the rendition the photo already remembers writes nothing', async () => {
  remembered = 'embedded';
  const presenter = await open();
  await presenter.chooseRendition(PHOTO, 'embedded');
  expect(written).toEqual([]);
});
