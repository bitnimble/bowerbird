import type { Database } from '../../db/driver';
import { existsSync } from 'node:fs';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { ReplicatedPathSchema } from '../../schemas/replication';
import { libraryPath } from '../../utils/paths';
import type { BlobLocations } from '../blobs/blob_locations';
import { materialise } from '../blobs/blob_store';

// Disk catching up with a merge (docs/replication.md §7.4).
//
// A merged `placement` or `bin` unit says where a photograph is *supposed* to
// be; on the peer that holds the original, the file is still where this peer
// last put it. The gap between those two is what this closes - and why the
// pending set is durable rather than a list in memory: a crash between the merge
// and the move leaves the catalogue ahead of the disk, which the scan would
// otherwise read as the user moving the file back and replicate as a reversal.

const log = new Logger('replication');

/**
 * Where a photograph's file is, as a path this peer is willing to touch - and null for anything
 * else, a composite included.
 *
 * **Read back through the validator rather than trusted from the wire (§11.2).** The path arrives
 * inside a JSON recipe now, and two things stop the payload check from vouching for what SQL
 * later reads out of it:
 *
 * - a recipe of a kind this build does not know is relayed unread, deliberately, and nothing
 *   stops one carrying a `path` of its own that no `file` rule was ever applied to;
 * - `JSON.parse` keeps the **last** of a duplicated key and `json_extract` returns the **first**,
 *   so `{"path":"../../etc/passwd","path":"ok.arw"}` validates as one path and reads as another.
 *
 * Either way the bytes that reach the filesystem are not the bytes that were checked. So the
 * check is here, on the value that is actually about to be joined onto the library root, where
 * the two cannot differ.
 */
export function recipePathToTouch(db: Database, photoId: string): string | null {
  const row = db
    .query(
      `SELECT json_extract(recipe, '$.path') AS path FROM photos
        WHERE id = ? AND json_extract(recipe, '$.kind') = 'file'`,
    )
    .get(photoId) as { path: string | null } | null;
  const path = row?.path;
  if (typeof path !== 'string') return null;
  if (!ReplicatedPathSchema.safeParse(path).success) {
    log.warn('refusing a recipe path that does not stay inside the library', { photo: photoId });
    return null;
  }
  return path;
}

