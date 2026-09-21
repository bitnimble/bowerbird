import type { Database } from '../../../db/driver';
import { recipeOf, type StoredRecipe } from '../../../schemas/recipes';
import { stamp } from '../../replication/stamps';
import { forgetCascade, tombstone } from '../../replication/tombstones';
import type { StackMembership } from '../../stacks/stack_membership';
import { inChunks } from '../photo_batches';
import { refreshStackOf } from './photo_stack_state';

export const PATH_OF = `json_extract(photos.recipe, '$.path')`;

export interface BasicPhoto {
  id: string;
  library_id: string;
  shoot_id: string | null;
  recipe: StoredRecipe;
}

export const BASIC_COLS = 'id, library_id, shoot_id, recipe';

// The stored recipe parsed, for the reads that answer as one of the shapes above. A row is
// selected with `BASIC_COLS`, so the column is always there to parse.
export function withRecipe<T extends { recipe: unknown }>(row: T): T & { recipe: StoredRecipe } {
  return { ...row, recipe: recipeOf(String(row.recipe)) };
}

/** A binned row and where it came from, which is everything a restore needs (§12.3). */
export interface DeletedPhoto extends BasicPhoto {
  deleted_from_path: string | null;
}

// Bounds selecting exactly the paths under `folderPath` (prefix + '/').
// '0' (0x30) is the character right after '/' (0x2F), so [P+'/', P+'0') is the
// half-open range of all strings beginning with P+'/', index-friendly on photo_inputs.path.
export function folderRange(folderPath: string): [string, string] {
  return [`${folderPath}/`, `${folderPath}0`];
}

// A row that is one file, which is what every question about a path is asked of: a composite
// names other photographs, so a folder does not contain it and a rename does not move it.
export const IS_A_FILE = `json_extract(recipe, '$.kind') = 'file'`;

// Where a row's one file is, read out of the recipe. Only meaningful under `IS_A_FILE`; a
// composite answers NULL, which is what keeps it out of every range this is compared in.
//
/**
 * Whether every file this row is composed from sits under a folder, given its bounds as `?, ?`.
 *
 * **Every, and at least one.** A folder operation - a rename, a shoot claiming what is inside it -
 * means to take what the folder holds, and a row half of whose inputs are elsewhere is not that:
 * moving it would move a file the folder never held. So a composite spanning two folders is under
 * neither, and belongs to whoever handles the case rather than to whichever folder sorted first.
 */
const INPUTS_ALL_UNDER = `EXISTS (SELECT 1 FROM photo_inputs i WHERE i.photo_id = photos.id)
  AND NOT EXISTS (SELECT 1 FROM photo_inputs i WHERE i.photo_id = photos.id AND NOT (i.path >= ? AND i.path < ?))`;

/**
 * A folder rename, on the recipes: `? || substr(path, ?)`, stamped `?`, for the rows of library
 * `?` whose path is under `[?, ?)`, clearing `is_missing` where `provenPresent` says the files
 * were found at the new prefix.
 *
 * **Reads the recipe rather than the input index**, though the index is what the range would
 * normally be read from: this statement's own trigger rewrites that index row by row as it goes,
 * and a `WHERE` reading a table the statement is modifying underneath itself is not a bound
 * anyone should have to reason about. `idx_photos_path` is what keeps it a range scan.
 *
 * Only the `file` kind carries a path, and only it can match: a composite names other
 * photographs, so a folder does not hold it and a rename does not move it.
 */
function movePathsUnder(deleted: 0 | 1, provenPresent = false): string {
  return `UPDATE photos
    SET recipe = json_set(recipe, '$.path', ? || substr(json_extract(recipe, '$.path'), ?)),
        stamp_placement = ?${provenPresent ? ', is_missing = 0' : ''}
    WHERE library_id = ? AND is_deleted = ${deleted} AND ${IS_A_FILE}
      AND ${PATH_OF} >= ? AND ${PATH_OF} < ?`;
}

