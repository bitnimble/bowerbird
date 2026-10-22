// What a tile's right-click menu acts on: the selection where the tile is in it, else the tile.
import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { PhotosPresenter } from '../../photos_presenter';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const absent = new Proxy({}, { get: () => () => undefined }) as never;

const row = (id: string, stack: { id: string; size: number } | null = null): PhotoSummary =>
  ({ id, stack_id: stack?.id ?? null, stack_size: stack?.size ?? 1 }) as unknown as PhotoSummary;

const STACK = row('s', { id: 'st', size: 3 });
const MEMBERS = [row('m0', { id: 'st', size: 3 }), row('m1', { id: 'st', size: 3 })];

function build(sourced = true): PhotosPresenter {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const presenter = new PhotosPresenter(
    listing,
    marks,
    stacks,
    new ViewerStore(listing, stacks),
    absent,
    absent,
    absent,
    absent,
    {} as never,
    absent,
  );
  runInAction(() => {
    if (sourced) listing.source = { kind: 'library', libraryId: 'lib' };
    listing.total = 6;
    listing.rows = new Map(
      Array.from({ length: 6 }, (_, i) => [i, i === 4 ? STACK : row(`p${i}`)] as const),
    );
    stacks.expansions = new Map([['st', { stackId: 'st', position: 4, photos: MEMBERS }]]);
  });
  return presenter;
}

const at = (index: number): { kind: 'row'; index: number; photo: PhotoSummary } => ({
  kind: 'row',
  index,
  photo: index === 4 ? STACK : row(`p${index}`),
});

test('acts on the tile alone where it is not selected, leaving the selection be', () => {
  const presenter = build();
  presenter.toggle(0);

  expect(presenter.menuTarget(at(2))).toMatchObject({
    target: {
      selection: {
        scope: { kind: 'library', id: 'lib' },
        ranges: [{ start: 2, end: 2 }],
        members: [],
      },
    },
    count: 1,
    selected: false,
  });
});

test('counts the whole stack behind a stack tile', () => {
  expect(build().menuTarget(at(4))).toMatchObject({
    target: { selection: { ranges: [{ start: 4, end: 4 }] } },
    count: 3,
  });
});

test('names a band member by id, having no position', () => {
  expect(build().menuTarget({ kind: 'member', photo: MEMBERS[1]! })).toMatchObject({
    target: { selection: { ranges: [], members: ['m1'] } },
    count: 1,
    selected: false,
  });
});

test('acts on the whole selection where the tile is in it', () => {
  const presenter = build();
  presenter.toggle(1);
  presenter.toggle(2);

  expect(presenter.menuTarget(at(2))).toMatchObject({
    target: { selection: { ranges: [{ start: 1, end: 2 }], members: [] } },
    count: 2,
    selected: true,
  });
});

test('acts on the selection from a selected band member', () => {
  const presenter = build();
  presenter.toggleMember(MEMBERS[0]!);
  presenter.toggle(1);

  expect(presenter.menuTarget({ kind: 'member', photo: MEMBERS[0]! })).toMatchObject({
    target: { selection: { ranges: [{ start: 1, end: 1 }], members: ['m0'] } },
    count: 2,
    selected: true,
  });
});

test('acts on nothing outside a collection', () => {
  expect(build(false).menuTarget(at(2))).toBeNull();
});