/** Records that a photograph's file may no longer be where its row says. */
export function queueMaterialisation(db: Database, libraryId: string, photoId: string, wasAt: string): void {
  db.query(
    // The *first* entry's `was_at` is the one that matters: it is where the file
    // actually is. A second merge before the drain moves the target, not the file.
    'INSERT INTO materialisation_queue (library_id, photo_id, was_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  ).run(libraryId, photoId, wasAt);
}

export function pendingMaterialisations(db: Database, libraryId: string): number {
  const row = db
    .query('SELECT COUNT(*) AS n FROM materialisation_queue WHERE library_id = ?')
    .get(libraryId) as { n: number };
  return row.n;
}

/**
 * Photographs whose row and whose file disagree on purpose, and the path the file
 * is actually at.
 *
 * Neither half is evidence: the row and the file describe different instants, and
 * either one read on its own is misleading (§7.4). **The only definition of that**,
 * because there are two ways to get there and a reader that knows one of them
 * reads the other as ordinary disagreement:
 *
 * - a merged move still owed, where the file is at the path it was at before;
 * - a transfer that found somebody else's file at its target and refused to
 *   overwrite it (§7.7), where the file there belongs to the photographer.
 *
 * The second was the scan's blind spot. A flag carries no queue row, so the scan
 * hashed the occupant, found it different, and read the photograph as *modified* -
 * writing the occupant's dimensions, dates, camera and lens onto it, minting a
 * fresh `imported` stamp, and replicating another frame's identity to every peer.
 */
export function unsettled(db: Database, libraryId: string): { photoId: string; wasAt: string }[] {
  return (
    db
      .query(
        `SELECT photo_id, was_at FROM materialisation_queue WHERE library_id = ?
         UNION SELECT photo_id, target_path FROM materialisation_flags WHERE library_id = ?`,
      )
      .all(libraryId, libraryId) as {
      photo_id: string;
      was_at: string;
    }[]
  ).map((row) => ({ photoId: row.photo_id, wasAt: row.was_at }));
}

/**
 * Moves what the merges asked for, and empties the queue.
 *
 * Idempotent, and safe to run against a tree somebody has already fixed by hand:
 * an entry whose file is already at the target, or whose old path holds nothing,
 * is simply satisfied. **Must run before a scan concludes anything** - that is
 * the whole reason the queue is durable (§7.4).
 */
export async function drainMaterialisations(
  db: Database,
  library: Library,
  locations: BlobLocations,
): Promise<number> {
  const pending = db
    .query('SELECT photo_id, was_at FROM materialisation_queue WHERE library_id = ? ORDER BY photo_id')
    .all(library.id) as { photo_id: string; was_at: string }[];
  if (pending.length === 0) return 0;
  // An absent root is a drive that is not mounted, not a library with no
  // originals: every file would read as already gone and every entry would be
  // dropped as nothing-to-do, and when the drive came back the files would be at
  // their old paths with the catalogue saying otherwise - which is exactly the
  // reading the queue exists to keep the scan from making.
  if (!existsSync(library.root_path)) {
    log.warn('a library whose root is not there cannot be materialised; leaving the moves queued', {
      library: library.id,
      root: library.root_path,
      pending: pending.length,
    });
    return 0;
  }

  let moved = 0;
  for (const entry of pending) {
    try {
      const outcome = await settle(db, library, locations, entry.photo_id, entry.was_at);
      if (outcome === 'moved') moved += 1;
      // A blocked entry stays. It is the only thing holding the photograph and the
      // path its file is still at out of the next scan's diff, and without it that
      // scan reads a row pointing at somebody else's file as a modification of
      // this one and its real file as an unclaimed import - which is the
      // photograph's history lost and both readings replicated.
      if (outcome !== 'blocked') {
        db.query('DELETE FROM materialisation_queue WHERE library_id = ? AND photo_id = ?').run(
          library.id,
          entry.photo_id,
        );
      }
    } catch (error) {
      // Left queued: a file the editor is holding open, or a disk that filled up,
      // is answered by trying again rather than by forgetting the photograph is
      // in the wrong place.
      log.warn('could not materialise a merged move', { photo: entry.photo_id, err: String(error) });
    }
  }
  if (moved > 0) log.info('materialised merged moves', { library: library.id, moved });
  return moved;
}

/**
 * `moved` - the file is where the row says now. `settled` - there was nothing to
 * do, so the entry has served its purpose. `blocked` - the move is still owed and
 * the disk still disagrees with the catalogue, which is a different thing from
 * finished and must not be forgotten.
 */
type Settlement = 'moved' | 'settled' | 'blocked';

async function settle(
  db: Database,
  library: Library,
  locations: BlobLocations,
  photoId: string,
  wasAt: string,
): Promise<Settlement> {
  const at = recipePathToTouch(db, photoId);
  // Deleted since the merge, cascade and all: there is no target to move to. A row composed
  // rather than imported answers null and takes the same branch, having no file to move either -
  // and so does one whose recipe names a path that will not stay inside the library.
  if (at == null || at === wasAt) {
    // Any collision this entry raised is over with it, and a flag left standing
    // sends somebody to settle a clash that is no longer there.
    locations.clearFlag(library.id, photoId);
    return 'settled';
  }
  const from = libraryPath(library, wasAt);
  // Either the move already happened or this peer never held the original; both
  // mean the tree already agrees with the catalogue as far as this peer can.
  if (!existsSync(from)) {
    locations.clearFlag(library.id, photoId);
    return 'settled';
  }

  const placement = await materialise(library, at, from);
  if (placement.placed) {
    locations.clearFlag(library.id, photoId);
    return 'moved';
  }
  // Never overwritten and never suffixed (§7.7): the photograph stays where it
  // is and the collision is surfaced for a person to settle. Still owed, though -
  // the row and the file go on disagreeing until somebody moves whatever is in
  // the way, and every scan until then has to be told to leave both alone.
  locations.flag(library.id, photoId, at, `occupied by ${placement.occupiedBy}`);
  return 'blocked';
}
