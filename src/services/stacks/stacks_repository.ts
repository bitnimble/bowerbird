import type { Database } from 'bun:sqlite';
import type { Stack, StackOrigin } from '../../schemas/stacks';

// A photo detection may look at.
//
// Deliberately without its descriptor: those are 2.6 kB each, so a library's
// worth is hundreds of megabytes and detection only ever needs the ones for the
// run it is currently walking (`descriptorsOf`).
export interface StackCandidate {
  id: string;
  /** Seconds since the epoch, from the capture time or the import time. */
  timestamp: number;
}

// Ids per `WHERE id IN (...)`, well under SQLite's variable limit.
const ID_CHUNK = 500;
function* chunk(ids: readonly string[]): Generator<readonly string[]> {
  for (let from = 0; from < ids.length; from += ID_CHUNK) yield ids.slice(from, from + ID_CHUNK);
}

interface StackRow {
  id: string;
  library_id: string;
  origin: StackOrigin;
  date_created: string;
  photo_count: number;
}

const STACK_COLS = `stacks.id, stacks.library_id, stacks.origin, stacks.date_created,
  (SELECT COUNT(*) FROM photos WHERE photos.stack_id = stacks.id AND photos.is_deleted = 0) AS photo_count`;

export class StacksRepository {
  constructor(private readonly db: Database) {}

  get(id: string): Stack | null {
    return (this.db.query(`SELECT ${STACK_COLS} FROM stacks WHERE stacks.id = ?`).get(id) as StackRow | null) ?? null;
  }

