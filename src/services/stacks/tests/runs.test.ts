// What detection is allowed to compare against what: a stretch of one shoot's
// shooting, and never two. The bug: two cards filed into a folder each stacked
// together, and the shoot holding the representative listed the band with the
// other member dimmed as being elsewhere - a grouping no gesture there could
// take apart.
import { expect, test } from 'bun:test';
import type { StackCandidate } from '../stacks_repository';
import { runs } from '../stacks_service';

const at = (id: string, timestamp: number, shootId: string | null): StackCandidate => ({ id, timestamp, shootId });
const ids = (split: StackCandidate[][]): string[][] => split.map((run) => run.map((candidate) => candidate.id));

test('a run ends at a gap wider than the window', () => {
  const split = runs([at('a', 0, null), at('b', 2, null), at('c', 60, null)], 10);
  expect(ids(split)).toEqual([['a', 'b'], ['c']]);
});

test('photographs seconds apart in different shoots are never compared', () => {
  const split = runs([at('a', 0, 'sh-a'), at('b', 1, 'sh-b'), at('c', 2, 'sh-a')], 10);
  expect(ids(split)).toEqual([['a', 'c'], ['b']]);
});

// A folder between two of them is not a gap: the shoot's own frames stay one run
// rather than being cut in three by whatever was interleaved with them.
test('the library root is a group of its own', () => {
  const split = runs([at('a', 0, null), at('b', 1, 'sh-a'), at('c', 2, null)], 10);
  expect(ids(split)).toEqual([
    ['a', 'c'],
    ['b'],
  ]);
});
