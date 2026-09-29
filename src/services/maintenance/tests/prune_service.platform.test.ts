import { describe, expect, it } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import path from 'node:path';
import { dataPathForLibraryId } from '../../../utils/paths';
import { activity, draft, LIB, prune, usingPruneService } from './prune_service_test_helpers';

usingPruneService();

describe('PruneService.pruneDrafts', () => {
  it('reaps a draft past the TTL and leaves a fresh one alone', async () => {
    const old = draft('0123456789abcdef');
    const fresh = draft('fedcba9876543210');
    // A carve that died before its volume was named leaves it loose beside the drafts.
    const loose = path.join(dataPathForLibraryId(LIB), 'drafts', '.volume-abc.bin');
    writeFileSync(loose, 'pending');
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    await utimes(loose, longAgo, longAgo);

    const pruning = prune.pruneDrafts(7);
    expect(activity.current(null)).toEqual([{ kind: 'pruning', count: 1 }]);
    const result = await pruning;
    expect(activity.current(null)).toEqual([]);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(loose)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result).toEqual({ removed: 2, bytes: 'x'.length + 'volume'.length + 'pending'.length });
  });
});
