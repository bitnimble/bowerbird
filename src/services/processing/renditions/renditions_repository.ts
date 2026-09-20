import type { Database } from '../../../db/driver';
import type { RenditionSource } from '../../../schemas/common';
import { renditionVariant, type RenditionVariant } from './renditions';

/**
 * What a copy on disk actually is, as opposed to what the library asks for.
 *
 * Null where nothing knows - a rendition fetched from a peer is that peer's render of a file this
 * device may not even hold.
 */
export interface Made {
  from: RenditionSource;
  /**
   * Whether the render was warped into the camera's own geometry by the match (§10.8). Always
   * false for a copy off the camera's JPEG, which is that geometry to begin with.
   */
  matched: boolean;
}

/** What one stored copy records: when it was written, and which develop settings it rendered. */
export interface BuildStamps {
  built_at: string | null;
  built_from: string | null;
}

/**
 * Whether this owner still owes the copy `variantExpr` names, as a SQL predicate.
 *
 * A missing row is not owed: the trigger on `photos` gives every photograph the two
 * rows its passes are asked about, so the only variants without one are the ones
 * nothing queues - `max`, and the range of `full` its library does not build, both of
 * which are built when they are asked for instead.
 */
export function owesRendition(variantExpr: string, idExpr: string): string {
  return `EXISTS (SELECT 1 FROM renditions r
      WHERE r.photo_id = ${idExpr} AND r.variant = ${variantExpr} AND r.needs_build = 1)`;
}

/** When one variant was last written, as a SQL scalar - null where it never was. */
export function renditionBuiltAt(variantExpr: string, idExpr: string): string {
  return `(SELECT r.built_at FROM renditions r
      WHERE r.photo_id = ${idExpr} AND r.variant = ${variantExpr})`;
}

/**
 * The later of a set of variants' build times, as a SQL scalar.
 *
 * What a client versions a URL by: the viewer's renditions are `full` and `max` in
 * either range, written at four different moments, and a URL that did not move when
 * the newest of them did is a picture nothing repaints.
 */
export function renditionsBuiltAt(variants: readonly RenditionVariant[], idExpr: string): string {
  const list = variants.map((variant) => `'${variant}'`).join(', ');
  return `(SELECT MAX(r.built_at) FROM renditions r
      WHERE r.photo_id = ${idExpr} AND r.variant IN (${list}))`;
}

/**
 * Every row a develop document can have made stale, and the newest document behind each: the
 * photograph it is of, and every composite that photograph is a frame of.
 *
 * **A composite is as new as the newest document behind it.** Its own, because a reader can crop
 * or grade a panorama like anything else; and its frames', because a frame someone has developed
 * is not the picture its camera wrote, so the canvas is owed a render where its tile may have been
 * the cameras' JPEGs (`renditions::sourceFor`). Nothing else reaches a composite: the sweep that
 * queues an edited photograph would otherwise leave the panorama it belongs to showing the frame
 * as it was before.
 *
 * And a composite's recipe is behind its copies as much as any document, so its own
 * `stamp_placement` is the third arm (`PhotoProcessingRepository.builtFromOf`).
 *
 * `narrowed` is a clause over the *changed* photograph, not over the row being queued - a session
 * naming a frame it just received has to reach the composite it makes stale, which is not in the
 * set it named.
 */
const TOUCHED_BY_EDITS = (narrowed: (column: string) => string): string => `
    SELECT id, MAX(stamp) AS stamp FROM (
        SELECT e.photo_id AS id, e.stamp AS stamp FROM photo_edits e
         WHERE e.stamp IS NOT NULL ${narrowed('e.photo_id')}
        UNION ALL
        SELECT s.composed_id AS id, e.stamp AS stamp FROM photo_edits e
          JOIN photo_sources s ON s.photo_id = e.photo_id
         WHERE e.stamp IS NOT NULL ${narrowed('e.photo_id')}
        UNION ALL
        SELECT c.id AS id, c.stamp_placement AS stamp FROM photos c
         WHERE c.id IN (SELECT s.composed_id FROM photo_sources s)
           AND c.stamp_placement IS NOT NULL ${narrowed('c.id')})
     GROUP BY id`;

/** Which `full` a library builds, as a SQL scalar over a `libraries` row aliased `l`. */
export const FULL_VARIANT_OF_LIBRARY = `CASE WHEN l.rendition_hdr = 1 THEN '${renditionVariant('full', true)}'
    ELSE '${renditionVariant('full', false)}' END`;

