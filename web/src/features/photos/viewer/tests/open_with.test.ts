import { afterAll, beforeEach, expect, test } from 'bun:test';
import { PhotosPresenter } from '../../photos_presenter';
import { PhotosPresenterStrings } from '../../photos_presenter.strings';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

const absent = new Proxy({}, { get: () => () => undefined }) as never;

const invoked: { command: string; args: unknown }[] = [];
const shown: string[] = [];
let answer: () => Promise<unknown> = () => Promise.resolve(null);

(globalThis as { __TAURI__?: unknown }).__TAURI__ = {
  core: {
    invoke: (command: string, args: unknown) => {
      invoked.push({ command, args });
      return answer();
    },
  },
};
afterAll(() => Reflect.deleteProperty(globalThis, '__TAURI__'));

function presenter(): PhotosPresenter {
  const toasts = { show: (message: string) => shown.push(message) } as never;
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  return new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, toasts, absent, absent);
}

beforeEach(() => {
  invoked.length = 0;
  shown.length = 0;
  answer = () => Promise.resolve(null);
});

test('asks the shell to open the photo it was pressed on', async () => {
  await presenter().openWith('p0');

  expect(invoked).toEqual([{ command: 'open_original_with', args: { photoId: 'p0' } }]);
  expect(shown).toEqual([]);
});

test('a RAW the shell could not open is reported', async () => {
  answer = () => Promise.reject(new Error('this photo has no RAW on this device: p0'));

  await presenter().openWith('p0');

  expect(shown).toEqual([PhotosPresenterStrings.openWithFailed()]);
});

test('asks the shell to show the photo, or the file, it was pressed on', async () => {
  await presenter().revealOriginal('p0');
  await presenter().revealFile('/renditions/p0.avif');

  expect(invoked).toEqual([
    { command: 'reveal_original', args: { photoId: 'p0' } },
    { command: 'reveal_file', args: { path: '/renditions/p0.avif' } },
  ]);
  expect(shown).toEqual([]);
});

test('a file the shell could not show is reported', async () => {
  answer = () => Promise.reject('/library/p0.ARW is not on this device');

  await presenter().revealOriginal('p0');
  await presenter().revealFile('/library/p0.ARW');

  expect(shown).toEqual([PhotosPresenterStrings.revealFailed(), PhotosPresenterStrings.revealFailed()]);
});
