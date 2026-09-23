import type { Database } from '../../../db/driver';
import { OrderingSchema, type Ordering } from '../../../schemas/common';
import type { RenditionSource } from '../../processing/workers/processing_types';
import { renditionVariant, type RenditionVariant } from '../../processing/renditions/renditions';
import { FULL_VARIANT_OF_LIBRARY, RenditionsRepository, type Made } from '../../processing/renditions/renditions_repository';
import type { StoredRecipe } from '../../../schemas/recipes';
import { inChunks } from '../photo_batches';
import { BUILT_FROM_STAMP, INPUTS_EDITED, type EditStamp } from '../photo_edit_sql';
import { withRecipe } from '../paths/photo_paths_repository';
import { hiddenIs, orderByClause } from '../listing/photo_query';

export interface PendingPhoto {
  photo_id: string;
  root_path: string;
  library_id: string;
  /** What the queue has to compose this row out of, which for almost all of them is its file. */
  recipe: StoredRecipe;
  // Which passes this photo still owes. A run interrupted between them comes back
  // needing only the second, and staging reads these rather than rebuilding both.
  needs_tile: number;
  needs_renditions: number;
  // The source requested for this photo; NULL for rows queued before the setting
  // existed, which the service resolves to the library's default.
  rendition_source: RenditionSource | null;
  // The library's rendition settings, carried along so the pool needs no second
  // lookup per job (§10.2). Aliased in the query because the photo carries a
  // column of the same name: what it was built with, against what to build next.
  library_rendition_source: RenditionSource;
  rendition_hdr: number;
  /** The library's `full` skip list as the column holds it; only that one, the queue building no `max`. */
  render_skip_full: string;
  // The photographer's develop settings as stored JSON, or NULL where they have
  // none. Carried on the row rather than read per photo for the reason the join
  // gives; the service parses it, because what a document means is the schema's
  // business and not this layer's.
  edits: string | null;
  // Which document that is, so the render can record what it was built from. Read
  // with the doc rather than after the render: an edit landing mid-render is one
  // this build did not include, and recording the settings as they stand at the
  // end would retire the rebuild it is owed.
  edits_stamp: string | null;
  // Whether any row this one composes carries an edit. Nothing for a photograph, which
  // composes no rows.
  //
  // The other half of `edits` for a composite: a frame someone has developed is no
  // longer the picture its camera wrote, so what the canvas may be built from is a
  // question about the frames as well as about the canvas (`renditions::sourceFor`).
  inputs_edited: number;
  // `builtFromOf`, read with the rest for the reason `edits_stamp` is.
  built_from: string | null;
}

/** What decides whether one stored copy is current: what it was built from, against what the photo holds now. */
export interface RenditionStamps {
  built_from: string | null;
  edited_from: string | null;
  /** Whether the last attempt to build this photograph failed, which no stamp records. */
  failed: boolean;
}

// A photo the rendition queue owes work on: either pass, over a query that joins the
// owed `renditions` rows as `r`, the photograph as `prefix` and its library as `l`.
// Which range of `full` counts is the library's, the other being built on request.
//
// A hidden photograph is passed over rather than un-queued: `needs_build` stays 1, so unhiding it
// brings the work back with no second pass to find what was skipped.
const PENDING_PROCESSING = (prefix: string): string =>
  `r.needs_build = 1 AND (r.variant = 'grid' OR r.variant = ${FULL_VARIANT_OF_LIBRARY})
    AND ${prefix}is_missing = 0 AND ${prefix}is_deleted = 0 AND ${hiddenIs(prefix, false)}`;

export class PhotoProcessingRepository {
  constructor(private readonly db: Database, private readonly renditions: RenditionsRepository) {}

  // --- processing (DESIGN §10) ---
  