export class PhotoPathsRepository {
  constructor(private readonly db: Database, private readonly stacks: StackMembership) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // One row, four columns, no joins: what the byte-serving paths need, as
    // opposed to getById's detail payload. Soft-deleted rows included, unlike
    // getBasicByIds below - the Bin is a browsable view and its images are served.
    getBasicById(id: string): BasicPhoto | null {
      const row = this.db.query(`SELECT ${BASIC_COLS} FROM photos WHERE id = ?`).get(id) as BasicPhoto | null;
      return row == null ? null : withRecipe(row);
    }
  /**
     * A photograph to time a render against (`render_benchmark.ts`), from whichever library has one.
     *
     * One file rather than a composite, because what is being timed is the pipeline a rendition
     * takes and a canvas is several of those with an assembly on top. The first by id rather than a
     * sampled one, so running the benchmark twice measures the same photograph and the second
     * answer is comparable with the first.
     *
     * Its size comes with it because the answer is scaled to one reference sensor
     * (`scaledToReference`), which is what lets a catalogue of mixed bodies have a single figure
     * for what this machine costs.
     */
    aFileToBenchmark(): (BasicPhoto & { width: number; height: number }) | null {
      const row = this.db
        .query(
          `SELECT ${BASIC_COLS}, width, height FROM photos
           WHERE is_deleted = 0 AND is_missing = 0 AND width > 0 AND height > 0 AND ${IS_A_FILE}
           ORDER BY id LIMIT 1`,
        )
        .get() as (BasicPhoto & { width: number; height: number }) | null;
      return row == null ? null : withRecipe(row);
    }
  /** Which library a stack is in, for the paths a panorama's own files sit under. */
    libraryOfStack(stackId: string): string | null {
      const row = this.db.query('SELECT library_id FROM stacks WHERE id = ?').get(stackId) as
        | { library_id: string }
        | null;
      return row?.library_id ?? null;
    }
  // Excludes binned photos. Callers are shoot/album membership ops and banner
    // validation, and the shoot ones are what the exclusion is really about: a
    // shoot move is a file move (§7), and moving a binned photograph out of the Bin
    // while it is still flagged `is_deleted` is not something either half means.
    // (The exclusion is the row's rather than the folder's, per §9.1.1. Album
    // membership is swept up by the same filter, so a binned photograph cannot be
    // filed - a rare thing to want, and left alone here.)
    getBasicByIds(ids: string[]): BasicPhoto[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(', ');
      return (
        this.db
          .query(`SELECT ${BASIC_COLS} FROM photos WHERE id IN (${placeholders}) AND is_deleted = 0`)
          .all(...ids) as BasicPhoto[]
      ).map(withRecipe);
    }
  // Photos belonging to `folderPath` (any depth), which for a live photo is where
    // its file is and for a binned one is where its file came *from* - so the binned
    // arm asks `deleted_from_path`, whatever the file's current position. Not
    // because the two columns agree for a row binned in place: they are written
    // together but only the recipe replicates, so on a peer they routinely do not
    // (see `rewritePathPrefix`). This wants the origin, and asks for it directly.
    //
    // A folder holds files, so the live arm asks the input index: a row with several inputs is
    // under a folder only if all of them are, which is not a question a folder rename has ever
    // had to answer and not one this invents an answer to - `INPUTS_ALL_UNDER` says so.
    listUnderFolder(libraryId: string, folderPath: string, includeDeleted = false): BasicPhoto[] {
      const [lo, hi] = folderRange(folderPath);
      const live = `is_deleted = 0 AND ${INPUTS_ALL_UNDER}`;
      if (!includeDeleted) {
        return (
          this.db
            .query(`SELECT ${BASIC_COLS} FROM photos WHERE library_id = ? AND ${live}`)
            .all(libraryId, lo, hi) as BasicPhoto[]
        ).map(withRecipe);
      }
      return (
        this.db
          .query(
            `SELECT ${BASIC_COLS} FROM photos
             WHERE library_id = ?
               AND ((${live}) OR (is_deleted = 1 AND deleted_from_path >= ? AND deleted_from_path < ?))`,
          )
          .all(libraryId, lo, hi, lo, hi) as BasicPhoto[]
      ).map(withRecipe);
    }
  // Hands every photo under `folderPath` to that folder's shoot. Callers run it
    // shallowest folder first, so a deeper shoot's own claim lands last and wins,
    // which is the same "most specific folder" rule the per-photo path uses (§9.4).
    setShootForFolder(libraryId: string, folderPath: string, shootId: string): void {
      const [lo, hi] = folderRange(folderPath);
      this.db
        .query(`UPDATE photos SET shoot_id = ?, stamp_placement = ? WHERE library_id = ? AND ${INPUTS_ALL_UNDER}`)
        .run(shootId, stamp(this.db), libraryId, lo, hi);
    }
  // Removes the rows outright, unlike the soft delete in §12, which moves a file
    // to a Bin so it can come back. This is for a folder leaving the library (§4.7):
    // the files stay exactly where they are on disk, and what goes is the
    // catalogue's record of them. Album membership, banners and the rest cascade.
    deleteByIds(ids: readonly string[]): number {
      let deleted = 0;
      const at = stamp(this.db);
      for (const batch of inChunks(ids)) {
        const placeholders = batch.map(() => '?').join(', ');
        // Read before the delete, because what a tombstone needs is the library the
        // row was in, and afterwards there is no row to ask.
        const gone = this.db
          .query(`SELECT id, library_id FROM photos WHERE id IN (${placeholders})`)
          .all(...batch) as { id: string; library_id: string }[];
        const byLibrary = new Map<string, string[]>();
        for (const row of gone) byLibrary.set(row.library_id, [...(byLibrary.get(row.library_id) ?? []), row.id]);
        for (const [libraryId, rowIds] of byLibrary) forgetCascade(this.db, libraryId, 'photo', rowIds);
        deleted += this.db.query(`DELETE FROM photos WHERE id IN (${placeholders})`).run(...batch).changes;
        // One stamp for the batch: a folder leaving the library is one thing the
        // photographer did, and a merge that took half of it would leave the folder
        // half in the catalogue.
        for (const row of gone) tombstone(this.db, row.library_id, 'photo', row.id, at);
      }
      return deleted;
    }
  // Bulk prefix rewrite for a shoot folder that moved on disk (§9.4.1). Two
    // statements rather than one UPDATE per photo: a folder move is the one case
    // where every path beneath it changes the same way, and a shoot can hold
    // thousands of frames.
    //
    // The non-deleted rows are provably present at the new prefix; the move is
    // only inferred when every one of them was found there; so is_missing clears.
    //
    // `deleted_from_path` follows for every binned row: it is where a restore puts
    // the photo back, and left pointing at the old prefix a restore would recreate
    // the folder that was renamed away and put the photo outside the shoot it still
    // belongs to.
    //
    // A binned row's `file_path` follows a folder rename exactly when the file moved
    // with the folder, which is when it was **binned in place** (§12.1). Being under
    // the renamed folder at all is what says so: the bin is a single folder at the
    // library root (`BinNameSchema` admits no separator), so it can never sit inside
    // a shoot folder, and a bin-resident row's `file_path` is therefore never in
    // this range. A bin rename is `rewriteBinnedPathPrefix`, separately.
    //
    // Deliberately NOT `deleted_from_path = file_path`, which is the same test only
    // while both columns agree - and they do not agree on every peer. That pair is
    // written together locally but only `file_path` replicates (the other is a bin
    // column, corrected without a bin stamp: see below), so a receiving peer holds
    // the old origin against the new path, reads the row as bin-resident, and skips
    // it here. Then the file at the new path imports as a second, live photograph,
    // and *that* replicates back. `is_missing` is still only cleared for rows proven
    // present, which a binned row is not.
    rewritePathPrefix(libraryId: string, oldFolderPath: string, newFolderPath: string): void {
      const [lo, hi] = folderRange(oldFolderPath);
      const tailFrom = oldFolderPath.length + 1; // 1-based: first char after the old prefix
      // One stamp across all three: the folder moved once, and a merge that could
      // take part of that would leave the shoot half at each path.
      const at = stamp(this.db);
      this.db.query(movePathsUnder(0, true)).run(newFolderPath, tailFrom, at, libraryId, lo, hi);
      this.db.query(movePathsUnder(1)).run(newFolderPath, tailFrom, at, libraryId, lo, hi);
      /*
       * Where the photograph would go back to, corrected because the folder it came
       * from was renamed - and deliberately UNSTAMPED. §3.1: a folder rename
       * rewrites member placement units and only them; it never touches bin units.
       *
       * Stamping `stamp_bin` here is the bug this replaced. `deleted_from_path` is a
       * bin-unit column, so it puts the whole bin unit - `is_deleted` above all - at
       * the rename's stamp, asserting that the binning was decided now. A peer that
       * restored the photograph while apart loses that restore to a rename which
       * knew nothing about it, and the photograph is back in the bin everywhere.
       *
       * Moving the column to `placement` instead is worse, and was tried: a peer
       * that still thinks the row is live holds NULL for it, so its ordinary path
       * writes null the origin of a binning it never heard of, and the restore then
       * puts the RAW in the library root.
       *
       * So the correction stays local, and the residual is named rather than traded
       * for a bigger one: a peer that has not scanned the rename still holds the old
       * origin, and restoring there recreates the folder that was renamed away. A
       * tidy-up, against silently undoing what somebody did.
       */
      this.db
        .query(
          `UPDATE photos SET deleted_from_path = ? || substr(deleted_from_path, ?)
             WHERE library_id = ? AND is_deleted = 1 AND deleted_from_path >= ? AND deleted_from_path < ?`,
        )
        .run(newFolderPath, tailFrom, libraryId, lo, hi);
    }
  // The bin folder moved, so every binned row's `file_path` moved with it (§4.1,
    // §9.1.1). Deliberately not `rewritePathPrefix` above, which does the two halves
    // the opposite way round and, critically, **clears `is_missing`**: that is right
    // for a shoot relocation, which is only inferred once every file is proven
    // present at the new prefix, but a bin rename proves nothing about individual
    // files - the bin channel's own diff is what decides `is_missing`, and clearing
    // it here would resurrect every hand-deleted binned file on every rename.
    //
    // `deleted_from_path` is left alone: it records where the photograph came from,
    // outside the bin, which has not moved.
    rewriteBinnedPathPrefix(libraryId: string, oldPrefix: string, newPrefix: string): void {
      const [lo, hi] = folderRange(oldPrefix);
      const tailFrom = oldPrefix.length + 1;
      this.db.query(movePathsUnder(1)).run(newPrefix, tailFrom, stamp(this.db), libraryId, lo, hi);
    }
  setShoot(photoId: string, shootId: string | null): void {
      this.db.query('UPDATE photos SET shoot_id = ?, stamp_placement = ? WHERE id = ?').run(shootId, stamp(this.db), photoId);
    }
  // Clears is_missing: callers (a user move, or scan applying a detected move)
    // run only after a specific file provably exists at the new path. Without this,
    // a concurrent scan whose setMissing landed just before the move committed
    // would leave the present photo stuck is_missing=1 until the next scan.
    setFilePathAndShoot(photoId: string, filePath: string, shootId: string | null): void {
      this.db
        .query(
          `UPDATE photos SET recipe = json_set(recipe, '$.path', ?), shoot_id = ?, is_missing = 0, stamp_placement = ?
             WHERE id = ? AND ${IS_A_FILE}`,
        )
        .run(filePath, shootId, stamp(this.db), photoId);
    }
  setFilePath(photoId: string, filePath: string): void {
      this.db
        .query(
          `UPDATE photos SET recipe = json_set(recipe, '$.path', ?), is_missing = 0, stamp_placement = ?
             WHERE id = ? AND ${IS_A_FILE}`,
        )
        .run(filePath, stamp(this.db), photoId);
    }
  // Records where the file was before the Bin move so restore can put it back
    // exactly there (§12.3). shoot_id and album membership are deliberately left
    // alone, so those survive the round trip without any extra bookkeeping.
    // Left as its own statement rather than folded into the file_path write beside
    // it. Merging the two looks like it should halve the work and does not: they
    // touch different indexes - file_path one, is_deleted all six ordering ones
    // (§4.2) - so each entry is rewritten once either way, and the row rewrite
    // they would share is the cheap part. Measured identical within noise, against
    // a lie: a photo binned while its file was already gone would have had
    // is_missing cleared, because the merged statement has no way to say "the file
    // did not actually move".
    // `deletedFromPath` is null for a row with no file: nothing moved, so there is nowhere for a
    // restore to put anything back, and the column says so rather than naming a path that is not.
    markDeleted(id: string, deletedFromPath: string | null, batch?: string): void {
      this.db.transaction(() => {
        this.db
          .query(
            `UPDATE photos SET is_deleted = 1, deleted_from_path = ?,
               deleted_batch = ?, stamp_bin = ? WHERE id = ?`,
          )
          .run(deletedFromPath, batch ?? null, stamp(this.db), id);
        // Binning is the other way the member a stack's tile stands for stops being
        // the one to stand for it, and `refreshRepresentative` ranks a binned member
        // last for exactly that reason. Without this the ranking would be a claim
        // nothing kept: bin a burst's keeper and that stack is on the slow arm for
        // good.
        refreshStackOf(this.db, this.stacks, id);
      })();
    }
  // Everything one bin took. What an undo restores, so it never has to be handed
    // back the ids: a selection of a million would be a 36MB response, and the
    // positions it was made from name different photographs once these have left
    // the collection (§12.3).
    idsDeletedInBatch(batch: string): string[] {
      const rows = this.db.query('SELECT id FROM photos WHERE deleted_batch = ? AND is_deleted = 1').all(batch) as { id: string }[];
      return rows.map((row) => row.id);
    }
  // The binned rows a restore needs, with where each came from - the mirror of
    // getBasicByIds, which excludes exactly the rows this wants. One query rather
    // than a detail payload and a second lookup for the origin path per photo.
    getDeletedByIds(ids: string[]): DeletedPhoto[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(', ');
      return (
        this.db
          .query(`SELECT ${BASIC_COLS}, deleted_from_path FROM photos WHERE id IN (${placeholders}) AND is_deleted = 1`)
          .all(...ids) as DeletedPhoto[]
      ).map(withRecipe);
    }
  // The path this photo was at when it was binned, or null if it predates the
    // column (restore then falls back to the library root).
    getDeletedFromPath(id: string): string | null {
      const row = this.db.query('SELECT deleted_from_path FROM photos WHERE id = ?').get(id) as
        | { deleted_from_path: string | null }
        | null;
      return row?.deleted_from_path ?? null;
    }
  // Nothing to re-queue: a binned photograph keeps whatever its rendition rows
    // said, and the queue skips it on `is_deleted` rather than on those - so one that
    // went into the Bin owing a build comes back out still owing it, and one whose
    // copies are on disk is not rebuilt for having been binned.
    // `filePath` is null for a row with no file: coming out of the bin is only the flag for one,
    // there being nothing that moved into it, so the recipe is left exactly as it stands.
    markRestored(id: string, filePath: string | null): void {
      this.db.transaction(() => {
        // Both units, on one stamp: coming out of the bin is a move as well as a
        // restoration, and a merge that took one without the other would have the
        // photograph live at the path inside the bin.
        const at = stamp(this.db);
        // `json_set` of a null value writes SQL NULL over the whole recipe, so the path is only
        // touched where there is one to write - and where there is not, nothing moved anyway.
        const movesPath = filePath != null;
        this.db
          .query(
            `UPDATE photos SET is_deleted = 0, deleted_from_path = NULL, is_missing = 0,
               stamp_bin = ?, stamp_placement = ?
               ${movesPath ? `, recipe = json_set(recipe, '$.path', ?)` : ''}
               WHERE id = ?${movesPath ? ` AND ${IS_A_FILE}` : ''}`,
          )
          .run(at, at, ...(movesPath ? [filePath] : []), id);
        refreshStackOf(this.db, this.stacks, id);
      })();
    }
}
