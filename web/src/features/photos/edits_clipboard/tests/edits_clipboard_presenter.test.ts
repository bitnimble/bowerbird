import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { neutralEdits, type EditDoc } from '../../../../../../src/schemas/photo_edits';
import { type PhotoTarget } from '../../../../../../src/schemas/photos';
import { photoEditsApi } from '../../../../api/photo_edits';
import { photosApi } from '../../../../api/photos';
import { restoreApiAfterTests } from '../../../../test_api';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { PhotosPresenter } from '../../photos_presenter';
import { ViewerStore } from '../../viewer/viewer_store';
import { EditsClipboardPresenter } from '../edits_clipboard_presenter';
import { EditsClipboardStore } from '../edits_clipboard_store';

restoreApiAfterTests();

const absent = new Proxy({}, { get: () => () => undefined }) as never;
const TARGET: PhotoTarget = { photo_ids: ['p1', 'p2', 'p3'] };
const DEVELOPED: EditDoc = { ...neutralEdits(), exposure: 1.5, contrast: 20, cropLeft: 0.3 };

type Sent = Parameters<typeof photosApi.pasteEdits>;

function build(): {
  clipboard: EditsClipboardPresenter;
  store: EditsClipboardStore;
  messages: () => string[];
  forgotten: string[];
  reloads: () => number;
  sent: Sent[];
} {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const viewer = new ViewerStore(listing, stacks);
  viewer.open = { id: 'p1', status: 'ready' };
  const photos = new PhotosPresenter(
    listing,
    new MarksStore(listing, stacks),
    stacks,
    viewer,
    absent,
    absent,
    absent,
    absent,
    {} as never,
    absent,
  );
  const forgotten: string[] = [];
  let reloads = 0;
  photos.forgetEdits = (photoId) => void forgotten.push(photoId);
  photos.reload = async () => void reloads++;
  const sent: Sent[] = [];
  photosApi.pasteEdits = async (target, edits, open) => {
    sent.push([target, edits, open]);
    const ids = 'photo_ids' in target ? target.photo_ids : [];
    const skipped = open.editing != null && ids.includes(open.editing);
    return { pasted: ids.length - (skipped ? 1 : 0), editing_skipped: skipped };
  };
  photoEditsApi.get = async () => ({ doc: DEVELOPED, rev: 3, canUndo: true, canRedo: false });
  const toasts = new ToastsStore();
  const store = new EditsClipboardStore();
  const clipboard = new EditsClipboardPresenter(store, viewer, photos, new ToastsPresenter(toasts));
  return {
    clipboard,
    store,
    messages: () => toasts.toasts.map((toast) => toast.message),
    forgotten,
    reloads: () => reloads,
    sent,
  };
}

test('pastes the copied look onto the grid, and no framing', async () => {
  const { clipboard, messages, forgotten, reloads, sent } = build();

  await clipboard.copy('p1');
  await clipboard.paste(TARGET, false);

  expect(sent).toHaveLength(1);
  const [target, edits, open] = sent[0]!;
  expect(target).toEqual(TARGET);
  expect(edits).toMatchObject({ exposure: 1.5, contrast: 20 });
  expect(edits).not.toHaveProperty('cropLeft');
  // The viewer's open photo is not on screen from the grid, so only grid tiles rebuild.
  expect(open).toEqual({ shown: undefined, editing: undefined });
  expect(forgotten).toEqual([]);
  expect(reloads()).toBe(1);
  expect(messages()).toEqual(['Edits copied.', 'Edits pasted to 3 photos.']);
});

test('names the photo on screen when the paste comes from the filmstrip', async () => {
  const { clipboard, forgotten, reloads, sent } = build();

  await clipboard.copy('p9');
  await clipboard.paste(TARGET, true);

  expect(sent[0]![2]).toEqual({ shown: 'p1', editing: undefined });
  expect(forgotten).toEqual(['p1']);
  expect(reloads()).toBe(1);
});

test('pastes nothing before anything is copied', async () => {
  const { clipboard, sent } = build();

  await clipboard.paste(TARGET, true);

  expect(sent).toHaveLength(0);
});

test('copies from and pastes into the open editor through the editor itself', async () => {
  const { clipboard, messages, forgotten, sent } = build();
  const pasted: Partial<EditDoc>[] = [];
  clipboard.attachEditor({
    photoId: 'p1',
    doc: () => ({ ...DEVELOPED, exposure: -2 }),
    paste: (edits) => pasted.push(edits),
  });
  photoEditsApi.get = async () => {
    throw new Error('the editor holds the newer document');
  };

  await clipboard.copy('p1');
  await clipboard.paste(TARGET, true);

  expect(sent).toHaveLength(1);
  expect(sent[0]![1]).toMatchObject({ exposure: -2 });
  expect(sent[0]![2]).toEqual({ shown: undefined, editing: 'p1' });
  expect(pasted).toEqual([expect.objectContaining({ exposure: -2, contrast: 20 })]);
  expect(forgotten).toEqual([]);
  expect(messages().at(-1)).toBe('Edits pasted to 3 photos.');
});

test('leaves the editor alone where the paste did not name its photo', async () => {
  const { clipboard, messages } = build();
  const pasted: Partial<EditDoc>[] = [];
  clipboard.attachEditor({ photoId: 'p9', doc: () => null, paste: (edits) => pasted.push(edits) });

  await clipboard.copy('p1');
  await clipboard.paste(TARGET, true);

  expect(pasted).toEqual([]);
  expect(messages().at(-1)).toBe('Edits pasted to 3 photos.');
});

test("pastes onto the editor's photo itself where the editor closed while the paste was out", async () => {
  const { clipboard, sent } = build();
  const pasted: Partial<EditDoc>[] = [];
  const detach = clipboard.attachEditor({
    photoId: 'p1',
    doc: () => null,
    paste: (edits) => pasted.push(edits),
  });
  await clipboard.copy('p2');
  const send = photosApi.pasteEdits;
  photosApi.pasteEdits = async (...args) => {
    detach();
    return send(...args);
  };

  await clipboard.paste(TARGET, true);

  expect(pasted).toEqual([]);
  expect(sent.map(([target, , open]) => [target, open])).toEqual([
    [TARGET, { shown: undefined, editing: 'p1' }],
    [{ photo_ids: ['p1'] }, {}],
  ]);
});

test('reports a copy or a paste that failed, and keeps what was copied', async () => {
  const { clipboard, store, messages, reloads } = build();
  photoEditsApi.get = async () => {
    throw new Error('Photo not found.');
  };

  await clipboard.copy('p1');
  expect(store.copied).toBeNull();

  runInAction(() => (store.copied = { exposure: 1 }));
  photosApi.pasteEdits = async () => {
    throw new Error('The server could not save these edits.');
  };
  await clipboard.paste(TARGET, false);

  expect(messages()).toEqual(['Photo not found.', 'The server could not save these edits.']);
  expect(store.copied).toEqual({ exposure: 1 });
  expect(reloads()).toBe(0);
});
