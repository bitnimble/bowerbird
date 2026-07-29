import { describe, expect, test } from 'bun:test';
import { type IndexSample, SelectionRanges, rebase } from '../selection';

const ranges = (selection: SelectionRanges): [number, number][] => selection.ranges.map((r) => [r.start, r.end]);

describe('add', () => {
  test('a whole library is one range', () => {
    const all = SelectionRanges.of(0, 99_999);
    expect(ranges(all)).toEqual([[0, 99_999]]);
    expect(all.size).toBe(100_000);
  });

  test('coalesces runs that touch, so a range never fragments as it grows', () => {
    let selection = SelectionRanges.EMPTY;
    for (let i = 0; i < 1000; i++) selection = selection.add(i, i);
    expect(ranges(selection)).toEqual([[0, 999]]);
    expect(selection.size).toBe(1000);
  });

  test('keeps runs with a gap between them apart', () => {
    const selection = SelectionRanges.EMPTY.add(0, 4).add(6, 9);
    expect(ranges(selection)).toEqual([
      [0, 4],
      [6, 9],
    ]);
    expect(selection.size).toBe(9);
  });

  test('stays sorted whatever order the runs arrive in', () => {
    const selection = SelectionRanges.EMPTY.add(20, 24).add(0, 4).add(10, 14);
    expect(ranges(selection)).toEqual([
      [0, 4],
      [10, 14],
      [20, 24],
    ]);
  });

  test('a run spanning several swallows them all', () => {
    const selection = SelectionRanges.EMPTY.add(0, 4).add(10, 14).add(20, 24).add(2, 22);
    expect(ranges(selection)).toEqual([[0, 24]]);
  });

  test('an empty range changes nothing', () => {
    const selection = SelectionRanges.of(0, 9);
    expect(selection.add(5, 4)).toBe(selection);
  });
});

describe('remove', () => {
  test('cutting the middle leaves both ends', () => {
    expect(ranges(SelectionRanges.of(0, 9).remove(4, 5))).toEqual([
      [0, 3],
      [6, 9],
    ]);
  });

  test('cutting an end shortens the run', () => {
    expect(ranges(SelectionRanges.of(0, 9).remove(0, 3))).toEqual([[4, 9]]);
    expect(ranges(SelectionRanges.of(0, 9).remove(7, 20))).toEqual([[0, 6]]);
  });

  test('cutting everything leaves nothing', () => {
    const empty = SelectionRanges.of(0, 99_999).remove(0, 99_999);
    expect(ranges(empty)).toEqual([]);
    expect(empty.size).toBe(0);
  });
});

describe('has', () => {
  test('answers for every position across many runs', () => {
    const selection = SelectionRanges.EMPTY.add(0, 4).add(10, 14).add(20, 24);
    for (const inside of [0, 4, 10, 14, 20, 24]) expect(selection.has(inside)).toBe(true);
    for (const outside of [-1, 5, 9, 15, 19, 25]) expect(selection.has(outside)).toBe(false);
  });
});

describe('rebase', () => {
  // Positions 0..n of the old listing, mapped to where each still-present photo
  // sits now. `null` is a photo that went.
  const samples = (moved: (number | null)[]): IndexSample[] =>
    moved.flatMap((to, from) => (to == null ? [] : [{ from, to }]));

  test('an insert inside a selected run splits it around the new photo', () => {
    // A B C at 0,1,2, all selected; X arrives between A and B.
    const selection = SelectionRanges.of(0, 2);
    expect(ranges(rebase(selection, samples([0, 2, 3])))).toEqual([
      [0, 0],
      [2, 3],
    ]);
  });

  test('an insert before a selected run just shifts it', () => {
    expect(ranges(rebase(SelectionRanges.of(10, 20), samples([1, 2, 3])))).toEqual([[11, 21]]);
  });

  test('a removal inside a selected run drops that photo and closes the run', () => {
    // Eleven selected, the one at 5 is gone: ten remain, contiguous.
    const moved: (number | null)[] = [];
    for (let i = 0; i <= 10; i++) moved.push(i === 5 ? null : i < 5 ? i : i - 1);
    const rebased = rebase(SelectionRanges.of(0, 10), samples(moved));
    expect(ranges(rebased)).toEqual([[0, 9]]);
    expect(rebased.size).toBe(10);
  });

  test('several inserts break a run into as many pieces', () => {
    // Two photos arrive inside a run of five, at different places.
    expect(ranges(rebase(SelectionRanges.of(0, 4), samples([0, 2, 3, 5, 6])))).toEqual([
      [0, 0],
      [2, 3],
      [5, 6],
    ]);
  });

  test('leaves an untouched collection exactly as it was', () => {
    const selection = SelectionRanges.EMPTY.add(0, 4).add(10, 14);
    expect(ranges(rebase(selection, samples([0, 1, 2, 3, 4])))).toEqual([
      [0, 4],
      [10, 14],
    ]);
  });

  test('carries the nearest observed shift past the end of what was sampled', () => {
    // Only positions 0..2 were re-read; everything after them moved by the same
    // one place, which is the best answer available for a run reaching beyond.
    expect(ranges(rebase(SelectionRanges.of(0, 100), samples([1, 2, 3])))).toEqual([[1, 101]]);
  });

  test('drops the selection when nothing recognisable came back', () => {
    expect(rebase(SelectionRanges.of(0, 10), []).size).toBe(0);
  });

  test('a scattered selection keeps its holes', () => {
    const selection = SelectionRanges.EMPTY.add(0, 1).add(4, 5);
    // One photo arrives at position 2, after the first pair.
    expect(ranges(rebase(selection, samples([0, 1, 3, 4, 5, 6])))).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });
});

describe('toggle', () => {
  test('adds what is not selected and removes what is', () => {
    const one = SelectionRanges.EMPTY.toggle(7);
    expect(ranges(one)).toEqual([[7, 7]]);
    expect(ranges(one.toggle(7))).toEqual([]);
  });

  test('punching a hole in a whole-library selection costs one extra range', () => {
    const selection = SelectionRanges.of(0, 99_999).toggle(500);
    expect(ranges(selection)).toEqual([
      [0, 499],
      [501, 99_999],
    ]);
    expect(selection.size).toBe(99_999);
  });
});
