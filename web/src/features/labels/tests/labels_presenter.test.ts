import { runInAction } from 'mobx';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Label, SaveLabelsRequest } from '../../../../../src/schemas/labels';
import type { PhotoListResponse } from '../../../../../src/schemas/photos';
import { labelsApi } from '../../../api/labels';
import { type PhotoListParams, photosApi } from '../../../api/photos';
import { PhotosPresenter } from '../../photos/photos_presenter';
import { ListingStore } from '../../photos/grid/listing_store';
import { MarksStore } from '../../photos/grid/marks_store';
import { StacksStore } from '../../photos/grid/stacks_store';
import { ViewerStore } from '../../photos/viewer/viewer_store';
import { textOn } from '../label_pill';
import { LabelEditorStore } from '../label_editor_store';
import { LabelsPresenter } from '../labels_presenter';
import { LabelsStore } from '../labels_store';

const LIB = 'library1';

function label(id: string, name: string, position: number, photoCount = 0): Label {
  return { id, library_id: LIB, name, colour: '#112233', position, photo_count: photoCount };
}

const HELD = [
  label('label001', 'Keeper', 0, 3),
  label('label002', 'Print', 1),
  label('label003', 'Sky', 2),
];

interface Built {
  store: LabelsStore;
  editor: LabelEditorStore;
  presenter: LabelsPresenter;
  labelled: [string, string, boolean][];
  kept: Set<string>[];
  errors: string[];
}

function build(): Built {
  const store = new LabelsStore();
  const editor = new LabelEditorStore();
  const labelled: [string, string, boolean][] = [];
  const kept: Set<string>[] = [];
  const errors: string[] = [];
  const photos = {
    photoLabelled: (photoId: string, labelId: string, on: boolean) =>
      void labelled.push([photoId, labelId, on]),
    keepLabelFilters: (known: ReadonlySet<string>) => {
      kept.push(new Set(known));
      return Promise.resolve();
    },
    reload: () => Promise.resolve(),
  };
  const toasts = {
    showError: (text: string) => void errors.push(text),
    show: () => undefined,
  } as never;
  const presenter = new LabelsPresenter(store, editor, photos, toasts);
  runInAction(() => (store.labels = HELD));
  return { store, editor, presenter, labelled, kept, errors };
}

const original = { ...labelsApi };
const originalList = photosApi.listLibrary;

afterEach(() => {
  Object.assign(labelsApi, original);
  photosApi.listLibrary = originalList;
});

describe('the edit labels dialog', () => {
  test('saves the list as the reader left it, in order, with what they deleted', async () => {
    const { presenter, editor, store } = build();
    labelsApi.list = () => Promise.resolve(HELD);
    let sent: SaveLabelsRequest | null = null;
    labelsApi.save = (body) => {
      sent = body;
      return Promise.resolve([
        label('label003', 'Sea', 0),
        label('label001', 'Keeper', 1),
        label('label009', 'Pano', 2),
      ]);
    };

    await presenter.openEditor(LIB);
    const [keeper, print, sky] = editor.drafts;
    presenter.renameDraft(sky!.key, '  Sea ');
    presenter.moveDraft(sky!.key, keeper!.key);
    presenter.removeDraft(print!.key);
    presenter.addDraft();
    presenter.renameDraft(editor.drafts.at(-1)!.key, 'Pano');
    expect(await presenter.saveEditor()).toBe(true);

    expect(sent!).toEqual({
      library_id: LIB,
      labels: [
        { id: 'label003', name: 'Sea' },
        { id: 'label001' },
        { name: 'Pano', colour: '#ffc53d' },
      ],
      removed: ['label002'],
    });
    expect(store.labels.map((l) => l.name)).toEqual(['Sea', 'Keeper', 'Pano']);
    expect(editor.open).toBe(false);
  });

  test('saves around two labels that already share a name, as replication can leave them', async () => {
    const { presenter, editor, store } = build();
    const twins = [label('label001', 'Keeper', 0), label('label002', 'Keeper', 1)];
    runInAction(() => (store.labels = twins));
    labelsApi.list = () => Promise.resolve(twins);
    await presenter.openEditor(LIB);
    presenter.moveDraft(editor.drafts[1]!.key, editor.drafts[0]!.key);
    expect(editor.duplicates.size).toBe(0);
    expect(editor.canSave).toBe(true);
  });

  test('will not save two labels with one name, or one with none', async () => {
    const { presenter, editor } = build();
    labelsApi.list = () => Promise.resolve(HELD);
    await presenter.openEditor(LIB);
    presenter.renameDraft(editor.drafts[1]!.key, 'keeper');
    expect(editor.duplicates).toEqual(new Set([editor.drafts[1]!.key]));
    expect(editor.canSave).toBe(false);

    presenter.renameDraft(editor.drafts[1]!.key, '   ');
    expect(editor.canSave).toBe(false);
    presenter.renameDraft(editor.drafts[1]!.key, 'Print');
    expect(editor.canSave).toBe(true);
  });

  test('keeps the dialog open with the edits when the save fails', async () => {
    const { presenter, editor } = build();
    labelsApi.list = () => Promise.resolve(HELD);
    labelsApi.save = () => Promise.reject(new Error('offline'));
    await presenter.openEditor(LIB);
    presenter.renameDraft(editor.drafts[0]!.key, 'Best');
    expect(await presenter.saveEditor()).toBe(false);
    expect(editor.open).toBe(true);
    expect(editor.drafts[0]!.name).toBe('Best');
    expect(editor.error).not.toBeNull();
  });
});