    // Photos awaiting renditions, joined with their library paths. is_missing is
    // excluded so a photo whose file vanished mid-queue is not failed against it.
    // `photoIds` narrows to a named set: a scoped scan processes the files it
    // reconciled rather than draining whatever else the library still owes (§9.5).
    listPendingProcessing(libraryId?: string, photoIds?: readonly string[]): PendingPhoto[] {
      const where = libraryId ? 'AND p.library_id = ?' : '';
      const params = libraryId ? [libraryId] : [];
      // Queued in the order the grid will show them, so the first screenful of a
      // 50k import is the first to fill in rather than the rows arriving in
      // whatever order they were inserted (§10.2). Only when the run names one
      // library: across several there is no single ordering to follow, and those
      // runs are always an explicit set of ids the user just asked for.
      const order = libraryId == null ? '' : `ORDER BY ${orderByClause(this.libraryOrdering(libraryId), 'p.')}`;
      const query = (idClause: string): string =>
        `SELECT p.id AS photo_id, p.rendition_source, p.recipe,
                MAX(r.variant = 'grid') AS needs_tile,
                MAX(r.variant = ${FULL_VARIANT_OF_LIBRARY}) AS needs_renditions,
                l.root_path, l.id AS library_id, l.rendition_source AS library_rendition_source, l.rendition_hdr,
                l.render_skip_full,
                e.doc AS edits, e.stamp AS edits_stamp,
                -- The frames' documents, for a row composed out of other rows. A subquery rather
                -- than a join: it is one row per composite and none at all for a photograph, where
                -- joining photo_sources would multiply every pending row by its frame count.
                ${INPUTS_EDITED('p.')} AS inputs_edited,
                ${BUILT_FROM_STAMP('p.')} AS built_from
         -- Driven from the owed rows rather than from the library: the partial index holds
         -- only what is outstanding, which on a settled catalogue is nothing at all, where
         -- a predicate over the photos table would walk every row of it on every poll.
         FROM renditions r JOIN photos p ON p.id = r.photo_id JOIN libraries l ON l.id = p.library_id
         -- LEFT, and joined here rather than read per photo: a batch is thousands of rows and
         -- most of them have no edits at all, so a query each would be thousands of round trips
         -- to learn that. NULL means unedited, which is the common case and the cheap one.
         LEFT JOIN photo_edits e ON e.photo_id = p.id
         WHERE ${PENDING_PROCESSING('p.')} ${where} ${idClause}
         -- One row per photograph, whichever of its passes are owed: the two are stages of
         -- one job, and toStages reads which of them from the flags above.
         GROUP BY p.id ${order}`;
  
      if (photoIds == null) return (this.db.query(query('')).all(...params) as PendingPhoto[]).map(withRecipe);
      const rows: PendingPhoto[] = [];
      for (const batch of inChunks(photoIds)) {
        const placeholders = batch.map(() => '?').join(', ');
        rows.push(...(this.db.query(query(`AND p.id IN (${placeholders})`)).all(...params, ...batch) as PendingPhoto[]));
      }
      return rows.map(withRecipe);
    }
  // The ordering the library's grid reads by, which is what its queue is built
    // in. A row that has gone (deleted mid-run) or holds a value the enum no
    // longer has falls back to what a new library gets, rather than failing a
    // batch over a sort order.
    private libraryOrdering(libraryId: string): Ordering {
      const row = this.db.query('SELECT ordering FROM libraries WHERE id = ?').get(libraryId) as { ordering: string } | null;
      const parsed = OrderingSchema.safeParse(row?.ordering);
      return parsed.success ? parsed.data : 'taken_asc';
    }
  // The grid tile has landed. Its own row, because the renditions are still to
    // come and a client versions the tile's URL off that one alone: sharing a stamp
    // with the second pass re-fetched every tile on the page whenever any photo's
    // renditions were rebuilt.
    markTileBuilt(id: string, builtAtIso: string, builtFrom: string | null, made: Made | null): void {
      this.renditions.markBuilt(id, renditionVariant('grid', false), builtAtIso, builtFrom, made);
    }
  // The viewer's renditions have landed, which is also when `rendition_source`
    // becomes true: it records what the viewer is served (§10.2).
    //
    // `variant` is which of the two ranges of `full` was written, and only that one is
    // vouched for: a library whose HDR setting has been flipped keeps the other range's
    // copy on disk, built from whatever it was built from, and one stamp covering both
    // would hand it this render's answer.
    markRenditionsBuilt(
      id: string,
      builtAtIso: string,
      source: RenditionSource,
      builtFrom: string | null,
      variant: RenditionVariant,
    ): void {
      // Nothing reads the geometry of a `full`: the alignment asks about tiles, which is the copy
      // every photograph has.
      this.renditions.markBuilt(id, variant, builtAtIso, builtFrom, { from: source, matched: false });
      this.db.query('UPDATE photos SET processing_error = NULL, rendition_source = ? WHERE id = ?').run(source, id);
    }
  /**
     * One copy a reader asked for by name: its own row, and nothing else's.
     *
     * Apart from `markRenditionsBuilt` because a copy built on request answers neither of that
     * one's other questions - it renders no `full` and no tile, so retiring the `full` row would
     * drop a rebuild those still owe, and `rendition_source` is what the viewer is served, which on
     * an `embedded` library is still the cameras' pictures.
     */
    markCopyBuilt(
      id: string,
      builtAtIso: string,
      builtFrom: string | null,
      variant: RenditionVariant,
      // `max` exists to be pixel-peeped and there is nothing in a camera's JPEG to peep at, so its
      // caller says `render`; a canvas's camera view is composited from exactly those JPEGs.
      made: Made = { from: 'render', matched: false },
    ): void {
      this.renditions.markBuilt(id, variant, builtAtIso, builtFrom, made);
    }
  // The inputs to `queueEditedSince`'s staleness predicate, for one photo: the
    // rendition fetch-through (docs/replication.md §7.9) and the routes serving a
    // rendition ask the same question of the same rows rather than keeping a second
    // rule.
    renditionStamps(photoId: string, variant: RenditionVariant): RenditionStamps | null {
      // Asked of everything behind the row, not its own document alone: a canvas's own is the
      // framing the merge wrote, so asking that alone leaves a copy nothing queues - `max`, and the
      // camera view a library serving the cameras' pictures opens a panorama at - reading as current
      // for ever, however its frames are developed or its picks changed afterwards.
      const row = this.db
        .query(`SELECT p.processing_error, ${BUILT_FROM_STAMP('p.')} AS edited_from FROM photos p WHERE p.id = ?`)
        .get(photoId) as { processing_error: string | null; edited_from: string | null } | null;
      if (row == null) return null;
      return {
        built_from: this.renditions.stamps(photoId, variant).built_from,
        edited_from: row.edited_from,
        failed: row.processing_error != null,
      };
    }
  /**
     * `photoId`'s document is back to the one it held at `stamp`: every copy built from exactly
     * that state - its own, and each composite it is a frame of - is vouched for at the stamp
     * standing now, rather than rebuilt into the same picture.
     */
    vouchCameHome(photoId: string, stamp: string | null): void {
      const asOpened: EditStamp = (alias) => `CASE WHEN ${alias}.photo_id = ?1 THEN ?2 ELSE ${alias}.stamp END`;
      this.db
        .query(
          `UPDATE renditions
              SET built_from = (SELECT ${BUILT_FROM_STAMP('p.')} FROM photos p WHERE p.id = renditions.photo_id)
            WHERE built_at IS NOT NULL
              AND (photo_id = ?1 OR photo_id IN (SELECT c.composed_id FROM photo_sources c WHERE c.photo_id = ?1))
              AND built_from IS (SELECT ${BUILT_FROM_STAMP('p.', asOpened)} FROM photos p WHERE p.id = renditions.photo_id)`,
        )
        .run(photoId, stamp);
    }
  /** The stamp a copy of this row records it was built from, read before the build. */
    builtFromOf(photoId: string): string | null {
      const row = this.db
        .query(`SELECT ${BUILT_FROM_STAMP('p.')} AS stamp FROM photos p WHERE p.id = ?`)
        .get(photoId) as { stamp: string | null } | null;
      return row?.stamp ?? null;
    }
  // Queues the grid tile to be rebuilt, and only that. The viewer's renditions are
    // of the same unchanged file, so this leaves `needs_renditions` and
    // `rendition_source` where they are: setting either would have the run stamp the
    // viewer's side and sweep the renditions it did not rewrite (§10.3), which is a
    // rebuild of the rendition deleting the photo view's copies behind it.
    //
    // Returns how many rows were actually queued, so a request naming missing or
    // binned photos reports it.
    queueTileRebuild(photoIds: string[]): number {
      if (photoIds.length === 0) return 0;
      let changed = 0;
      for (const batch of inChunks(photoIds)) {
        const placeholders = batch.map(() => '?').join(', ');
        const live = this.db
          .query(
            `UPDATE photos SET processing_error = NULL
              WHERE id IN (${placeholders}) AND is_missing = 0 AND is_deleted = 0 RETURNING id`,
          )
          .all(...batch) as { id: string }[];
        for (const row of live) this.renditions.queue(row.id, [renditionVariant('grid', false)]);
        changed += live.length;
      }
      return changed;
    }
  // Both stages of specific photos, for a change to the picture itself rather than
    // to one derived copy of it. An edit invalidates the grid tile and the viewer's
    // renditions alike, and requeuing only the second leaves the gallery showing the
    // frame as it was.
    //
    // `rendition_source` is left alone, unlike the whole-library form below: that one
    // clears it so a library switched to `render` stops being told there is nothing to
    // build, and here the library's setting has not moved - only the photo has.
    queueEditedSince(photoIds?: readonly string[]): number {
      return this.renditions.queueEditedSince(photoIds);
    }
  // Whole library, same tile-only rule as `queueTileRebuild`.
    queueTileRebuildForLibrary(libraryId: string): number {
      this.db
        .query('UPDATE photos SET processing_error = NULL WHERE library_id = ? AND is_missing = 0 AND is_deleted = 0')
        .run(libraryId);
      return this.renditions.queueLibrary(libraryId, [renditionVariant('grid', false)]);
    }
  // Whole library's viewer renditions. Clears `rendition_source` so the library's
    // current setting applies: a catalogue rebuilt after switching to render would
    // otherwise keep the stamped `embedded` and build nothing (§10.1).
    queueRenditionRebuildForLibrary(libraryId: string): number {
      this.db
        .query(
          `UPDATE photos SET rendition_source = NULL, processing_error = NULL
           WHERE library_id = ? AND is_missing = 0 AND is_deleted = 0`,
        )
        .run(libraryId);
      return this.renditions.queueLibrary(libraryId, [this.fullVariantOf(libraryId)]);
    }
  /**
     * The viewer's copy is not owed and nothing was built.
     *
     * A canvas on a library that serves the cameras' pictures: there is no file to hand over, so it
     * is composited when a reader opens it (`renditions::owedOf`). A row rather than an absence, for
     * `markProcessingFailed`'s reason - absence is how "owed" is said, so without this every batch
     * for the life of the library picks the composite up again.
     */
    markRenditionsUnowed(id: string, variant: RenditionVariant): void {
      this.renditions.unqueue(id, [variant]);
    }
  // Both stages: the failure is the file rather than the stage, so a photo whose
    // tile could not be built has nothing to gain from being asked for renditions.
    //
    // Rows rather than an absence, because absence is how "owed" is said: without them
    // every batch for the life of the library picks this photograph up and fails it
    // again. Both ranges of `full`, since which one is asked about follows a library
    // setting that may be flipped afterwards.
    markProcessingFailed(id: string, error: string): void {
      this.renditions.unqueue(id, [
        renditionVariant('grid', false),
        renditionVariant('full', false),
        renditionVariant('full', true),
      ]);
      this.db.query('UPDATE photos SET processing_error = ? WHERE id = ?').run(error, id);
    }
  // Which range of `full` a library builds, which is the one variant its photographs
    // are queued and measured against.
    private fullVariantOf(libraryId: string): RenditionVariant {
      const row = this.db.query('SELECT rendition_hdr FROM libraries WHERE id = ?').get(libraryId) as
        | { rendition_hdr: number }
        | null;
      return renditionVariant('full', row?.rendition_hdr === 1);
    }
  // Pending while *either* stage is: the scan strip counts photos, not stages,
    // and one still building its renditions is not done. Same predicate as
    // `listPendingProcessing`, or the status would count work no batch will ever
    // pick up and never settle.
    countPendingProcessing(libraryId?: string, photoIds?: readonly string[]): number {
      const where = libraryId ? 'AND p.library_id = ?' : '';
      const params = libraryId ? [libraryId] : [];
      // Distinct, because a photograph owing both passes has a row for each and is one
      // photograph outstanding; and driven from the owed rows, so an idle library's poll
      // walks an empty index rather than its whole catalogue.
      const query = (idClause: string): string =>
        `SELECT COUNT(DISTINCT p.id) AS n
           FROM renditions r JOIN photos p ON p.id = r.photo_id JOIN libraries l ON l.id = p.library_id
          WHERE ${PENDING_PROCESSING('p.')} ${where} ${idClause}`;
  
      if (photoIds == null) return (this.db.query(query('')).get(...params) as { n: number }).n;
      let total = 0;
      for (const batch of inChunks(photoIds)) {
        const placeholders = batch.map(() => '?').join(', ');
        total += (this.db.query(query(`AND p.id IN (${placeholders})`)).get(...params, ...batch) as { n: number }).n;
      }
      return total;
    }
  // The grid tile and the viewer's renditions, for a photograph whose file has just
    // arrived or just changed. The library's own range of `full`, since that is the one
    // its queue asks about.
    queueBothPasses(photoId: string): void {
      const row = this.db.query('SELECT library_id FROM photos WHERE id = ?').get(photoId) as { library_id: string } | null;
      if (row == null) return;
      this.renditions.queue(photoId, [renditionVariant('grid', false), this.fullVariantOf(row.library_id)]);
    }
}