/**
 * Every read and write of what has been built, for either kind of owner (DESIGN §10.2).
 *
 * Keyed by `(photo_id, variant)` rather than sat on `photos` as a column
 * per stage, because a panorama's renditions belong to its stack and a stack is not a
 * photograph. One rule for staleness either way.
 */
export class RenditionsRepository {
  constructor(private readonly db: Database) {}

  /**
   * One variant has landed: it is no longer owed, the version moves, and the stamp
   * records which develop settings were rendered.
   *
   * `builtFrom` is read before the render rather than after, so an edit saved while a
   * frame was rendering is still owed one.
   */
  markBuilt(
    photoId: string,
    variant: RenditionVariant,
    builtAtIso: string,
    builtFrom: string | null,
    made: Made | null,
  ): void {
    this.db
      .query(
        `INSERT INTO renditions (photo_id, variant, needs_build, built_at, built_from, source, matched)
           VALUES (?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT (photo_id, variant)
           DO UPDATE SET needs_build = 0, built_at = excluded.built_at, built_from = excluded.built_from,
             source = excluded.source, matched = excluded.matched`,
      )
      .run(photoId, variant, builtAtIso, builtFrom, made?.from ?? null, made?.matched === true ? 1 : null);
  }

  /**
   * Whether this photograph's grid tile is the camera's own picture of the whole frame.
   *
   * Which is the question a panorama's alignment asks, and the one `libraries.rendition_source`
   * cannot answer: that says what a photo *will* be served, where a tile is written off the
   * camera's JPEG at import and rewritten from the render when the queue reaches it. Three
   * clauses, and each is a way the file on disk stops being that picture:
   *
   * - **owed again**: still there, still readable, and of the photograph as it was before
   *   whatever queued it;
   * - **built from an edit document**: a crop or a straighten makes the tile part of a frame,
   *   and the alignment needs the whole one. Colour-only edits are refused with them, which
   *   costs nothing - the align falls back to the RAW's own preview;
   * - **a render the match did not warp**: the recipe's lens table maps the camera's picture to
   *   the sensor, so a plane in our own uncorrected geometry is not where that table starts.
   */
  cameraTile(photoId: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM renditions
           WHERE photo_id = ? AND variant = ?
             AND needs_build = 0 AND built_from IS NULL
             AND (source = 'embedded' OR (source = 'render' AND matched = 1))`,
      )
      .get(photoId, renditionVariant('grid', false));
    return row != null;
  }

  /**
   * These variants are owed again. The stamps are left where they are: what a copy on
   * disk was built from stays true until something rewrites it, and a queue that
   * cleared them would report every rebuilt file as never having been rendered.
   */
  queue(photoId: string, variants: readonly RenditionVariant[]): number {
    let changed = 0;
    for (const variant of variants) {
      changed += this.db
        .query(
          `INSERT INTO renditions (photo_id, variant, needs_build) VALUES (?, ?, 1)
           ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 1`,
        )
        .run(photoId, variant).changes;
    }
    return changed;
  }

  /**
   * These variants are not owed, and nothing was built.
   *
   * The failure case, and the one thing an absent row cannot say: a photograph whose
   * decode failed has no copies and must still stop being queued, or every batch for
   * the life of the library picks it up and fails it again.
   */
  unqueue(photoId: string, variants: readonly RenditionVariant[]): void {
    for (const variant of variants) {
      this.db
        .query(
          `INSERT INTO renditions (photo_id, variant, needs_build) VALUES (?, ?, 0)
           ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 0`,
        )
        .run(photoId, variant);
    }
  }

  stamps(photoId: string, variant: RenditionVariant): BuildStamps {
    const row = this.db
      .query('SELECT built_at, built_from FROM renditions WHERE photo_id = ? AND variant = ?')
      .get(photoId, variant) as BuildStamps | null;
    return row ?? { built_at: null, built_from: null };
  }

  /** What each of this owner's copies was written at, for a client to version its URLs by. */
  versions(photoId: string): Partial<Record<RenditionVariant, string>> {
    const rows = this.db
      .query('SELECT variant, built_at FROM renditions WHERE photo_id = ? AND built_at IS NOT NULL')
      .all(photoId) as { variant: RenditionVariant; built_at: string }[];
    return Object.fromEntries(rows.map((row) => [row.variant, row.built_at]));
  }

  /**
   * Both derived stages of photographs whose develop settings are newer than the
   * copies rendered from them, narrowed to `photoIds` where the caller has some in
   * mind. Returns how many photographs were queued.
   *
   * **The predicate is the mechanism, not a filter on one.** Asking "are the edits
   * newer than the render" is true however the photograph got that way - a save, an
   * undo, a tab closed mid-edit, a process killed between the two - so the same query
   * serves the editor saying it is done and the sweep at startup that catches
   * everything which never got to say so. Nothing has to be remembered between
   * requests for it to be correct, and a rebuild records the stamp that queued it, so
   * a photograph stops matching as soon as it is done.
   *
   * **Each pass asks the variant it writes.** They are separate questions because the
   * files are written at different moments: a `full` built on request stamps that
   * variant and builds no tile, so a sweep comparing the edit against the pass that
   * *did* run would find nothing owed and leave the grid showing the pre-edit frame
   * for good. The renditions pass asks about whichever range its library builds, so a
   * library set to HDR is not measured against an SDR copy that may not exist at all.
   * `max` is asked about nowhere here - it is not a pass, and nothing queues it - so
   * its staleness is settled where it is built and served instead.
   *
   * **A composite is asked about the documents behind it**, which is [`TOUCHED_BY_EDITS`]: an
   * edited frame makes the panorama it belongs to stale as surely as an edited photograph makes
   * its own copies stale, and nothing else was reaching it.
   */
  queueEditedSince(photoIds?: readonly string[]): number {
    if (photoIds != null && photoIds.length === 0) return 0;
    const queued = new Set<string>();
    // No entry reads as owed, and has to: a build with nothing to record leaves the
    // stamp null, which is indistinguishable from a copy never built - so a photograph
    // whose tile was built before anyone edited it would never be queued once they did.
    for (const variant of [`'grid'`, FULL_VARIANT_OF_LIBRARY]) {
      const stale = `(SELECT r.built_from FROM renditions r
          WHERE r.photo_id = p.id AND r.variant = ${variant})`;
      const query = (narrowed: (column: string) => string): string =>
        `INSERT INTO renditions (photo_id, variant, needs_build)
           SELECT p.id, ${variant}, 1 FROM (${TOUCHED_BY_EDITS(narrowed)}) t
             JOIN photos p ON p.id = t.id
             JOIN libraries l ON l.id = p.library_id
            WHERE p.is_missing = 0 AND p.is_deleted = 0
              AND (${stale} IS NULL OR t.stamp > ${stale})
         ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 1
         RETURNING photo_id AS id`;
      const owed = (rows: unknown[]): void => {
        for (const row of rows as { id: string }[]) queued.add(row.id);
      };
      if (photoIds == null) {
        owed(this.db.query(query(() => '')).all());
        continue;
      }
      // Chunked, as every other id list here is: a session brings back as many edited
      // photographs as the peers have between them, and a first clone of a developed
      // library is all of them at once - which as one `IN (...)` is more bound variables
      // than SQLite will take, and throws over a clone that has committed.
      for (const batch of inChunks(photoIds)) {
        const placeholders = batch.map(() => '?').join(', ');
        // The batch once per arm of `TOUCHED_BY_EDITS`, each of which names the changed photograph.
        owed(
          this.db
            .query(query((column) => `AND ${column} IN (${placeholders})`))
            .all(...batch, ...batch, ...batch),
        );
      }
    }
    // A photograph queued by this predicate is one whose settings moved, so whatever
    // the last attempt failed on is not what it would be asked to render now.
    for (const batch of inChunks([...queued])) {
      const placeholders = batch.map(() => '?').join(', ');
      this.db.query(`UPDATE photos SET processing_error = NULL WHERE id IN (${placeholders})`).run(...batch);
    }
    return queued.size;
  }

  /**
   * These variants of every photograph of a library, for a catalogue rebuild.
   *
   * One statement rather than resolving every id first: a rebuild is the whole
   * library, and a selection-shaped request would spend the round trip on an id list
   * nobody needs.
   */
  queueLibrary(libraryId: string, variants: readonly RenditionVariant[]): number {
    let changed = 0;
    for (const variant of variants) {
      changed += this.db
        .query(
          `INSERT INTO renditions (photo_id, variant, needs_build)
             SELECT p.id, ?, 1 FROM photos p
              WHERE p.library_id = ? AND p.is_missing = 0 AND p.is_deleted = 0
           ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 1`,
        )
        .run(variant, libraryId).changes;
    }
    return changed;
  }
}

// Splits a value list into runs that fit under SQLITE_MAX_VARIABLE_NUMBER (999 on
// old builds), so a caller can pass an unbounded set to an IN (...) query.
function* inChunks(values: readonly string[], size = 900): Generator<readonly string[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}