describe('labelling a photo', () => {
  test('tells the viewer only once the server has it', async () => {
    const { presenter, labelled, errors } = build();
    labelsApi.addPhotos = () => Promise.resolve();
    await presenter.labelPhoto('photo001', 'label001', true);
    expect(labelled).toEqual([['photo001', 'label001', true]]);

    labelsApi.removePhotos = () => Promise.reject(new Error('offline'));
    await presenter.labelPhoto('photo001', 'label001', false);
    expect(labelled).toEqual([['photo001', 'label001', true]]);
    expect(errors).toHaveLength(1);
  });

  test('drops labels that no longer exist from the grid filter when the list arrives', async () => {
    const { presenter, kept } = build();
    labelsApi.list = () => Promise.resolve([HELD[0]!]);
    await presenter.load();
    expect(kept).toEqual([new Set(['label001'])]);
  });
});

describe('the grid filtered by labels', () => {
  function photos(): {
    presenter: PhotosPresenter;
    asked: PhotoListParams[];
    listing: ListingStore;
  } {
    const absent = new Proxy({}, { get: () => () => undefined }) as never;
    const stacks = new StacksStore();
    const listing = new ListingStore(stacks);
    const presenter = new PhotosPresenter(
      listing,
      new MarksStore(listing, stacks),
      stacks,
      new ViewerStore(listing, stacks),
      absent,
      absent,
      absent,
      absent,
      {} as never,
      absent,
    );
    runInAction(() => (listing.source = { kind: 'library', libraryId: LIB }));
    presenter.setViewport(1000, 1000);
    const asked: PhotoListParams[] = [];
    photosApi.listLibrary = (_libraryId, params) => {
      asked.push(params);
      return Promise.resolve({
        photos: [],
        total: 0,
        offset: 0,
        limit: 1,
        ordering: 'taken_desc',
      } as PhotoListResponse);
    };
    return { presenter, asked, listing };
  }

  test('asks for every ticked label, and forgets one that was deleted', async () => {
    const { presenter, asked, listing } = photos();
    await presenter.toggleLabelFilter('label001', true);
    await presenter.toggleLabelFilter('label002', true);
    expect(asked.at(-1)?.labels).toEqual(['label001', 'label002']);
    expect(listing.activeFilterCount).toBe(1);

    await presenter.keepLabelFilters(new Set(['label002']));
    expect(asked.at(-1)?.labels).toEqual(['label002']);

    await presenter.toggleLabelFilter('label002', false);
    expect(listing.filters.labels).toBeUndefined();
  });
});

describe('a pill', () => {
  test('writes dark on a light colour and light on a dark one', () => {
    expect(textOn('#ffc53d')).toBe('#14161a');
    expect(textOn('#8e4ec6')).toBe('#f4f1ea');
  });
});
