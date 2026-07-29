/** A run of selected positions in a collection. Both ends inclusive. */
export interface SelectionRange {
  start: number;
  end: number;
}

/**
 * Which positions in a collection are selected, as sorted, non-overlapping,
 * non-touching runs.
 *
 * Positions rather than ids, because positions are what a client holding only a
 * window of the collection has for the rest of it (§18.3.2) - and runs rather
 * than one entry per photo, because "everything in this library" is a selection
 * a photographer makes constantly and it should cost one pair of numbers, not
 * two hundred thousand. A scattered pick degrades to a range per photo, which is
 * the worst case and still no worse than the set of ids it replaces.
 *
 * Immutable, so the store can hold one by reference: a selection change is then
 * a single notification rather than one per photo touched.
 */
export class SelectionRanges {
  static readonly EMPTY = new SelectionRanges([]);

  /** How many photos are selected. */
  readonly size: number;

  private constructor(readonly ranges: readonly SelectionRange[]) {
    this.size = ranges.reduce((total, range) => total + range.end - range.start + 1, 0);
  }

  static of(start: number, end: number): SelectionRanges {
    return end < start ? SelectionRanges.EMPTY : new SelectionRanges([{ start, end }]);
  }

  has(index: number): boolean {
    let low = 0;
    let high = this.ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = this.ranges[mid]!;
      if (index < range.start) high = mid - 1;
      else if (index > range.end) low = mid + 1;
      else return true;
    }
    return false;
  }

  add(start: number, end: number): SelectionRanges {
    if (end < start) return this;
    const merged: SelectionRange[] = [];
    let pending: SelectionRange | null = { start, end };
    for (const range of this.ranges) {
      // Touching counts as overlapping: [0,4] and [5,9] describe one run of ten,
      // and left as two they would never coalesce however much was selected.
      if (pending == null || range.end + 1 < pending.start) {
        merged.push(range);
      } else if (range.start > pending.end + 1) {
        merged.push(pending, range);
        pending = null;
      } else {
        pending = { start: Math.min(pending.start, range.start), end: Math.max(pending.end, range.end) };
      }
    }
    if (pending != null) merged.push(pending);
    return new SelectionRanges(merged);
  }

  remove(start: number, end: number): SelectionRanges {
    if (end < start) return this;
    const kept: SelectionRange[] = [];
    for (const range of this.ranges) {
      if (range.end < start || range.start > end) {
        kept.push(range);
        continue;
      }
      // A cut through the middle of a run leaves the two ends behind.
      if (range.start < start) kept.push({ start: range.start, end: start - 1 });
      if (range.end > end) kept.push({ start: end + 1, end: range.end });
    }
    return new SelectionRanges(kept);
  }

  toggle(index: number): SelectionRanges {
    return this.has(index) ? this.remove(index, index) : this.add(index, index);
  }
}

/** Where a photo that is still there sits now, against where it sat before. */
export interface IndexSample {
  from: number;
  to: number;
}

/**
 * The same photographs, re-expressed against a collection whose positions have
 * moved - which is what a scan inserting rows under an open gallery does.
 *
 * Insertions show up as the shift stepping up, which **splits** a selected run
 * so the photo that appeared inside it is not selected: three photos selected
 * and one inserted between the first and the second leaves `{1} ∪ {3,4}`, not a
 * run of four. Removals show up as the shift stepping down, which drops the
 * photo that went and closes the run over it.
 *
 * Empty when nothing recognisable survived: with no samples there is nothing to
 * re-express against, and a guess would put the ring on photographs the reader
 * never chose.
 */
export function rebase(selection: SelectionRanges, samples: readonly IndexSample[]): SelectionRanges {
  if (selection.size === 0 || samples.length === 0) return SelectionRanges.EMPTY;
  // One entry per *change* of shift rather than per photo: a block of a hundred
  // rows that all moved by the same amount is one step, so this stays the size
  // of the edit rather than the size of the window.
  const steps: { from: number; shift: number }[] = [];
  for (const sample of [...samples].sort((a, b) => a.from - b.from)) {
    const shift = sample.to - sample.from;
    if (steps.at(-1)?.shift !== shift) steps.push({ from: sample.from, shift });
  }

  let rebased = SelectionRanges.EMPTY;
  for (const { start, end } of selection.ranges) {
    let at = start;
    // The step governing `at`: the last one starting at or before it, or the
    // first of all for positions below every sample. Outside the sampled span
    // there is nothing better to carry than the nearest shift observed.
    let step = 0;
    while (step + 1 < steps.length && steps[step + 1]!.from <= at) step++;
    while (at <= end) {
      const until = step + 1 < steps.length ? Math.min(end, steps[step + 1]!.from - 1) : end;
      rebased = rebased.add(at + steps[step]!.shift, until + steps[step]!.shift);
      at = until + 1;
      step++;
    }
  }
  return rebased;
}
