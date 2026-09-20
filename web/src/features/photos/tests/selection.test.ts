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
  // Everything the caller re-read, which is what it may speak for.
  const covering = (moved: (number | null)[]): SelectionRanges => SelectionRanges.of(0, moved.length - 1);

  test('an insert inside a selected run splits it around the new photo', () => {
    // A B C at 0,1,2, all selected; X arrives between A and B.
    const moved = [0, 2, 3];
    expect(ranges(rebase(SelectionRanges.of(0, 2), samples(moved), covering(moved)))).toEqual([
      [0, 0],
      [2, 3],
    ]);
  });

  test('an insert before a selected run just shifts it', () => {
    const moved = [1, 2, 3, ...Array.from({ length: 18 }, (_, i) => i + 4)];
    expect(ranges(rebase(SelectionRanges.of(10, 20), samples(moved), covering(moved)))).toEqual([[11, 21]]);
  });

  test('a removal inside a selected run drops that photo and closes the run', () => {
    // Eleven selected, the one at 5 is gone: ten remain, contiguous.
    const moved: (number | null)[] = [];
    for (let i = 0; i <= 10; i++) moved.push(i === 5 ? null : i < 5 ? i : i - 1);
    const rebased = rebase(SelectionRanges.of(0, 10), samples(moved), covering(moved));
    expect(ranges(rebased)).toEqual([[0, 9]]);
    expect(rebased.size).toBe(10);
  });

  // What a bulk verdict does: the photographs it marked leave the filtered view,
  // and they are the tail of the selection, so nothing selected follows them to
  // collide with the shift a run-walk would carry over the gap. Read as runs, the
  // selection came back the same size, sitting on the photographs that moved up.
  test('a removal at the end of a selected run leaves the run, not the photos that moved up', () => {
    // Ten selected at 40-49, all ten rejected out of the view.
    const moved: (number | null)[] = [];
    for (let i = 0; i < 100; i++) moved[i] = i < 40 ? i : i < 50 ? null : i - 10;
    const domain = covering(moved);
    expect(rebase(SelectionRanges.of(40, 49), samples(moved), domain).size).toBe(0);

    // And the half of a run that survives keeps only itself.
    expect(ranges(rebase(SelectionRanges.of(35, 49), samples(moved), domain))).toEqual([[35, 39]]);
  });

  // The same at the head of the listing, where a run-walk had nothing before it to
  // carry and produced negative positions - a selection the server's schema
  // refuses, so every action on it answered 400 until the reader hit Escape.
  test('a removal at the head of the listing leaves no selection at all', () => {
    const moved: (number | null)[] = [];
    for (let i = 0; i < 100; i++) moved[i] = i < 10 ? null : i - 10;
    const rebased = rebase(SelectionRanges.of(0, 9), samples(moved), covering(moved));
    expect(rebased.size).toBe(0);
    expect(ranges(rebased)).toEqual([]);
  });

  test('several inserts break a run into as many pieces', () => {
    // Two photos arrive inside a run of five, at different places.
    const moved = [0, 2, 3, 5, 6];
    expect(ranges(rebase(SelectionRanges.of(0, 4), samples(moved), covering(moved)))).toEqual([
      [0, 0],
      [2, 3],
      [5, 6],
    ]);
  });

  // Nothing observed moved, so the selection is not narrowed to the domain
  // either: a poll that finds the collection unchanged must leave it alone.
  test('leaves an untouched collection exactly as it was, domain or no domain', () => {
    const selection = SelectionRanges.EMPTY.add(0, 4).add(10_000, 14_000);
    expect(ranges(rebase(selection, samples([0, 1, 2, 3, 4]), SelectionRanges.of(0, 4)))).toEqual([
      [0, 4],
      [10_000, 14_000],
    ]);
  });

  test('drops the selection when nothing recognisable came back', () => {
    expect(rebase(SelectionRanges.of(0, 10), [], SelectionRanges.of(0, 10)).size).toBe(0);
  });

  test('a scattered selection keeps its holes', () => {
    const selection = SelectionRanges.EMPTY.add(0, 1).add(4, 5);
    // One photo arrives at position 2, after the first pair.
    const moved = [0, 1, 3, 4, 5, 6];
    expect(ranges(rebase(selection, samples(moved), covering(moved)))).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });

  // The three ways the old code claimed to know something it did not. Each one
  // renamed photographs the reader had chosen, which for a bulk action is the
  // one outcome worth losing part of a selection to avoid.

  test('says nothing about positions past the end of what was re-read', () => {
    // Only 0..2 were sampled; the rest of the run is unverifiable, not shifted.
    expect(ranges(rebase(SelectionRanges.of(0, 100), samples([1, 2, 3]), SelectionRanges.of(0, 2)))).toEqual([[1, 3]]);
  });

  test('does not drag a selection that sits below every sample', () => {
    // Viewport far down the collection, 200 photos removed above it, and one
    // photo selected at position 5 in a block that was evicted long ago. It
    // never moved, and the old code mapped it to -195.
    const moved: (number | null)[] = [];
    for (let i = 400; i < 500; i++) moved[i] = i - 200;
    const domain = SelectionRanges.of(400, 499);
    expect(rebase(SelectionRanges.of(5, 5), samples(moved), domain).size).toBe(0);
  });

  test('does not guess across a gap between two re-read blocks', () => {
    // Blocks 0 and 5 re-read, 1-4 not, one photo inserted at old position 250.
    // Read as one continuous sample set the split landed at 499 instead of 250,
    // selecting the arrival and deselecting the reader's photo at 499.
    const moved: (number | null)[] = [];
    for (let i = 0; i < 100; i++) moved[i] = i;
    for (let i = 500; i < 600; i++) moved[i] = i + 1;
    const domain = SelectionRanges.EMPTY.add(0, 99).add(500, 599);
    expect(ranges(rebase(SelectionRanges.of(0, 999), samples(moved), domain))).toEqual([
      [0, 99],
      [501, 600],
    ]);
  });
});

describe('intersect', () => {
  test('keeps only what is in both', () => {
    const a = SelectionRanges.EMPTY.add(0, 9).add(20, 29);
    const b = SelectionRanges.EMPTY.add(5, 22).add(27, 40);
    expect(ranges(a.intersect(b))).toEqual([
      [5, 9],
      [20, 22],
      [27, 29],
    ]);
  });

  test('is empty when they do not touch', () => {
    expect(SelectionRanges.of(0, 4).intersect(SelectionRanges.of(5, 9)).size).toBe(0);
    expect(SelectionRanges.of(0, 4).intersect(SelectionRanges.EMPTY).size).toBe(0);
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
