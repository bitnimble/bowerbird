import type { Database } from '../../db/driver';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { ensureDir } from '../../utils/files';
import { containsPath, libraryPath } from '../../utils/paths';
import { ReplicatedPathSchema } from '../../schemas/replication';
import { unsettled } from '../replication/materialise';
import { peerId, stamp } from '../replication/stamps';
import { replicates } from '../replication/tombstones';

const log = new Logger('blobs');

// Which peers hold which originals (docs/replication.md §7.2), behind one writer
// so the rows and their log entries cannot drift. Only this peer's own row is
// ever written here: rows about other peers arrive by replication, because a
// location is a fact about the peer that holds the bytes.

export interface MaterialisationFlag {
  library_id: string;
  photo_id: string;
  target_path: string;
  reason: string;
}

export class BlobLocations {
  constructor(private readonly db: Database) {}

  selfId(): string {
    return peerId(this.db);
  }

  /** Every peer recorded as holding this photograph's original, this one included when it does. */
  holders(libraryId: string, photoId: string): string[] {
    const rows = this.db
      .query('SELECT peer_id FROM blob_locations WHERE library_id = ? AND photo_id = ? ORDER BY peer_id')
      .all(libraryId, photoId) as { peer_id: string }[];
    return rows.map((row) => row.peer_id);
  }

  heldBy(libraryId: string, photoId: string, peer: string): boolean {
    return (
      this.db
        .query('SELECT 1 FROM blob_locations WHERE library_id = ? AND photo_id = ? AND peer_id = ?')
        .get(libraryId, photoId, peer) != null
    );
  }

  /**
   * The §7.3 push diff: of the photos this peer holds, the ones `peer` has no row
   * for. `photoIds` undefined is the whole library; a list is the photos in it,
   * and an empty one is no photos.
   */
  heldHereLackedBy(libraryId: string, peer: string, photoIds: readonly string[] | undefined): string[] {
    return this.diff(libraryId, this.selfId(), peer, photoIds);
  }

  /** The pull diff: photos `peer` holds that this peer has no row for. */
  heldByLackedHere(libraryId: string, peer: string, photoIds: readonly string[] | undefined): string[] {
    return this.diff(libraryId, peer, this.selfId(), photoIds);
  }

  private diff(libraryId: string, holder: string, lacker: string, photoIds: readonly string[] | undefined): string[] {
    const scope = photoIds == null ? '' : ` AND b.photo_id IN (${photoIds.map(() => '?').join(', ')})`;
    const rows = this.db
      .query(
        `SELECT b.photo_id FROM blob_locations b
           WHERE b.library_id = ? AND b.peer_id = ?${scope}
             AND NOT EXISTS (SELECT 1 FROM blob_locations o
               WHERE o.library_id = b.library_id AND o.photo_id = b.photo_id AND o.peer_id = ?)
           ORDER BY b.photo_id`,
      )
      .all(libraryId, holder, ...(photoIds ?? []), lacker) as { photo_id: string }[];
    return rows.map((row) => row.photo_id);
  }

  /**
   * Records that this peer holds the bytes. Only called after the blob is
   * verified and renamed into the tree (§7.2): a row written earlier is a claim
   * other peers would fetch against and find nothing behind.
   */
  record(libraryId: string, photoId: string): void {
    const self = this.selfId();
    if (this.heldBy(libraryId, photoId, self)) return;
    const at = stamp(this.db);
    this.db
      .query('INSERT INTO blob_locations (library_id, photo_id, peer_id, stamp) VALUES (?, ?, ?, ?)')
      .run(libraryId, photoId, self, at);
    this.log(libraryId, photoId, self, at, false);
  }

  /**
   * Every photograph whose only recorded holder is `peer`, which is what forgetting
   * it would put out of reach (§8.4).
   */
  soleHoldings(libraryId: string, peer: string): string[] {
    return (
      this.db
        .query(
          `SELECT b.photo_id FROM blob_locations b
            WHERE b.library_id = ? AND b.peer_id = ?
              AND NOT EXISTS (SELECT 1 FROM blob_locations o
                WHERE o.library_id = b.library_id AND o.photo_id = b.photo_id AND o.peer_id <> b.peer_id)
            ORDER BY b.photo_id`,
        )
        .all(libraryId, peer) as { photo_id: string }[]
    ).map((row) => row.photo_id);
  }

  /**
   * Retracts a departing peer's claims on its behalf (§8.4).
   *
   * The exception to "only this peer's own row is ever written here", and it has
   * to be: once a peer is forgotten it is refused if it ever comes back, so it can
   * never retract them itself, and every remaining peer would go on believing a
   * laptop nobody has seen in a year still holds the trip.
   */
  forgetPeer(libraryId: string, peer: string): void {
    const held = this.db
      .query('SELECT photo_id FROM blob_locations WHERE library_id = ? AND peer_id = ?')
      .all(libraryId, peer) as { photo_id: string }[];
    if (held.length === 0) return;
    const at = stamp(this.db);
    this.db.query('DELETE FROM blob_locations WHERE library_id = ? AND peer_id = ?').run(libraryId, peer);
    for (const row of held) this.log(libraryId, row.photo_id, peer, at, true);
  }

