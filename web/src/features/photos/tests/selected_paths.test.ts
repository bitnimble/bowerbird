// What the Bin's Restore button reads to decide whether the server will refuse
// (§12): the paths of the selected rows this client is holding. A sample rather
// than the answer, because a selection reaches rows that were never loaded.
import { expect, test } from 'bun:test';
import type { PhotoSummary } from '../../../api/client';
import { PhotosStore } from '../photos_store';
import { SelectionRanges } from '../selection';

const row = (id: string, file_path: string): PhotoSummary =>
  ({ id, file_path, stack_id: null, stack_size: 1 }) as unknown as PhotoSummary;

function store(): PhotosStore {
  const built = new PhotosStore({} as never, { byId: new Map() } as never);
  built.total = 3;
  built.rows = new Map([
    [0, row('a', 'Bin/Trip/a.arw')],
    [1, row('b', 'Trip/b.arw')],
    [2, row('c', 'Bin/c.arw')],
  ]);
  return built;
}

test('answers for the selected rows and no others', () => {
  const s = store();
  s.selection = SelectionRanges.of(1, 2);
  expect(s.selectedLoadedPaths.sort()).toEqual(['Bin/c.arw', 'Trip/b.arw']);
});

// A photograph picked out of an open stack is in the same selection as a tile.
test('includes members picked out of an open band', () => {
  const s = store();
  s.selection = SelectionRanges.of(0, 0);
  s.expansions = new Map([
    ['stack-1', { stackId: 'stack-1', position: 1, photos: [row('m0', 'Bin/m0.arw'), row('m1', 'Bin/m1.arw')] }],
  ]);
  s.selectedMembers = new Set(['m1']);
  expect(s.selectedLoadedPaths.sort()).toEqual(['Bin/Trip/a.arw', 'Bin/m1.arw']);
});

// The reason the guard it feeds only ever disables and never enables: a
// selection over rows this client has never held says nothing about them, and a
// button disabled on that would block an action the server would have allowed.
test('says nothing about rows the client is not holding', () => {
  const s = store();
  s.rows = new Map();
  s.selection = SelectionRanges.of(0, 2);
  expect(s.selectedLoadedPaths).toEqual([]);
});
