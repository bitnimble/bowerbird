import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import { acquireSyncLock, releaseSyncLock } from '../sync_lock';

const LOCK = '.bowerbird-sync.lock';

function withRoot(run: (root: string) => void) {
  return () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-lock-'));
    try {
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('sync lock', () => {
  it('acquires, blocks a second acquire with SYNC_IN_PROGRESS, and releases', withRoot((root) => {
    const lockPath = acquireSyncLock(root);
    expect(existsSync(path.join(root, LOCK))).toBe(true);

    expect(() => acquireSyncLock(root)).toThrow(AppError);
    try {
      acquireSyncLock(root);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('SYNC_IN_PROGRESS');
    }

    releaseSyncLock(lockPath);
    expect(existsSync(path.join(root, LOCK))).toBe(false);

    // free again after release
    releaseSyncLock(acquireSyncLock(root));
  }));

  it('reclaims a stale lock whose owner PID is dead', withRoot((root) => {
    writeFileSync(path.join(root, LOCK), JSON.stringify({ pid: 2147483646, startedAt: '2020-01-01T00:00:00.000Z' }));
    const lockPath = acquireSyncLock(root); // dead PID -> reclaimed
    expect(existsSync(lockPath)).toBe(true);
    releaseSyncLock(lockPath);
  }));

  it('is independent per library root (two roots lock concurrently)', () => {
    const a = mkdtempSync(path.join(tmpdir(), 'bb-lock-'));
    const b = mkdtempSync(path.join(tmpdir(), 'bb-lock-'));
    try {
      const la = acquireSyncLock(a);
      const lb = acquireSyncLock(b); // different root: not blocked
      releaseSyncLock(la);
      releaseSyncLock(lb);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
