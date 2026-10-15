import { beforeEach, expect, test } from 'bun:test';
import { type PhotoListResponse, type PhotoSummary } from '../../../../../../src/schemas/photos';
import { type PhotoListParams, photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

restoreApiAfterTests();

const LIB = 'lib-1';
const COUNT = 1000;

// Every third photo already has its tile.
function row(index: number): PhotoSummary {
  return {
    id: `p${index}`,
    library_id: LIB,
    shoot_id: null,
    file_path: `p${index}.arw`,
    width: 3,
    height: 2,
    ordering_date: null,
    triage: 'untriaged',
    rating: 0,
    is_missing: false,
    is_deleted: false,
    tile_built_at: index % 3 === 0 ? '2026-01-01T00:00:00Z' : null,
    renditions_built_at: null,
    date_updated: null,
    viewer_rendition: null,
  } as unknown as PhotoSummary;
}

photosApi.listLibrary = (_libraryId: string, params: PhotoListParams) => {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  const end = Math.min(COUNT, offset + limit);
  return Promise.resolve({
    photos: Array.from({ length: Math.max(0, end - offset) }, (_, i) => row(offset + i)),
    total: COUNT,
    offset,
    limit,
    ordering: 'taken_asc',
  } as PhotoListResponse);
};

let sent: string[][] = [];
photosApi.prefer = (photoIds: string[]) => {
  sent.push(photoIds);
  return Promise.resolve();
};

const absent = new Proxy({}, { get: () => () => undefined }) as never;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 350));

function build(): { store: ListingStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(
    store,
    marks,
    stacks,
    viewer,
    absent,
    absent,
    absent,
    absent,
    {} as never,
    absent,
  );
  return { store, presenter };
}

function unbuiltFrom(from: number, count: number): string[] {
  const ids: string[] = [];
  for (let index = from; ids.length < count; index++) if (index % 3 !== 0) ids.push(`p${index}`);
  return ids;
}

beforeEach(async () => {
  // Presenters from earlier files are never disposed, and their delayed reaction can land here.
  await settle();
  sent = [];
});

test('asks for the unbuilt tiles from the top of the view down, once per view', async () => {
  const { store, presenter } = build();
  presenter.setViewport(1000, 400);
  await presenter.open({ kind: 'library', libraryId: LIB });
  presenter.rail.setTop(0);
  await settle();

  expect(store.visible.from).toBe(0);
  expect(store.rows.size).toBe(100);
  expect(sent).toEqual([unbuiltFrom(0, 66)]);

  await presenter.reload();
  await settle();
  expect(sent).toHaveLength(1);

  presenter.rail.setTop(5000);
  await settle();
  expect(store.visible.from).toBe(100);
  expect(sent).toEqual([unbuiltFrom(0, 66), unbuiltFrom(100, 67)]);
});

test('asks for at most 200', async () => {
  const { presenter } = build();
  presenter.setViewport(1000, 20000);
  await presenter.open({ kind: 'library', libraryId: LIB });
  presenter.rail.setTop(0);
  await settle();

  expect(sent).toEqual([unbuiltFrom(0, 200)]);
});
