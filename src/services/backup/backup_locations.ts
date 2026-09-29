import type { Database } from '../../db/driver';
import {
  BackupCopyIssuesSchema,
  type BackupCoverage,
  type BackupIssue,
  type BackupPhase,
} from '../../schemas/backup';

// What each passive peer holds (docs/replication.md §14.2). `blob_locations`' opposite number, and
// unlike it a purely local table: a directory cannot assert anything about itself, so every row
// here is this device's own reading of a mount, and no other device could act on one.

export interface BackupEntry {
  photo_id: string;
  rel_path: string;
  content_hash: string;
  size: number;
  health: 'held' | 'missing' | 'changed';
}

export interface OwedOriginal {
  photo_id: string;
  rel_path: string;
}

/** A copy sitting somewhere the catalogue has since moved the photograph away from. */
export interface MisplacedCopy {
  photo_id: string;
  was_at: string;
  belongs_at: string;
}

export class BackupLocations {
  constructor(private readonly db: Database) {}

  entry(libraryId: string, peerId: string, photoId: string): BackupEntry | null {
    return this.db
      .query(
        `SELECT photo_id, rel_path, content_hash, size, health FROM backup_locations
          WHERE library_id = ? AND peer_id = ? AND photo_id = ?`,
      )
      .get(libraryId, peerId, photoId) as BackupEntry | null;
  }

  /** Every passive peer recorded as holding this photograph, which is where a fetch can come from. */
  holders(libraryId: string, photoId: string): string[] {
    return (
      this.db
        .query(
          "SELECT peer_id FROM backup_locations WHERE library_id = ? AND photo_id = ? AND health = 'held' ORDER BY peer_id",
        )
        .all(libraryId, photoId) as { peer_id: string }[]
    ).map((row) => row.peer_id);
  }

  /**
   * Records a copy that has been written and hashed.
   *
   * Only ever called after the bytes are in place on the mount and read back, for the reason
   * `blob_locations.record` gives: a row written earlier is a claim the cull would delete an
   * original on the strength of.
   */
  record(
    libraryId: string,
    peerId: string,
    photoId: string,
    relPath: string,
    contentHash: string,
    size: number,
  ): void {
    this.db
      .query(
        `INSERT INTO backup_locations (library_id, peer_id, photo_id, rel_path, content_hash, size, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (library_id, photo_id, peer_id) DO UPDATE SET rel_path = excluded.rel_path,
           content_hash = excluded.content_hash, size = excluded.size, checked_at = excluded.checked_at, health = 'held'`,
      )
      .run(libraryId, peerId, photoId, relPath, contentHash, size, new Date().toISOString());
  }

  /**
   * The copies this device has gone longest without looking at, for the scrub (§14.3).
   *
   * Bounded, and oldest first, because the point is that every copy is looked at eventually rather
   * than that all of them are looked at now: a mount answers a stat in milliseconds over a network
   * and a library holds tens of thousands of photographs, so the whole of it every quarter of an
   * hour is a pass that never ends.
   */
  stalest(libraryId: string, peerId: string, limit: number): BackupEntry[] {
    return this.db
      .query(
        `SELECT photo_id, rel_path, content_hash, size, health FROM backup_locations
          WHERE library_id = ? AND peer_id = ? ORDER BY checked_at, photo_id LIMIT ?`,
      )
      .all(libraryId, peerId, limit) as BackupEntry[];
  }

  unhealthy(libraryId: string, peerId: string): BackupEntry[] {
    return this.db
      .query(
        `SELECT photo_id, rel_path, content_hash, size, health FROM backup_locations
          WHERE library_id = ? AND peer_id = ? AND health <> 'held' ORDER BY photo_id`,
      )
      .all(libraryId, peerId) as BackupEntry[];
  }

  damageOf(libraryId: string, photoId: string): 'missing' | 'changed' | null {
    const row = this.db
      .query(
        "SELECT health FROM backup_locations WHERE library_id = ? AND photo_id = ? AND health <> 'held' ORDER BY health DESC LIMIT 1",
      )
      .get(libraryId, photoId) as { health: 'missing' | 'changed' } | null;
    return row?.health ?? null;
  }

