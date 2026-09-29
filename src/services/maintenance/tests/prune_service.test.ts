import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { activity, db, draft, prune, usingPruneService } from './prune_service_test_helpers';

usingPruneService();

/**
 * §4.4's seven days.
 *
 * A sweep of its own rather than the orphan one: a draft key is the frames it was carved from, so
 * it is never a live photo id and "is this id in the library" answers nothing about one.
 */
describe('PruneService.pruneDrafts', () => {
  it('says nothing about a library that has never carved anything', async () => {
    expect(await prune.pruneDrafts(7)).toEqual({ removed: 0, bytes: 0 });
  });

  it('clears pruning activity when the catalogue cannot be read', async () => {
    db.close();
    await expect(prune.prune()).rejects.toThrow();
    expect(activity.current(null)).toEqual([]);
  });

  // The ordinary sweep is about ids that are no longer photographs, and a draft key is not one -
  // so a fresh draft must survive it whatever the library holds.
  it('the orphan sweep leaves a draft alone', async () => {
    const dir = draft('0123456789abcdef');

    await prune.prune();

    expect(existsSync(dir)).toBe(true);
  });
});
