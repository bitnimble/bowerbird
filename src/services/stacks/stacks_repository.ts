import type { Database } from '../../db/driver';
import type { Ordering } from '../../schemas/common';
import { captureSequenceOf } from '../../schemas/capture_sequence';
import type { Stack, StackOrigin, StackState } from '../../schemas/stacks';
import type { SequencedFrame } from './brackets';
import { hiddenIs, orderByClause } from '../photos/listing/photo_query';
import { stamp } from '../replication/stamps';
import { tombstone } from '../replication/tombstones';
import { StackMembership } from './stack_membership';

// A photo detection may look at.
//
// Deliberately without its descriptor: those are 2.6 kB each, so a library's
// worth is hundreds of megabytes and detection only ever needs the ones for the
// run it is currently walking (`descriptorsOf`).
export interface StackCandidate {
  id: string;
  /** Seconds since the epoch, from the capture time or the import time. */
  timestamp: number;
  /** The shoot the photo sits in, or null for one at the library root. */
  shootId: string | null;
}

export interface Stacking {
  id: string;
  stack_id: string | null;
  origin: StackOrigin | null;
  stack_state: StackState;
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
  private readonly members: StackMembership;

  constructor(private readonly db: Database) {
    this.members = new StackMembership(db);
  }

  get(id: string): Stack | null {
    return (this.db.query(`SELECT ${STACK_COLS} FROM stacks WHERE stacks.id = ?`).get(id) as StackRow | null) ?? null;
  }

