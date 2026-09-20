// Shift-click: a span of rows, a span of band members, and what a span crossing
// a stack stands for (§19.6.1).
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

const positions = (store: MarksStore): number[] =>
  store.selection.ranges.flatMap((range) => Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i));

// Ten rows, a stack of three at position 4, and its band open under it.
function build(): { listing: ListingStore; store: MarksStore; stacks: StacksStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const store = new MarksStore(listing, stacks);
  const viewer = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, store, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  const members = [row('m0', { id: 'st', size: 3 }), row('m1', { id: 'st', size: 3 }), row('m2', { id: 'st', size: 3 })];
  runInAction(() => {
    listing.total = 10;
    listing.rows = new Map(
      Array.from({ length: 10 }, (_, i) => [i, i === 4 ? row('s', { id: 'st', size: 3 }) : row(`p${i}`)] as const),
    );
    stacks.expansions = new Map([['st', { stackId: 'st', position: 4, photos: members }]]);
  });
  return { listing, store, stacks, presenter };
}

test('a shift-click selects everything between the last pick and this one', () => {
  const { store, presenter } = build();
  presenter.toggle(2);
  presenter.extendTo(6);
  expect(positions(store)).toEqual([2, 3, 4, 5, 6]);

  // And backwards, from the same anchor.
  presenter.toggle(8);
  presenter.extendTo(7);
  expect(positions(store)).toEqual([2, 3, 4, 5, 6, 7, 8]);
});

// Nothing toggled yet, so the cursor is the anchor - arrowing to a photo and
// shift-clicking another is the same gesture as in any file manager.
test('the cursor stands in for the anchor on a first shift-click', () => {
  const { store, presenter } = build();
  presenter.moveFocus(1);
  presenter.moveFocus(2);
  expect(store.focusIndex).toBe(2);
  presenter.extendTo(5);
  expect(positions(store)).toEqual([2, 3, 4, 5]);
});

// Unpicking one photo of a run and shift-clicking along it takes that stretch
// out, rather than putting back what was just removed.
test('a shift-click back from an unpicked photo unpicks the span', () => {
  const { store, presenter } = build();
  presenter.toggle(0);
  presenter.extendTo(9);
  expect(positions(store)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  presenter.toggle(3);
  presenter.extendTo(6);
  expect(positions(store)).toEqual([0, 1, 2, 7, 8, 9]);

  // And picking one again makes the anchor pick once more, from the same gesture.
  presenter.toggle(4);
  presenter.extendTo(5);
  expect(positions(store)).toEqual([0, 1, 2, 4, 5, 7, 8, 9]);
});

// A stack's row stands for every photograph under it (§19.6.1), so a span that
// crosses one is a span over its whole contents - three of the five here - and
// the band open under it has to draw them that way.
test('a span crossing a stack stands for every photograph in it', () => {
  const { store, stacks, presenter } = build();
  presenter.toggle(3);
  presenter.extendTo(5);
  expect(positions(store)).toEqual([3, 4, 5]);
  expect(store.selectionCount).toBe(5);
  for (const member of stacks.expansions.get('st')!.photos) expect(store.memberSelected(member)).toBe(true);
});

// Uncollapsed, a row is the photograph it shows and stands for nothing else
// (§19.5.4), which is what `stack_size` reports there.
test('an uncollapsed row does not stand for the stack it belongs to', () => {
  const { listing, store, stacks, presenter } = build();
  runInAction(() => (listing.rows = new Map([[4, row('s', { id: 'st', size: 1 })]])));
  presenter.toggle(4);
  expect(store.memberSelected(stacks.expansions.get('st')!.photos[0]!)).toBe(false);
});

// Taking one member off a selected stack has to leave the other two chosen,
// which a run over the row alone cannot say - so the row becomes its members.
test('unpicking a member of a selected stack leaves the rest of it picked', () => {
  const { store, stacks, presenter } = build();
  const [, m1] = stacks.expansions.get('st')!.photos;
  presenter.toggle(4);

  presenter.toggleMember(m1!);
  expect(positions(store)).toEqual([]);
  expect([...store.selectedMembers].sort()).toEqual(['m0', 'm2']);
  expect(store.selectionCount).toBe(2);
});

test('a shift-click inside a band selects the run of members between', () => {
  const { store, stacks, presenter } = build();
  const [m0, m1, m2] = stacks.expansions.get('st')!.photos;
  presenter.toggleMember(m0!);
  presenter.extendMembersTo(m2!);
  expect([...store.selectedMembers]).toEqual(['m0', 'm1', 'm2']);

  // And unpicks a run back from an unpicked member, as the grid does.
  presenter.toggleMember(m2!);
  presenter.extendMembersTo(m1!);
  expect([...store.selectedMembers]).toEqual(['m0']);

  // With nothing in this band to reach back to it is an ordinary pick - and Clear
  // drops the anchor as it drops the one over positions, band still open or not.
  presenter.clearSelection();
  presenter.extendMembersTo(m1!);
  expect([...store.selectedMembers]).toEqual(['m1']);
});
