// The presenter driven against a scripted list endpoint. What is under test is
// what a re-read does to a selection while the collection moves underneath it -
// the part that cannot be reached from the pure layout and range modules.
import { beforeEach, expect, test } from 'bun:test';
import { type PhotoListResponse, type PhotoSummary } from '../../../../../../src/schemas/photos';
import type { RequestActivity } from '../../../../../../src/schemas/request_activity';
import { type PhotoListParams, photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { SelectionRanges } from '../../selection';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

restoreApiAfterTests();

const LIB = 'lib-1';

// The collection as ids, mutated between re-reads to play a scan.
let collection: string[] = [];
// Requests parked rather than answered, so two re-reads can be interleaved by
// hand. Null while a test wants immediate answers.
let parked: (() => void)[] | null = null;
// Blocks whose request should fail, by offset.
let failing = new Set<number>();
let activities: (RequestActivity | undefined)[] = [];

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

// `api` is a module singleton, so this is the seam. Answers out of `collection`
// as it stands when the request is *answered*, not when it is made, which is
// what makes an overlapping pair of re-reads reproducible.
photosApi.listLibrary = (_libraryId: string, params: PhotoListParams, _signal?: AbortSignal, activity?: RequestActivity): Promise<PhotoListResponse> => {
  activities.push(activity);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  const answer = (): PhotoListResponse =>
    ({
      photos: collection.slice(offset, offset + limit).map(row),
      total: collection.length,
      offset,
      limit,
      ordering: 'taken_asc',
    }) as PhotoListResponse;

  if (failing.has(offset)) return Promise.reject(new Error(`block at ${offset} failed`));
  if (parked == null) return Promise.resolve(answer());
  return new Promise<PhotoListResponse>((resolve) => parked?.push(() => resolve(answer())));
};

const absent = new Proxy({}, { get: () => () => undefined }) as never;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function build(): { store: ListingStore; marks: MarksStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const store = new ListingStore(stacks);
  const marks = new MarksStore(store, stacks);
  const viewer = new ViewerStore(store, stacks);
  const presenter = new PhotosPresenter(store, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  return { store, marks, presenter };
}

async function openAt(count: number): Promise<{ store: ListingStore; marks: MarksStore; presenter: PhotosPresenter }> {
  collection = Array.from({ length: count }, (_, i) => `p${i}`);
  const built = build();
  built.presenter.setViewport(1000, 400);
  await built.presenter.open({ kind: 'library', libraryId: LIB });
  built.presenter.rail.setTop(0);
  await tick();
  return built;
}

beforeEach(() => {
  parked = null;
  failing = new Set();
  activities = [];
});

test('an empty collection keeps initial navigation interactive and automatic refresh background', async () => {
  const { presenter } = await openAt(0);
  expect(activities).toEqual(['interactive']);
  await presenter.reload('background');
  expect(activities).toEqual(['interactive', 'background']);
});

// Two of these overlap routinely: the sync poll ticks once a second while a verdict is being
// set. Each snapshotting positions the other has already moved, and applying the same shift
// again, walks the selection off its photos.
test('two overlapping re-reads move the selection once, not twice', async () => {
  const { store, marks, presenter } = await openAt(300);
  marks.selection = SelectionRanges.of(20, 69);
  expect(store.rows.get(20)?.id).toBe('p20');

  collection = ['n0', 'n1', 'n2', 'n3', 'n4', ...collection];

  parked = [];
  const first = presenter.reload();
  await tick();
  const second = presenter.reload();
  await tick();
  // Answer everything that was asked for, in whatever order it arrives.
  while (parked.length > 0) {
    const answering = parked;
    parked = [];
    for (const answer of answering) answer();
    await tick();
  }
  parked = null;
  await Promise.all([first, second]);
  await tick();

  // p20 sits at 25 now, so the selection has to name 25..74 and nothing else.
  expect(marks.selection.ranges).toEqual([{ start: 25, end: 74 }]);
  expect(store.rows.get(marks.selection.ranges[0]!.start)?.id).toBe('p20');
});

// A block whose re-read failed leaves its old rows sitting where they were. Read
// as if they had been confirmed, they report a move of zero that never happened,
// and the selection over them is silently truncated.
test('a block whose re-read failed is not treated as confirmation', async () => {
  const { store, marks, presenter } = await openAt(300);
  // Reach far enough down that blocks 0 and 1 are both held.
  presenter.rail.setTop(0);
  marks.selection = SelectionRanges.of(20, 150);
  await tick();

  collection = ['n0', 'n1', 'n2', 'n3', 'n4', ...collection];
  failing = new Set([100]); // the second block's request throws

  await presenter.reload();
  await tick();

  // Block 1 said nothing, so nothing is claimed about the positions in it: the
  // surviving selection is the part block 0 confirmed, never a longer run built
  // on a stale row.
  for (const range of marks.selection.ranges) {
    for (let index = range.start; index <= range.end; index++) {
      const held = store.rows.get(index);
      if (held != null) expect(held.id).toBe(`p${index - 5}`);
    }
  }
  expect(marks.selection.size).toBeLessThanOrEqual(131);
});
