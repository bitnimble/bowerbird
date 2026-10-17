import { expect, test } from 'bun:test';
import { warmBudget, warmedRun } from '../warm_budget';

const RUN = ['a', 'b', 'c', 'd', 'e'];

test('an unknown or large memory warms the whole run, keeps every rendition, and fits at 4096', () => {
  for (const memoryGb of [undefined, 8]) {
    const budget = warmBudget(memoryGb);
    expect(budget.otherRenditions).toBe(true);
    expect(budget.fittedToScreen).toBe(false);
    expect(warmedRun(RUN, 'c', 'next', budget.neighbours)).toEqual(RUN);
  }
});

test('a small memory warms the likeliest steps first: next, then back, then further on', () => {
  expect(warmedRun(RUN, 'c', 'next', 1)).toEqual(['c', 'd']);
  expect(warmedRun(RUN, 'c', 'next', 2)).toEqual(['b', 'c', 'd']);
  expect(warmedRun(RUN, 'c', 'next', 3)).toEqual(['b', 'c', 'd', 'e']);
});

test('stepping backwards, the next step is the one before', () => {
  expect(warmedRun(RUN, 'c', 'prev', 1)).toEqual(['b', 'c']);
  expect(warmedRun(RUN, 'c', 'prev', 2)).toEqual(['b', 'c', 'd']);
});

test('the budget shrinks with memory, down to nothing warmed', () => {
  expect(warmBudget(4)).toEqual({ neighbours: 2, otherRenditions: true, fittedToScreen: true });
  expect(warmBudget(2)).toEqual({ neighbours: 1, otherRenditions: false, fittedToScreen: true });
  expect(warmBudget(1)).toEqual({ neighbours: 0, otherRenditions: false, fittedToScreen: true });
  expect(warmedRun(RUN, 'c', 'next', 0)).toEqual(['c']);
});

test('a photo outside the run is held alone', () => {
  expect(warmedRun(RUN, 'z', 'next', Infinity)).toEqual(['z']);
});
