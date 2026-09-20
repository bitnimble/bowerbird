import { expect, test } from 'bun:test';
import { type EditState } from '../../../../../../src/schemas/photo_edits';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { photoEditsApi } from '../../../../api/photo_edits';
import { photosApi } from '../../../../api/photos';
import { EditDocSchema } from '../../../../../../src/schemas/photo_edits';
import { restoreApiAfterTests } from '../../../../test_api';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerStore } from '../viewer_store';

restoreApiAfterTests();

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function build(open = true): { store: ViewerStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const store = new ViewerStore(listing, stacks);
  if (open) store.open = { id: 'p1', status: 'ready' };
  return {
    store,
    presenter: new PhotosPresenter(listing, marks, stacks, store, absent, absent, absent, absent, {} as never, absent),
  };
}

test('viewer turns save in order and refresh the rendered source', async () => {
  let state: EditState = { doc: EditDocSchema.parse({}), rev: 0, canUndo: false, canRedo: false };
  const revisions: number[] = [];
  let finished = 0;
  photoEditsApi.get = async () => state;
  photoEditsApi.save = async (_photoId, doc, rev) => {
    revisions.push(rev);
    state = { ...state, doc, rev: rev + 1 };
    return state;
  };
  photoEditsApi.finish = async () => { finished++; };
  photosApi.get = async () => ({ id: 'p1', shown_rendition: 'full' }) as PhotoDetail;

  const { store, presenter } = build();
  const before = store.sourceOf('p1', 'embedded');

  await Promise.all([presenter.turn('p1', 90), presenter.turn('p1', 90)]);

  expect(revisions).toEqual([0, 1]);
  expect(store.editsFor('p1')?.rotate).toBe(180);
  expect(store.sourceOf('p1', 'embedded')).not.toBe(before);
  expect(store.showing).toBe('embedded');
  expect(finished).toBe(2);
});

test('late edits read cannot overwrite viewer turn', async () => {
  let state: EditState = { doc: EditDocSchema.parse({}), rev: 0, canUndo: false, canRedo: false };
  const old = state;
  let release: (value: EditState) => void = () => {};
  const stale = new Promise<EditState>((resolve) => { release = resolve; });
  let reads = 0;
  photoEditsApi.get = async () => ++reads === 1 ? stale : state;
  photoEditsApi.save = async (_photoId, doc, rev) => {
    state = { ...state, doc, rev: rev + 1 };
    return state;
  };
  photoEditsApi.finish = async () => {};
  photosApi.get = async () => ({ id: 'p1', shown_rendition: 'full' }) as PhotoDetail;
  const { store, presenter } = build();
  const loading = presenter.loadEdits('p1');
  await presenter.turn('p1', 90);
  release(old);
  await loading;
  expect(store.editsFor('p1')?.rotate).toBe(90);
});

test('only changed embedded orientation invalidates its decoded URL', () => {
  const { store, presenter } = build(false);
  const embedded = store.sourceOf('p1', 'embedded');
  const full = store.sourceOf('p1', 'full');

  presenter.forgetEdits('p1');
  expect(store.sourceOf('p1', 'embedded')).toBe(embedded);
  presenter.forgetEdits('p1', true);
  expect(store.sourceOf('p1', 'embedded')).not.toBe(embedded);
  expect(store.sourceOf('p1', 'full')).toBe(full);
});