  /** Tombstones this peer's own row, for bytes that have verifiably left this disk. */
  retract(libraryId: string, photoId: string): void {
    const self = this.selfId();
    const gone =
      this.db
        .query('DELETE FROM blob_locations WHERE library_id = ? AND photo_id = ? AND peer_id = ?')
        .run(libraryId, photoId, self).changes > 0;
    if (!gone) return;
    this.log(libraryId, photoId, self, stamp(this.db), true);
  }

  // The log rows the stamped tables get from their triggers: one live entry per
  // row, a tombstone on retraction, nothing for a library that does not
  // replicate.
  private log(libraryId: string, photoId: string, peer: string, at: string, deleted: boolean): void {
    if (!replicates(this.db, libraryId)) return;
    const rowId = `${photoId}/${peer}`;
    this.db
      .query('DELETE FROM replication_log WHERE library_id = ? AND entity = ? AND row_id = ? AND deleted = ?')
      .run(libraryId, 'blob_location', rowId, deleted ? 0 : 1);
    this.db
      .query(
        `INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted) VALUES (?, 'blob_location', ?, ?, ?)
         ON CONFLICT (library_id, entity, row_id) DO UPDATE SET stamp = excluded.stamp, deleted = excluded.deleted
           WHERE excluded.stamp > replication_log.stamp`,
      )
      .run(libraryId, rowId, at, deleted ? 1 : 0);
  }

  flag(libraryId: string, photoId: string, targetPath: string, reason: string): void {
    this.db
      .query(
        `INSERT INTO materialisation_flags (library_id, photo_id, target_path, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT (library_id, photo_id) DO UPDATE SET target_path = excluded.target_path, reason = excluded.reason`,
      )
      .run(libraryId, photoId, targetPath, reason);
  }

  clearFlag(libraryId: string, photoId: string): void {
    this.db.query('DELETE FROM materialisation_flags WHERE library_id = ? AND photo_id = ?').run(libraryId, photoId);
  }

  flags(libraryId: string): MaterialisationFlag[] {
    return this.db
      .query('SELECT library_id, photo_id, target_path, reason FROM materialisation_flags WHERE library_id = ? ORDER BY photo_id')
      .all(libraryId) as MaterialisationFlag[];
  }

  /**
   * The scan-time self-heal (§7.2, §7.4): asserts this peer's row where the
   * bytes are on disk, retracts it where they have verifiably gone, and keeps
   * every shoot folder present regardless of blob possession - an absent folder
   * reads to the scan's mirroring as the user deleting the shoot, which would
   * tombstone it back to every peer.
   */
  async reconcile(library: Library): Promise<void> {
    // A root that is not there is a drive that is not mounted, not a library whose
    // every original has gone. Read the second way this retracts every row the
    // device has, minting and replicating a grave per photograph, and re-asserts
    // the lot when the drive comes back - two full rewrites of the log, with every
    // one of those graves bounding collection until every peer acknowledges it, and
    // every other peer believing this device holds nothing in between. The drain
    // refuses on the same evidence and for the same reason (`materialise.ts`).
    if (!existsSync(library.root_path)) {
      log.warn('skipping the blob reconcile: the library root is not there', { library: library.id });
      return;
    }
    if (!library.read_only) {
      const shoots = this.db
        .query('SELECT folder_path FROM shoots WHERE library_id = ?')
        .all(library.id) as { folder_path: string }[];
      for (const shoot of shoots) {
        const dir = path.join(library.root_path, shoot.folder_path);
        if (containsPath(library.root_path, dir)) await ensureDir(dir);
      }
    }
    // Only the rows that are files. A composed photograph has no original anywhere, on this
    // device or on any other, so it is not a holding this peer could assert or retract - and
    // walking it here would mint a grave apiece on every scan, for bytes that never existed.
    const rows = this.db
      .query(
        `SELECT id, json_extract(recipe, '$.path') AS file_path FROM photos
          WHERE library_id = ? AND json_extract(recipe, '$.kind') = 'file'`,
      )
      .all(library.id) as { id: string; file_path: string }[];
    // A photograph whose merged move has not been made yet is not one whose bytes
    // have gone: the file is at the path it was at before, and saying otherwise
    // would retract this peer's claim on an original it is holding - after which
    // it is invisible to the sole-holder check somebody forgetting this peer runs
    // (§8.4). The next reconcile, after the drain, records it at its new path.
    // The same definition the scan reads, rather than a second one here: a
    // photograph whose transfer found somebody else's file at its path is no more
    // held than one whose merged move has not run, and reading either as possession
    // makes this device advertise an original it does not have. The push that would
    // deliver it then skips it as already held, so the recovery the collision
    // surface offers - clear it and press send again - answers nothing, for good.
    const pending = new Set(unsettled(this.db, library.id).map((entry) => entry.photoId));
    for (const row of rows) {
      if (pending.has(row.id)) continue;
      // Checked on the value SQL read, not on the one the wire guard parsed (§11.2). `JSON.parse`
      // keeps the last of a duplicated key where `json_extract` returns the first, so a recipe can
      // validate as one path and read out as another - and this is a `path.join` and a stat, which
      // would answer whether an attacker-named file exists anywhere the process can reach.
      if (!ReplicatedPathSchema.safeParse(row.file_path).success) {
        log.warn('refusing a recipe path that does not stay inside the library', { photo: row.id });
        this.retract(library.id, row.id);
        continue;
      }
      if (existsSync(libraryPath(library, row.file_path))) this.record(library.id, row.id);
      else this.retract(library.id, row.id);
    }
  }
}
