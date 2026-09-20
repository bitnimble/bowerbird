// What a selection stands for once stacks are in it: the number beside it has to
// be the number of photographs the action will reach (§19.6.1).
import { expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';

const row = (
  id: string,
  stack: { id: string; size: number } | null = null,
  marks: { triage?: string; rating?: number; shoot?: string | null } = {},
): PhotoSummary =>
  ({
    id,
    stack_id: stack?.id ?? null,
    stack_size: stack?.size ?? 1,
    triage: marks.triage ?? 'untriaged',
    rating: marks.rating ?? 0,
    shoot_id: marks.shoot ?? null,
  }) as unknown as PhotoSummary;

function stores() {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  listing.total = 3;
  listing.rows = new Map([
    [0, row('a')],
    [1, row('s', { id: 'stack-1', size: 3 })],
    [2, row('b')],
  ]);
  return { listing, marks, stacks };
}

test('a stack row counts for every photograph in it', () => {
  const { marks: s } = stores();
  s.selection = SelectionRanges.of(0, 1);
  expect(s.selectionCount).toBe(4);
  expect(s.selectedEntries).toBe(2);
});

test('members of a selected stack are not counted twice', () => {
  const { marks: s, stacks } = stores();
  s.selection = SelectionRanges.of(1, 1);
  stacks.expansions = new Map([['stack-1', { stackId: 'stack-1', position: 1, photos: [row('m0'), row('m1'), row('m2')] }]]);
  s.selectedMembers = new Set(['m1']);
  expect(s.selectionCount).toBe(3);
});

test('members picked out of a band whose row is not selected count on their own', () => {
  const { marks: s, stacks } = stores();
  s.selection = SelectionRanges.of(0, 0);
  stacks.expansions = new Map([['stack-1', { stackId: 'stack-1', position: 1, photos: [row('m0'), row('m1'), row('m2')] }]]);
  s.selectedMembers = new Set(['m1']);
  expect(s.selectionCount).toBe(2);
});

test('rows the client is not holding count one apiece', () => {
  const { marks: s } = stores();
  s.selection = SelectionRanges.of(0, 9);
  expect(s.selectionCount).toBe(12);
});

// What the bulk bar's verdict and stars light up from, and so what pressing one
// would clear rather than set.
test('the marks are the selection\'s only where every photograph in it carries the same one', () => {
  const { listing, marks: s } = stores();
  listing.rows = new Map([
    [0, row('a', null, { triage: 'picked', rating: 3 })],
    [1, row('b', null, { triage: 'picked', rating: 3 })],
    [2, row('c', null, { triage: 'rejected', rating: 3 })],
  ]);

  s.selection = SelectionRanges.of(0, 1);
  expect(s.selectedMarks).toEqual({ triage: 'picked', rating: 3 });

  // One disagrees, so neither control is lit and pressing either sets.
  s.selection = SelectionRanges.of(0, 2);
  expect(s.selectedMarks).toEqual({ triage: null, rating: 3 });
});

// The one place a sample of the loaded rows is not good enough: "select all" over
// a library would light the verdict off the screenful the client holds, and
// pressing it would clear it on every photograph the client has never seen.
test('the marks say nothing when the selection reaches rows this client is not holding', () => {
  const { listing, marks: s } = stores();
  listing.rows = new Map([[0, row('a', null, { triage: 'picked', rating: 3 })]]);
  s.selection = SelectionRanges.of(0, 9);
  expect(s.selectedMarks).toEqual({ triage: null, rating: null });
});

test('a member picked out of a band carries its marks into the answer', () => {
  const { listing, marks: s, stacks } = stores();
  listing.rows = new Map([[0, row('a', null, { triage: 'picked', rating: 2 })]]);
  s.selection = SelectionRanges.of(0, 0);
  stacks.expansions = new Map([
    ['stack-1', { stackId: 'stack-1', position: 1, photos: [row('m0', null, { triage: 'picked', rating: 5 })] }],
  ]);
  s.selectedMembers = new Set(['m0']);
  expect(s.selectedMarks).toEqual({ triage: 'picked', rating: null });
});

// When "Remove from this shoot" is offered. A shoot lists the whole of a stack
// that reaches out of it, so a band member filed elsewhere is a selection the
// shoot holds nothing of, and the request would name only ids the server
// declines.
test('a selection of nothing this shoot holds is not offered a removal from it', () => {
  const { listing, marks: s } = stores();
  listing.source = { kind: 'shoot', shootId: 'sh-a' };
  listing.total = 2;
  listing.rows = new Map([
    [0, row('a', null, { shoot: 'sh-a' })],
    [1, row('b', null, { shoot: 'sh-b' })],
  ]);

  s.selection = SelectionRanges.of(1, 1);
  expect(s.selectionOutsideShoot).toBe(true);

  s.selection = SelectionRanges.of(0, 1);
  expect(s.selectionOutsideShoot).toBe(false);
});

test('a selection reaching rows this client is not holding keeps the removal offered', () => {
  const { listing, marks: s } = stores();
  listing.source = { kind: 'shoot', shootId: 'sh-a' };
  listing.rows = new Map([[1, row('b', null, { shoot: 'sh-b' })]]);
  s.selection = SelectionRanges.of(0, 9);
  expect(s.selectionOutsideShoot).toBe(false);
});

// Whether filing the selection into a shoot reads as an add or a move.
test('a photograph already in a shoot makes the menu a move', () => {
  const { listing, marks: s } = stores();
  listing.rows = new Map([
    [0, row('a')],
    [1, row('b', null, { shoot: 'sh-b' })],
  ]);

  s.selection = SelectionRanges.of(0, 0);
  expect(s.selectionInAShoot).toBe(false);

  s.selection = SelectionRanges.of(0, 1);
  expect(s.selectionInAShoot).toBe(true);
});

// Which shoot the filing submenu leaves out. A shoot the whole selection is
// already in is not somewhere it can be moved to, and a library's grid holds such
// a selection as readily as that shoot's own page does.
test('a selection wholly inside one shoot names it', () => {
  const { listing, marks: s } = stores();
  listing.total = 2;
  s.selection = SelectionRanges.of(0, 1);

  listing.rows = new Map([
    [0, row('a', null, { shoot: 'sh-a' })],
    [1, row('b', null, { shoot: 'sh-a' })],
  ]);
  expect(s.selectionShootId).toBe('sh-a');

  // One of them is filed elsewhere, so neither shoot is a move to nowhere.
  listing.rows = new Map([
    [0, row('a', null, { shoot: 'sh-a' })],
    [1, row('b', null, { shoot: 'sh-b' })],
  ]);
  expect(s.selectionShootId).toBeNull();

  listing.rows = new Map([
    [0, row('a')],
    [1, row('b')],
  ]);
  expect(s.selectionShootId).toBeNull();
});

test('a selection reaching rows this client is not holding names no shoot', () => {
  const { listing, marks: s } = stores();
  listing.rows = new Map([[0, row('a', null, { shoot: 'sh-a' })]]);
  s.selection = SelectionRanges.of(0, 9);
  expect(s.selectionShootId).toBeNull();
});

// Filing a stack's members somewhere is an ordinary thing to do, and they reach
// this the same way a row does - through `selectedLoadedPhotos`.
test('band members name the shoot they are all in', () => {
  const { marks: s, stacks } = stores();
  s.selection = SelectionRanges.EMPTY;
  stacks.expansions = new Map([
    [
      'stack-1',
      {
        stackId: 'stack-1',
        position: 1,
        photos: [row('m0', null, { shoot: 'sh-a' }), row('m1', null, { shoot: 'sh-a' })],
      },
    ],
  ]);

  s.selectedMembers = new Set(['m0', 'm1']);
  expect(s.selectionShootId).toBe('sh-a');

  // One member, which is the commonest selection of the lot.
  s.selectedMembers = new Set(['m0']);
  expect(s.selectionShootId).toBe('sh-a');
});

// When Unstack is offered. Only the rows this client is holding can be asked, so
// this is a sample - the server takes apart whatever the selection reaches.
test('a stack in the selection is what offers Unstack', () => {
  const { listing, marks: s } = stores();
  s.selection = SelectionRanges.of(0, 0);
  expect(s.hasSelectedStack).toBe(false);

  s.selection = SelectionRanges.of(0, 2);
  expect(s.hasSelectedStack).toBe(true);

  // Uncollapsed, a row is the photograph rather than the stack it is in
  // (§19.5.4), so there is no stack in the listing to unmake.
  listing.expandStacks = true;
  expect(s.hasSelectedStack).toBe(false);
});

// What "Triage this stack" is offered for, and what the greyed row says instead
// of it: a session is over one stack, whole.
test('a single whole stack is what triage is offered for', () => {
  const { listing, marks: s } = stores();

  s.selection = SelectionRanges.of(0, 0);
  expect(s.selectedStack).toEqual({ kind: 'none' });

  s.selection = SelectionRanges.of(1, 1);
  expect(s.selectedStack).toEqual({ kind: 'stack', stackId: 'stack-1' });

  // The stack, and a photograph beside it.
  s.selection = SelectionRanges.of(0, 1);
  expect(s.selectedStack).toEqual({ kind: 'extra' });

  s.selection = SelectionRanges.of(1, 1);
  listing.expandStacks = true;
  expect(s.selectedStack).toEqual({ kind: 'none' });
});

// The same refusal `selectedMarks` makes, and for the same reason: off a screenful
// of a Select all, the stacks in the rows nobody has held say nothing.
test('a selection reaching rows this client is not holding is not one stack', () => {
  const { marks: s } = stores();
  s.selection = SelectionRanges.of(0, 9);
  expect(s.selectedStack).toEqual({ kind: 'extra' });
});

test('two stacks are not one stack', () => {
  const { listing, marks: s } = stores();
  listing.total = 2;
  listing.rows = new Map([
    [0, row('s1', { id: 'stack-1', size: 2 })],
    [1, row('s2', { id: 'stack-2', size: 2 })],
  ]);
  s.selection = SelectionRanges.of(0, 1);
  expect(s.selectedStack).toEqual({ kind: 'extra' });
});

// Picked out of an open band a member stands only for itself, so the band is what
// says whether the whole stack is here.
test('a band is a stack only once every member of it is selected', () => {
  const { marks: s, stacks } = stores();
  s.selection = SelectionRanges.EMPTY;
  stacks.expansions = new Map([
    [
      'stack-1',
      {
        stackId: 'stack-1',
        position: 1,
        photos: [
          row('m0', { id: 'stack-1', size: 1 }),
          row('m1', { id: 'stack-1', size: 1 }),
          row('m2', { id: 'stack-1', size: 1 }),
        ],
      },
    ],
  ]);

  s.selectedMembers = new Set(['m0', 'm1']);
  expect(s.selectedStack).toEqual({ kind: 'partial' });

  s.selectedMembers = new Set(['m0', 'm1', 'm2']);
  expect(s.selectedStack).toEqual({ kind: 'stack', stackId: 'stack-1' });

  // A photograph beside it outweighs the band being short of members: what the
  // reader has to do first is drop the one that is not part of the stack.
  s.selection = SelectionRanges.of(0, 0);
  s.selectedMembers = new Set(['m0', 'm1']);
  expect(s.selectedStack).toEqual({ kind: 'extra' });
});

// Which photograph a shoot's or an album's thumbnail is set from. Rows arrive in
// whatever order the reader scrolled them into, so the map's own order is not it.
test('the banner is the first selected photograph in listing order', () => {
  const { listing, marks: s, stacks } = stores();
  listing.rows = new Map([
    [2, row('c')],
    [0, row('a')],
  ]);
  s.selection = SelectionRanges.of(0, 2);
  expect(s.firstSelectedPhotoId).toBe('a');

  // A member hangs off the row its stack sits at, which is above the row picked here.
  s.selection = SelectionRanges.of(2, 2);
  stacks.expansions = new Map([
    ['stack-1', { stackId: 'stack-1', position: 1, photos: [row('m0', { id: 'stack-1', size: 1 })] }],
  ]);
  s.selectedMembers = new Set(['m0']);
  expect(s.firstSelectedPhotoId).toBe('m0');
});

// Naming the lowest row this client happens to hold would set a thumbnail to a
// photograph nobody chose, which nothing on screen would report.
test('a selection whose first photograph was never loaded names none', () => {
  const { listing, marks: s } = stores();
  listing.rows = new Map([[2, row('c')]]);
  s.selection = SelectionRanges.of(0, 2);
  expect(s.firstSelectedPhotoId).toBeNull();

  // The rest of it being unloaded does not matter: only the first is being named.
  listing.rows = new Map([[0, row('a')]]);
  expect(s.firstSelectedPhotoId).toBe('a');
});