  mark(libraryId: string, peerId: string, photoId: string, health: BackupEntry['health']): void {
    this.db
      .query(
        'UPDATE backup_locations SET checked_at = ?, health = ? WHERE library_id = ? AND peer_id = ? AND photo_id = ?',
      )
      .run(new Date().toISOString(), health, libraryId, peerId, photoId);
  }

  /** Where the copy now sits, after the pass has moved it to follow a rename or a bin (§14.3). */
  moved(libraryId: string, peerId: string, photoId: string, relPath: string): void {
    this.db
      .query(
        'UPDATE backup_locations SET rel_path = ? WHERE library_id = ? AND peer_id = ? AND photo_id = ?',
      )
      .run(relPath, libraryId, peerId, photoId);
    this.clearIssue(libraryId, peerId, photoId, 'moving');
  }

  issues(libraryId: string, peerId: string): BackupIssue[] {
    const rows = this.db
      .query(
        "SELECT current_issues FROM backup_locations WHERE library_id = ? AND peer_id = ? AND current_issues <> '[]' ORDER BY photo_id",
      )
      .all(libraryId, peerId) as { current_issues: string }[];
    return rows.flatMap((row) => BackupCopyIssuesSchema.parse(JSON.parse(row.current_issues)));
  }

  issuesFor(libraryId: string, peerId: string, photoId: string): BackupIssue[] {
    const row = this.db
      .query(
        'SELECT current_issues FROM backup_locations WHERE library_id = ? AND peer_id = ? AND photo_id = ?',
      )
      .get(libraryId, peerId, photoId) as { current_issues: string } | null;
    return row == null ? [] : BackupCopyIssuesSchema.parse(JSON.parse(row.current_issues));
  }

  setIssue(libraryId: string, peerId: string, photoId: string, issue: BackupIssue): void {
    const issues = this.issuesFor(libraryId, peerId, photoId).filter(
      (existing) => existing.phase !== issue.phase,
    );
    this.writeIssues(libraryId, peerId, photoId, [...issues, issue]);
  }

  clearIssue(libraryId: string, peerId: string, photoId: string, phase: BackupPhase): void {
    this.writeIssues(
      libraryId,
      peerId,
      photoId,
      this.issuesFor(libraryId, peerId, photoId).filter((issue) => issue.phase !== phase),
    );
  }

  clearLocalIssues(libraryId: string, photoId: string): void {
    const copies = this.db
      .query(
        "SELECT peer_id FROM backup_locations WHERE library_id = ? AND photo_id = ? AND current_issues <> '[]'",
      )
      .all(libraryId, photoId) as { peer_id: string }[];
    for (const copy of copies) {
      this.writeIssues(
        libraryId,
        copy.peer_id,
        photoId,
        this.issuesFor(libraryId, copy.peer_id, photoId).filter(
          (issue) => issue.code !== 'local_changed',
        ),
      );
    }
  }

  private writeIssues(
    libraryId: string,
    peerId: string,
    photoId: string,
    issues: readonly BackupIssue[],
  ): void {
    this.db
      .query(
        'UPDATE backup_locations SET current_issues = ? WHERE library_id = ? AND peer_id = ? AND photo_id = ?',
      )
      .run(JSON.stringify(BackupCopyIssuesSchema.parse(issues)), libraryId, peerId, photoId);
  }

  /**
   * Forgets what a peer held, for a backup folder somebody has unpaired.
   *
   * The files stay where they are - nothing here ever deletes from a backup (§14.3) - so this is
   * the catalogue forgetting a mount, not the mount losing anything.
   */
  forget(libraryId: string, peerId: string): void {
    this.db
      .query('DELETE FROM backup_locations WHERE library_id = ? AND peer_id = ?')
      .run(libraryId, peerId);
  }

