import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';

const LOCK_NAME = '.bowerbird-sync.lock';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerPid(lockPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'pid' in parsed) {
      const pid = (parsed as { pid: unknown }).pid;
      return typeof pid === 'number' ? pid : null;
    }
  } catch {
    // unreadable/corrupt lock: treat as stale
  }
  return null;
}

// Acquires the per-library sync lock (file at the library root). Reclaims a stale
// lock whose owner PID is dead; otherwise throws SYNC_IN_PROGRESS. See DESIGN §9.7.
export function acquireSyncLock(rootPath: string): string {
  const lockPath = path.join(rootPath, LOCK_NAME);

  if (existsSync(lockPath)) {
    const pid = ownerPid(lockPath);
    if (pid != null && pidAlive(pid)) {
      throw new AppError('SYNC_IN_PROGRESS', `a sync is already running for this library (pid ${pid})`);
    }
    try {
      unlinkSync(lockPath); // stale
    } catch (err) {
      // A racer may have reclaimed it first; that's fine, openSync('wx') below
      // settles who wins. Any other error is real.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  let fd: number;
  try {
    fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
  } catch {
    // Lost a race to create the lock.
    throw new AppError('SYNC_IN_PROGRESS', 'a sync is already running for this library');
  }
  // finally so the fd is closed even if writeSync throws (e.g. ENOSPC while the
  // very sync this guards is filling the disk with thumbnails), otherwise a
  // persistent low-disk condition leaks one fd per attempt up to the ulimit.
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return lockPath;
}

export function releaseSyncLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}
