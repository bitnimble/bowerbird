import { expect, it } from 'bun:test';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  built,
  limit,
  photo,
  renditions,
  usingDiskSpaceLimit,
} from './disk_space_limit_test_helpers';

usingDiskSpaceLimit('disk-space-limit-platform-test');

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'keeps a copy it could not delete as a candidate, and evicts the next one instead',
  async () => {
    photo('p1');
    const locked = built('p1', 'max', 100, '2026-01-01T00:00:00.000Z');
    const full = built('p1', 'full', 100, '2026-01-02T00:00:00.000Z');
    chmodSync(path.dirname(locked), 0o555);
    try {
      expect(await limit.enforce(0)).toBe(100);
    } finally {
      chmodSync(path.dirname(locked), 0o755);
    }

    expect(existsSync(locked)).toBe(true);
    expect(existsSync(full)).toBe(false);
    expect(renditions.leastRecentlyUsed(10).map((copy) => copy.variant)).toEqual(['max']);
  },
);
