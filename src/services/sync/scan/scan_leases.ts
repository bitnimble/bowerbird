import { AppError } from '../../../errors';
import { newId } from '../../../schemas/id';
import type { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import { LEASE_REFRESH_MS, type SyncLocksRepository } from '../coordination/sync_locks_repository';

export class ScanLeases {
  private readonly generation = new Map<string, AbortController>();

  constructor(
    private readonly photoScan: PhotoScanRepository,
    private readonly syncLocks: SyncLocksRepository,
  ) {}

  acquire(libraryId: string): string {
    const owner = newId();
    if (!this.syncLocks.acquire(libraryId, owner)) {
      throw new AppError('SYNC_IN_PROGRESS', 'a scan is already running for this library');
    }
    return owner;
  }

  release(libraryId: string, owner: string): void {
    this.syncLocks.release(libraryId, owner);
  }

  expiresAt(libraryId: string): Date | null {
    return this.syncLocks.expiresAt(libraryId);
  }

  begin(libraryId: string): AbortController {
    const token = new AbortController();
    this.generation.set(libraryId, token);
    return token;
  }

  current(libraryId: string): AbortController | undefined {
    return this.generation.get(libraryId);
  }

  isCurrent(libraryId: string, token: AbortController): boolean {
    return this.generation.get(libraryId) === token;
  }

  abort(libraryId: string): void {
    this.generation.get(libraryId)?.abort();
  }

  clear(libraryId: string): void {
    this.generation.get(libraryId)?.abort();
    this.generation.delete(libraryId);
  }

  stopped(libraryId: string): boolean {
    return this.generation.get(libraryId)?.signal.aborted === true;
  }

  // Keeps this run's lease alive across a stretch of synchronous work, throttled
  // so a per-file call costs a clock read (§9.7).
  keeper(libraryId: string, owner: string): () => void {
    let refreshedAt = Date.now();
    return () => {
      const now = Date.now();
      if (now - refreshedAt < LEASE_REFRESH_MS) return;
      refreshedAt = now;
      this.syncLocks.refresh(libraryId, owner, new Date(now));
    };
  }

  // The fifth blocking stretch, and the only one where a timer is the right
  // instrument: the lease is taken before `libraryMutex` (§9.9), and waiting for
  // it is genuinely idle. Left uncovered, the run's lease lapses in the queue,
  // a second scan takes it, and this one throws its completed scan away.
  holdWhileQueued(libraryId: string, owner: string): () => void {
    const timer = setInterval(() => this.syncLocks.refresh(libraryId, owner), LEASE_REFRESH_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Apply re-reads the owner as its first statement and rolls back on a mismatch.
  // `immediateTransaction` avoids a deferred read snapshot failing its first write
  // with SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry.
  applyOwned<T>(libraryId: string, owner: string, fn: () => T): T {
    return this.photoScan.immediateTransaction(() => {
      if (this.syncLocks.ownerOf(libraryId) !== owner) {
        throw new AppError('SYNC_IN_PROGRESS', 'this scan lost its lease to a newer run');
      }
      return fn();
    });
  }
}