  /**
   * Members of a stack, newest first, which is the order a band shows them in.
   *
   * `deleted` picks which side of the bin to answer for, because the band has to
   * agree with the listing it was opened from: the Bin lists nothing but deleted
   * rows, so a band there that returned the live members would show photographs
   * that are not in the Bin, under a tile that counts the ones that are.
   */
  memberIds(stackId: string, deleted = false): string[] {
    const rows = this.db
      .query(
        `SELECT id FROM photos WHERE stack_id = ? AND is_deleted = ?
         ORDER BY COALESCE(date_taken, date_added) DESC, id DESC`,
      )
      .all(stackId, deleted ? 1 : 0) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /**
   * The photos detection is allowed to consider, in the order it walks them.
   *
   * Excludes anything a human has had an opinion about: a photo pulled out of a
   * stack ('unstacked'), and every member of a stack somebody made or edited by
   * hand. Those are the two ways the answer stops being detection's to give
   * (§19.4.2).
   */
  candidates(libraryId: string): StackCandidate[] {
    const rows = this.db
      .query(
        `SELECT photos.id,
                CAST(strftime('%s', COALESCE(photos.date_taken, photos.date_added)) AS INTEGER) AS timestamp
         FROM photos
         LEFT JOIN stacks ON stacks.id = photos.stack_id
         WHERE photos.library_id = ?
           AND photos.stack_state IN ('none', 'stacked')
           AND photos.descriptor IS NOT NULL
           AND photos.is_deleted = 0
           AND photos.is_missing = 0
           AND (stacks.id IS NULL OR stacks.origin = 'auto')
         ORDER BY COALESCE(photos.date_taken, photos.date_added) ASC, photos.id ASC`,
      )
      .all(libraryId) as { id: string; timestamp: number | null }[];
    // A capture time SQLite cannot parse would otherwise sort as NULL and make
    // every gap from it enormous, which reads as "never adjacent" and is the
    // right answer anyway; 0 says the same thing without arithmetic on null.
    return rows.map((row) => ({ id: row.id, timestamp: row.timestamp ?? 0 }));
  }

  /**
   * The descriptors for a handful of photos, by id.
   *
   * Blobs that are not the size this build of the library produces are left out
   * rather than returned: a descriptor written by another version of the format
   * cannot be compared with these, and it is one photograph's worth of stacking
   * to lose against a detection pass that refuses to run at all.
   */
  descriptorsOf(photoIds: readonly string[], size: number): Map<string, Buffer> {
    const found = new Map<string, Buffer>();
    for (const batch of chunk(photoIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .query(`SELECT id, descriptor FROM photos WHERE id IN (${placeholders})`)
        .all(...batch) as { id: string; descriptor: Uint8Array }[];
      for (const row of rows) {
        if (row.descriptor?.length === size) found.set(row.id, Buffer.from(row.descriptor));
      }
    }
    return found;
  }

  /** The auto stacks of a library, which a detection pass rewrites wholesale. */
  autoStackIds(libraryId: string): string[] {
    const rows = this.db
      .query("SELECT id FROM stacks WHERE library_id = ? AND origin = 'auto'")
      .all(libraryId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  create(id: string, libraryId: string, origin: StackOrigin, dateCreated: string): void {
    this.db
      .query('INSERT INTO stacks (id, library_id, origin, date_created) VALUES (?, ?, ?, ?)')
      .run(id, libraryId, origin, dateCreated);
  }

  /**
   * Puts photos into a stack.
   *
   * Writes `stack_state` with `stack_id` rather than leaving them to drift: the
   * two describe the same fact, and the invariant lives here because a library
   * delete cascades `stacks` and `photos` in an order SQLite does not define, so
   * a CHECK spanning them would fire mid-cascade.
   */
  addPhotos(stackId: string, photoIds: readonly string[]): void {
    // Joining clears the flag, because every one of these was standing for itself
    // a moment ago and the unique index allows only one flagged member per stack;
    // `refreshRepresentative` then picks the single one that stands for it now.
    const statement = this.db.query(
      "UPDATE photos SET stack_id = ?, stack_state = 'stacked', is_representative = 0 WHERE id = ?",
    );
    for (const photoId of photoIds) statement.run(stackId, photoId);
    this.refreshRepresentative(stackId);
  }

  /**
   * Points the stack's representative flag at its newest member (§19.5.1).
   *
   * Cleared before it is set, and both inside whatever transaction the caller is
   * running: the unique index allows only one flagged member per stack, so
   * setting the new one first would collide with the old.
   *
   * Only ever touches rows still in the stack. A photograph on its way out is
   * flagged by whoever releases it, because out of a stack it stands for itself
   * and the listing shows it on that flag alone (`representativeFilter`).
   */
  refreshRepresentative(stackId: string): void {
    this.db.query('UPDATE photos SET is_representative = 0 WHERE stack_id = ?').run(stackId);
    this.db
      .query(
        'UPDATE photos SET is_representative = 1 WHERE id = (' +
          'SELECT id FROM photos WHERE stack_id = ? ' +
          'ORDER BY COALESCE(date_taken, date_added) DESC, id DESC LIMIT 1)',
      )
      .run(stackId);
  }

  /**
   * Takes photos out of whatever stack they are in.
   *
   * `released` is the difference between detection tidying up after itself and a
   * human saying no: a released photo is marked 'unstacked' and is never claimed
   * again, while one merely being re-sorted by a detection pass goes back to
   * 'none' and stays available (§19.4.4).
   */
  // Constrained to the stack being removed from, so a request naming a photo
  // that belongs to some other stack changes nothing rather than quietly pulling
  // it out of that one.
  /** Returns how many photographs actually left, which may be none of them. */
  removePhotos(stackId: string, photoIds: readonly string[], released: boolean): number {
    const state = released ? 'unstacked' : 'none';
    // `is_representative = 1`, like `dissolve`: out of a stack a photograph stands
    // for itself, and `representativeFilter` shows a row with no stack on that
    // flag alone. Left at 0 - which is what every member but one carries - the
    // photograph vanished from every listing while `total` went on counting it,
    // for good, with nothing on screen to say where it had gone.
    const statement = this.db.query(
      `UPDATE photos SET stack_id = NULL, stack_state = '${state}', is_representative = 1 WHERE id = ? AND stack_id = ?`,
    );
    let removed = 0;
    for (const photoId of photoIds) removed += statement.run(photoId, stackId).changes;
    // The one that left may have been the one standing for the stack.
    if (removed > 0) this.refreshRepresentative(stackId);
    return removed;
  }

  /** Of these ids, the ones that are photographs in this catalogue. */
  existingPhotoIds(photoIds: readonly string[]): string[] {
    const found: string[] = [];
    for (const batch of chunk(photoIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.query(`SELECT id FROM photos WHERE id IN (${placeholders})`).all(...batch) as { id: string }[];
      found.push(...rows.map((row) => row.id));
    }
    return found;
  }

  /** Clears a whole stack's membership and deletes it. */
  dissolve(stackId: string, released: boolean): void {
    const state = released ? 'unstacked' : 'none';
    // Every one of them stands for itself again once the stack is gone.
    this.db
      .query(`UPDATE photos SET stack_id = NULL, stack_state = '${state}', is_representative = 1 WHERE stack_id = ?`)
      .run(stackId);
    this.db.query('DELETE FROM stacks WHERE id = ?').run(stackId);
  }

  /** A human has touched this stack, so detection stops managing it (§19.4.4). */
  markManual(stackId: string): void {
    this.db.query("UPDATE stacks SET origin = 'manual' WHERE id = ?").run(stackId);
  }

  /** The distinct stacks a set of photos belongs to. */
  stackIdsOf(photoIds: readonly string[]): string[] {
    const found = new Set<string>();
    // Chunked, because "select everything, then Stack" resolves to every id in
    // the library: SQLite's variable limit turns that into a 500 somewhere north
    // of 65k photographs, and the wrapping of that counter makes the error a
    // nonsense one.
    for (const batch of chunk(photoIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .query(`SELECT DISTINCT stack_id FROM photos WHERE id IN (${placeholders}) AND stack_id IS NOT NULL`)
        .all(...batch) as { stack_id: string }[];
      for (const row of rows) found.add(row.stack_id);
    }
    return [...found];
  }

  /** How many photos a stack still holds, binned ones aside. */
  countMembers(stackId: string): number {
    return (
      this.db.query('SELECT COUNT(*) AS n FROM photos WHERE stack_id = ? AND is_deleted = 0').get(stackId) as {
        n: number;
      }
    ).n;
  }

  /** The library a set of photos is in, or null when they span more than one. */
  soleLibraryOf(photoIds: readonly string[]): string | null {
    const found = new Set<string>();
    for (const batch of chunk(photoIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .query(`SELECT DISTINCT library_id FROM photos WHERE id IN (${placeholders})`)
        .all(...batch) as { library_id: string }[];
      for (const row of rows) found.add(row.library_id);
    }
    return found.size === 1 ? [...found][0]! : null;
  }

  writeDescriptor(photoId: string, descriptor: Buffer): void {
    this.db.query('UPDATE photos SET descriptor = ? WHERE id = ?').run(descriptor, photoId);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
}
