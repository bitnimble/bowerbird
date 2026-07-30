// What a selection stands for once stacks are in it: the number beside it has to
// be the number of photographs the action will reach (§19.6.1).
import { expect, test } from 'bun:test';
import type { PhotoSummary } from '../../../api/client';
import { PhotosStore } from '../photos_store';
import { SelectionRanges } from '../selection';

const row = (id: string, stack: { id: string; size: number } | null = null): PhotoSummary =>
  ({ id, stack_id: stack?.id ?? null, stack_size: stack?.size ?? 1 }) as unknown as PhotoSummary;

function store(): PhotosStore {
  const built = new PhotosStore({} as never, { byId: new Map() } as never);
  built.total = 3;
  built.rows = new Map([
    [0, row('a')],
    [1, row('s', { id: 'stack-1', size: 3 })],
    [2, row('b')],
  ]);
  return built;
}

test('a stack row counts for every photograph in it', () => {
  const s = store();
  s.selection = SelectionRanges.of(0, 1);
  expect(s.selectionCount).toBe(4);
  expect(s.selectedEntries).toBe(2);
});

test('members of a selected stack are not counted twice', () => {
  const s = store();
  s.selection = SelectionRanges.of(1, 1);
  s.expansions = new Map([['stack-1', { stackId: 'stack-1', position: 1, photos: [row('m0'), row('m1'), row('m2')] }]]);
  s.selectedMembers = new Set(['m1']);
  expect(s.selectionCount).toBe(3);
});

test('members picked out of a band whose row is not selected count on their own', () => {
  const s = store();
  s.selection = SelectionRanges.of(0, 0);
  s.expansions = new Map([['stack-1', { stackId: 'stack-1', position: 1, photos: [row('m0'), row('m1'), row('m2')] }]]);
  s.selectedMembers = new Set(['m1']);
  expect(s.selectionCount).toBe(2);
});

test('rows the client is not holding count one apiece', () => {
  const s = store();
  s.selection = SelectionRanges.of(0, 9);
  expect(s.selectionCount).toBe(12);
});