  /**
   * Members of a stack, in the order the collection showing them is sorted.
   *
   * `ordering` is the collection's own, not the library's: a band is drawn inside
   * a shoot or an album as often as inside the library, and the viewer steps
   * through the uncollapsed listing in that same sort. An order of its own here
   * is a band whose second frame is not the one Next goes to (§19.5.3).
   *
   * `deleted` picks which side of the bin to answer for, because the band has to
   * agree with the listing it was opened from: the Bin lists nothing but deleted
   * rows, so a band there that returned the live members would show photographs
   * that are not in the Bin, under a tile that counts the ones that are.
   *
   * `shootId` is that same agreement for hiding (§12.4), and it is why the shoot has to travel with
   * the request: a band opened on a hidden shoot's own page must hold what that page's tile counted,
   * which is the members in *this* shoot - where one opened anywhere else must hold none of them.
   */
  memberIds(stackId: string, ordering: Ordering, deleted = false, shootId?: string): string[] {
    // Hidden members are left out for the same reason binned ones are, and the Bin's band keeps
    // them for the same reason the Bin's listing does: the tile's count comes off those same
    // filters, so a band holding what the number does not is a stack that says three and opens
    // onto four (`conditions`, `sizeExpression`).
    const visible = deleted ? '' : ` AND ${hiddenIs('', false, shootId == null ? undefined : '?')}`;
    const rows = this.db
      .query(
        `SELECT id FROM photos WHERE stack_id = ? AND is_deleted = ?${visible}
         ORDER BY ${orderByClause(ordering)}`,
      )
      .all(stackId, deleted ? 1 : 0, ...(deleted || shootId == null ? [] : [shootId])) as { id: string }[];
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
                photos.shoot_id,
                CAST(strftime('%s', COALESCE(photos.date_taken, photos.date_added)) AS INTEGER) AS timestamp
         FROM photos
         LEFT JOIN stacks ON stacks.id = photos.stack_id
         WHERE photos.library_id = ?
           AND photos.stack_state IN ('none', 'stacked')
           AND photos.descriptor IS NOT NULL
           AND photos.is_deleted = 0
           AND photos.is_missing = 0
           AND ${hiddenIs('photos.', false)}
           AND (stacks.id IS NULL OR stacks.origin = 'auto')
         ORDER BY COALESCE(photos.date_taken, photos.date_added) ASC, photos.id ASC`,
      )
      .all(libraryId) as { id: string; shoot_id: string | null; timestamp: number | null }[];
    // A capture time SQLite cannot parse would otherwise sort as NULL and make
    // every gap from it enormous, which reads as "never adjacent" and is the
    // right answer anyway; 0 says the same thing without arithmetic on null.
    return rows.map((row) => ({ id: row.id, timestamp: row.timestamp ?? 0, shootId: row.shoot_id }));
  }

  /** Every live photograph whose body recorded a multi-shot capture, for `bracketsOf`. */
  sequencedFrames(libraryId: string): SequencedFrame[] {
    const rows = this.db
      .query(
        `SELECT id, shoot_id, capture_sequence,
                CAST(strftime('%s', COALESCE(date_taken, date_added)) AS INTEGER) AS timestamp
         FROM photos
         WHERE library_id = ? AND capture_sequence IS NOT NULL AND is_deleted = 0`,
      )
      .all(libraryId) as { id: string; shoot_id: string | null; capture_sequence: string; timestamp: number | null }[];
    return rows.flatMap((row) => {
      const sequence = captureSequenceOf(row.capture_sequence);
      return sequence == null ? [] : [{ id: row.id, shootId: row.shoot_id, timestamp: row.timestamp ?? 0, sequence }];
    });
  }

  /** Where each of these photographs stands with stacking: its stack's origin, and its own state. */
  stackingOf(photoIds: readonly string[]): Stacking[] {
    const found: Stacking[] = [];
    for (const batch of chunk(photoIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      found.push(
        ...(this.db
          .query(
            `SELECT photos.id, photos.stack_id, stacks.origin, photos.stack_state
             FROM photos LEFT JOIN stacks ON stacks.id = photos.stack_id
             WHERE photos.id IN (${placeholders})`,
          )
          .all(...batch) as Stacking[]),
      );
    }
    return found;
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
    // `created_stamp` is what decides the surviving id where two peers stacked
    // overlapping sets, so it is minted once here and never moved again; the row's
    // own stamp moves whenever anything about the stack is written.
    const at = stamp(this.db);
    this.db
      .query('INSERT INTO stacks (id, library_id, origin, date_created, stamp, created_stamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, libraryId, origin, dateCreated, at, at);
  }

  /** Puts photos into a stack. */
  addPhotos(stackId: string, photoIds: readonly string[]): void {
    this.members.add(stackId, photoIds);
  }

  /**
   * Points the stack's representative flag at the member it should stand for.
   *
   * Only ever touches rows still in the stack. A photograph on its way out is
   * flagged by whoever releases it, because out of a stack it stands for itself
   * and the listing shows it on that flag alone (`representativeFilter`).
   */
  refreshRepresentative(stackId: string): void {
    this.members.refreshRepresentative(stackId);
  }

  /** Takes photos out of whatever stack they are in. */
  removePhotos(stackId: string, photoIds: readonly string[], released: boolean): number {
    return this.members.remove(stackId, photoIds, released);
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
    const row = this.db.query('SELECT library_id FROM stacks WHERE id = ?').get(stackId) as
      | { library_id: string }
      | null;
    // The members leaving and the stack going are one deletion, so they carry one
    // stamp: two would land as two events, and a peer taking only the first holds a
    // stack with nothing in it until the repair pass notices.
    const at = stamp(this.db);
    this.members.clear(stackId, released, at);
    this.db.query('DELETE FROM stacks WHERE id = ?').run(stackId);
    if (row != null) tombstone(this.db, row.library_id, 'stack', stackId, at);
  }

  /**
   * Dissolves a stack that a removal has left with nothing to be a stack of.
   *
   * **Called by whatever did the removing - the person here, or a merge applying
   * somebody else's - and never by a pass that looks at the state afterwards.**
   * That distinction is the whole of it, and the earlier attempts at this rule
   * founder on it: a pass over converged state cannot tell a stack whose members
   * have left from one whose members have not arrived yet. Pages come in stamp
   * order and a stack's memberships can span several, so such a pass sees a stack
   * of one mid-merge, buries it, and then refuses the rows that would have made it
   * whole - while the peer that had them all along dissolves nothing, and the two
   * never agree again.
   *
   * Hung on the removal, that cannot happen: nothing dissolves until a member
   * actually goes. Two peers that each took a different member out of the same
   * stack both reach the same answer as the other's removal lands, each writing it
   * under its own origin - an ordinary tombstone, which travels (§5.2).
   *
   * @returns whether it dissolved.
   */
  dissolveIfSpent(stackId: string, released: boolean): boolean {
    // One photograph is a photograph. The same threshold the local path has always
    // used, now the only place it is written down.
    if (this.get(stackId) == null || this.countMembers(stackId) >= 2) return false;
    this.dissolve(stackId, released);
    return true;
  }

  /** A human has touched this stack, so detection stops managing it (§19.4.4). */
  markManual(stackId: string): void {
    this.db.query("UPDATE stacks SET origin = 'manual', stamp = ? WHERE id = ?").run(stamp(this.db), stackId);
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
