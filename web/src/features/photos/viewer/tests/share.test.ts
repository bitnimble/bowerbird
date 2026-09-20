// Sharing is about the picture in front of the reader, so the file that goes to the sheet is
// the rendition on screen - and it is made once, because the encode behind it is seconds on a
// large frame and closing a share sheet to reach for another application is ordinary.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { PathSegment, route } from '../../../../../../src/schemas/route';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../../src/schemas/settings';
import { photosApi } from '../../../../api/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { restoreApiAfterTests } from '../../../../test_api';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

restoreApiAfterTests();

const PHOTO = 'p0';

photosApi.get = (): Promise<PhotoDetail> => Promise.resolve({ id: PHOTO } as PhotoDetail);

const absent = new Proxy({}, { get: () => () => undefined }) as never;

const asked: string[] = [];
const shared: File[] = [];
const shown: string[] = [];
const waiting: string[] = [];
const dismissed: number[] = [];
let answer: () => Response = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
let sheet: () => Promise<void> = () => Promise.resolve();
// Set where a test needs the encode to still be running when it presses again.
let gate: Promise<void> | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string) => {
  asked.push(String(input));
  return gate == null ? Promise.resolve(answer()) : gate.then(answer);
}) as typeof fetch;
Object.defineProperty(navigator, 'share', {
  configurable: true,
  writable: true,
  value: (data: { files?: File[] }) => {
    shared.push(...(data.files ?? []));
    return sheet();
  },
});
// Both of these are the process's, and the process runs every other suite after this one.
afterAll(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(navigator, 'share');
});

// `builtAt` is the stamp that moves when a rendition is rebuilt, which is what the viewer
// versions its own URLs by.
function open(showing: ViewerRendition, builtAt?: string): { store: ViewerStore; presenter: PhotosPresenter } {
  const settings = { viewerRenditionMode: 'remember', lastViewerRendition: null } as never;
  const toasts = {
    show: (message: string) => shown.push(message),
    showProgress: (message: string) => {
      waiting.push(message);
      return waiting.length;
    },
    dismiss: (id: number) => dismissed.push(id),
  } as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, toasts, settings, absent);
  runInAction(() => {
    store.open = { id: PHOTO, status: 'ready' };
    store.rendition = showing;
    if (builtAt != null) store.details = built(builtAt);
  });
  return { store, presenter };
}

function built(at: string): Map<string, PhotoDetail> {
  return new Map([[PHOTO, { id: PHOTO, renditions_built_at: at } as unknown as PhotoDetail]]);
}

beforeEach(() => {
  asked.length = 0;
  shared.length = 0;
  shown.length = 0;
  waiting.length = 0;
  dismissed.length = 0;
  answer = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
  sheet = () => Promise.resolve();
  gate = null;
});

test('the rendition on screen is the one shared', async () => {
  const { presenter } = open('max');

  await presenter.share(PHOTO);

  expect(asked).toEqual([expect.stringContaining(route(PathSegment.image(), PHOTO, PathSegment.share(), 'max'))]);
  expect(shared).toHaveLength(1);
  expect(shared[0]?.type).toBe('image/jpeg');
  expect(shared[0]?.name).toEndWith('.jpg');
});

// The encode is the expensive half and the sheet is free, so the second press is the sheet
// alone. This is also what makes a cancelled share cheap to change your mind about.
test('the file is made once for the rendition it was made from', async () => {
  const { store, presenter } = open('full');

  await presenter.share(PHOTO);
  await presenter.share(PHOTO);
  expect(asked).toHaveLength(1);
  // And the wait is only said where there is one: the second press opens the sheet on a file
  // already in hand.
  expect(waiting).toHaveLength(1);
  expect(dismissed).toHaveLength(1);

  runInAction(() => (store.rendition = 'max'));
  await presenter.share(PHOTO);
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain(route(PathSegment.share(), 'max'));
});

// The file is the rendition's, and a re-render replaces that file under the same name. Held on
// the rendition alone, the press after a rebuild sent the picture from before it.
test('a rebuilt rendition is made again rather than shared from the copy before it', async () => {
  const { store, presenter } = open('full', '2026-09-11T00:00:00.000Z');

  await presenter.share(PHOTO);
  expect(asked).toHaveLength(1);

  runInAction(() => (store.details = built('2026-09-11T01:00:00.000Z')));
  await presenter.share(PHOTO);

  expect(asked).toHaveLength(2);
});

// The Web Share API allows one share at a time and rejects the second, so a reader pressing
// again while the encode runs would have been told it failed.
test('a second press while the first is still encoding is ignored', async () => {
  const { presenter } = open('full');
  let release = (): void => undefined;
  gate = new Promise<void>((resolve) => (release = resolve));

  const first = presenter.share(PHOTO);
  const second = presenter.share(PHOTO);
  release();
  await Promise.all([first, second]);

  expect(asked).toHaveLength(1);
  expect(shared).toHaveLength(1);
  expect(shown).toEqual([]);
});

// Closing the sheet without picking anything is how most shares end, and it is not a failure
// to report.
test('a share the reader closed says nothing', async () => {
  const { presenter } = open('full');
  sheet = () => Promise.reject(new DOMException('cancelled', 'AbortError'));

  await presenter.share(PHOTO);

  expect(shown).toEqual([]);
});

test('a file the server would not make is reported', async () => {
  const { presenter } = open('full');
  answer = () => new Response(null, { status: 404 });

  await presenter.share(PHOTO);

  expect(shared).toEqual([]);
  expect(shown).toHaveLength(1);
});
