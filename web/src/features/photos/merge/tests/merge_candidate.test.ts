import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../../grid/listing_store';
import { MarksStore } from '../../grid/marks_store';
import { StacksStore } from '../../grid/stacks_store';

function photo(id: string, overrides: Partial<PhotoSummary> = {}): PhotoSummary {
  return {
    id,
    library_id: 'lib1',
    shoot_id: null,
    file_path: `${id}.arw`,
    stack_id: null,
    stack_size: 1,
    composite_kind: null,
    ...overrides,
  } as PhotoSummary;
}

function storesWith(photos: PhotoSummary[]) {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  runInAction(() => {
    listing.source = { kind: 'library', libraryId: 'lib1' };
    listing.total = photos.length;
    marks.selection = SelectionRanges.of(0, photos.length - 1);
    photos.forEach((p, i) => listing.rows.set(i, p));
  });
  return { listing, marks, stacks };
}

test('fewer than two photographs refuses', () => {
  const { marks } = storesWith([photo('a')]);
  expect(marks.mergeCandidate).toEqual({ kind: 'tooFew' });
});

test('two or more, one library, no composite: ready, in listing order', () => {
  const { marks } = storesWith([photo('a'), photo('b'), photo('c')]);
  const candidate = marks.mergeCandidate;
  expect(candidate.kind).toBe('ready');
  expect(candidate.kind === 'ready' && candidate.frames.map((p) => p.id)).toEqual(['a', 'b', 'c']);
});

test('more than twelve refuses without needing every row loaded', () => {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  runInAction(() => {
    listing.source = { kind: 'library', libraryId: 'lib1' };
    listing.total = 13;
    marks.selection = SelectionRanges.of(0, 12);
    listing.rows.set(0, photo('a'));
    listing.rows.set(1, photo('b'));
  });
  expect(marks.mergeCandidate).toEqual({ kind: 'tooMany' });
});

test('two libraries refuses', () => {
  const { marks } = storesWith([photo('a', { library_id: 'lib1' }), photo('b', { library_id: 'lib2' })]);
  expect(marks.mergeCandidate).toEqual({ kind: 'mixedLibraries' });
});

test('a composite among the selection refuses', () => {
  const { marks } = storesWith([photo('a'), photo('b', { composite_kind: 'assembly' })]);
  expect(marks.mergeCandidate).toEqual({ kind: 'hasComposite' });
});

test('rows not yet loaded read as unresolved, not ready', () => {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  runInAction(() => {
    listing.source = { kind: 'library', libraryId: 'lib1' };
    listing.total = 3;
    marks.selection = SelectionRanges.of(0, 2);
    listing.rows.set(0, photo('a'));
  });
  expect(marks.mergeCandidate).toEqual({ kind: 'unresolved' });
});

// Picking a stack is picking what is in it (§19.6.1), which is the whole reason the merge menu can
// be reached from a stack tile at all: counted as the one row it is, a stack of three read as
// `tooFew` and the button was dead.
test('one stack tile is its frames, and enough of them to merge', () => {
  const { marks, stacks } = storesWith([photo('s', { stack_id: 'stack-1', stack_size: 3 })]);
  // Enough of them by `stack_size` alone, so not `tooFew` - but which frames they are is what
  // `PhotosPresenter` fetches, and until it has they cannot be named.
  expect(marks.mergeCandidate).toEqual({ kind: 'unresolved' });

  const members = [photo('m0'), photo('m1'), photo('m2')];
  runInAction(() => stacks.stackMembers.set('stack-1', members));
  const candidate = marks.mergeCandidate;
  expect(candidate.kind).toBe('ready');
  expect(candidate.kind === 'ready' && candidate.frames.map((p) => p.id)).toEqual(['m0', 'm1', 'm2']);
});

// The sample rule, through a stack: what a tile stands for is not known until the members are, and
// guessing would name a draft of the wrong frames.
test('a selected stack whose members are not held reads as unresolved', () => {
  const { marks } = storesWith([photo('a'), photo('s', { stack_id: 'stack-1', stack_size: 3 })]);
  expect(marks.mergeCandidate).toEqual({ kind: 'unresolved' });
});

// A stack past the ceiling refuses on its own, without a single member loaded - `stack_size` is on
// the row the reader clicked.
test('a stack bigger than the ceiling refuses before its members arrive', () => {
  const { marks } = storesWith([photo('s', { stack_id: 'stack-1', stack_size: 13 })]);
  expect(marks.mergeCandidate).toEqual({ kind: 'tooMany' });
});
