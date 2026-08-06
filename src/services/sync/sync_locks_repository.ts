import type { Database } from 'bun:sqlite';

// How long a lease stands without being refreshed. Long enough that a slow
// decode between two refresh points cannot lose the lock, short enough that a
// killed container's library is syncable again within a restart (§9.7).
export const LEASE_MS = 30_000;

// The cross-process "is this library syncing" claim (§9.7). A row rather than a
// file at the library root: it protects the catalogue, not the tree, so a
// read-only library needs no special case and a PID from another namespace never
// enters into it (§9.7).
export class SyncLocksRepository {
  constructor(private readonly db: Database) {}

  /**
   * Whether the lease was taken. `owner` is minted per acquire, not per process:
   * a per-process owner would let a run whose lease had lapsed delete its
   * successor's row on the way out.
   */
  acquire(libraryId: string, owner: string, now = new Date()): boolean {
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - LEASE_MS).toISOString();
    // One statement, so there is no check-then-claim window: SQLite's upsert is
    // the compare-and-swap, and a SELECT then INSERT in a deferred transaction
    // could not be.
    return (
      this.db
        .query(
          `INSERT INTO sync_locks (library_id, owner, started_at, refreshed_at)
           VALUES (?1, ?2, ?3, ?3)
           ON CONFLICT(library_id) DO UPDATE SET
             owner = excluded.owner, started_at = excluded.started_at, refreshed_at = excluded.refreshed_at
           WHERE sync_locks.refreshed_at < ?4`,
        )
        .run(libraryId, owner, nowIso, staleBefore).changes > 0
    );
  }

  // Owner-scoped, so a stalled holder cannot resurrect a lock somebody took over.
  refresh(libraryId: string, owner: string, now = new Date()): void {
    this.db
      .query('UPDATE sync_locks SET refreshed_at = ? WHERE library_id = ? AND owner = ?')
      .run(now.toISOString(), libraryId, owner);
  }

  // Owner-scoped, so a late `finally` cannot delete a successor's lock.
  release(libraryId: string, owner: string): void {
    this.db.query('DELETE FROM sync_locks WHERE library_id = ? AND owner = ?').run(libraryId, owner);
  }

  ownerOf(libraryId: string): string | null {
    const row = this.db.query('SELECT owner FROM sync_locks WHERE library_id = ?').get(libraryId) as { owner: string } | null;
    return row?.owner ?? null;
  }
}