  /**
   * The originals this device holds that the backup does not hold the current bytes of (§14.3).
   *
   * Three ways a photograph is owed: it has never been copied, the copy's hash is not the one the
   * catalogue now records for the file, or the file's size has moved under it. A composite is not
   * owed anything - what composes it is catalogue, and travels as catalogue - and neither is a row
   * whose original is not on this device to send.
   */
  owed(libraryId: string, peerId: string): OwedOriginal[] {
    return this.db
      .query(
        `SELECT p.id AS photo_id, json_extract(p.recipe, '$.path') AS rel_path
           FROM photos p
           LEFT JOIN backup_locations b
             ON b.library_id = p.library_id AND b.peer_id = ? AND b.photo_id = p.id
          WHERE p.library_id = ? AND p.is_missing = 0 AND json_extract(p.recipe, '$.kind') = 'file'
            AND (b.photo_id IS NULL OR b.health <> 'held'
                 OR (p.content_hash IS NOT NULL AND p.content_hash <> b.content_hash)
                 OR (p.file_size IS NOT NULL AND p.file_size <> b.size))
          ORDER BY p.date_added, p.id`,
      )
      .all(peerId, libraryId) as OwedOriginal[];
  }

  /** Originals missing from this device that this backup has no record of either. */
  lost(libraryId: string, peerId: string): OwedOriginal[] {
    return this.db
      .query(
        `SELECT p.id AS photo_id, json_extract(p.recipe, '$.path') AS rel_path
           FROM photos p
           LEFT JOIN backup_locations b
             ON b.library_id = p.library_id AND b.peer_id = ? AND b.photo_id = p.id
          WHERE p.library_id = ? AND p.is_missing = 1 AND json_extract(p.recipe, '$.kind') = 'file'
            AND b.photo_id IS NULL
          ORDER BY p.id`,
      )
      .all(peerId, libraryId) as OwedOriginal[];
  }

  /** The copies the catalogue has moved out from under: a rename, a bin, a restore (§14.3). */
  misplaced(libraryId: string, peerId: string): MisplacedCopy[] {
    return this.db
      .query(
        `SELECT b.photo_id, b.rel_path AS was_at, json_extract(p.recipe, '$.path') AS belongs_at
           FROM backup_locations b JOIN photos p ON p.id = b.photo_id
          WHERE b.library_id = ? AND b.peer_id = ? AND b.health = 'held' AND json_extract(p.recipe, '$.kind') = 'file'
            AND json_extract(p.recipe, '$.path') <> b.rel_path
          ORDER BY b.photo_id`,
      )
      .all(libraryId, peerId) as MisplacedCopy[];
  }

  /** The photographs whose only copy is on this backup. */
  offloadedTo(libraryId: string, peerId: string): string[] {
    return (
      this.db
        .query(
          `SELECT p.id FROM photos p JOIN backup_locations b ON b.library_id = p.library_id AND b.photo_id = p.id
            WHERE p.library_id = ? AND b.peer_id = ? AND p.is_missing = 1 AND json_extract(p.recipe, '$.kind') = 'file' ORDER BY p.id`,
        )
        .all(libraryId, peerId) as { id: string }[]
    ).map((row) => row.id);
  }

  coverage(libraryId: string, peerId: string): BackupCoverage {
    return this.db
      .query(
        `SELECT COUNT(*) AS originals,
        COALESCE(SUM(b.health = 'held' AND (p.content_hash IS NULL OR p.content_hash = b.content_hash)
          AND (p.file_size IS NULL OR p.file_size = b.size)), 0) AS backed_up,
        COALESCE(SUM(p.is_missing = 0 AND (b.photo_id IS NULL OR b.health <> 'held'
          OR (p.content_hash IS NOT NULL AND p.content_hash <> b.content_hash)
          OR (p.file_size IS NOT NULL AND p.file_size <> b.size))), 0) AS pending,
        COALESCE(SUM(p.is_missing = 1 AND b.health = 'held'), 0) AS offloaded,
        COALESCE(SUM(b.health = 'missing'), 0) AS missing,
        COALESCE(SUM(b.health = 'changed'), 0) AS changed,
        COALESCE(SUM(p.is_missing = 1 AND (b.photo_id IS NULL OR b.health <> 'held')), 0) AS missing_originals
       FROM photos p LEFT JOIN backup_locations b
         ON b.library_id = p.library_id AND b.photo_id = p.id AND b.peer_id = ?
       WHERE p.library_id = ? AND json_extract(p.recipe, '$.kind') = 'file'`,
      )
      .get(peerId, libraryId) as BackupCoverage;
  }
}
