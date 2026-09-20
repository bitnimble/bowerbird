import type { Database } from '../../../db/driver';
import type { Ordering } from '../../../schemas/common';
import type { PhotoListFilters, UnresolvedSummary } from './photo_listing_repository';
import { IN_CHUNK, inChunks } from '../photo_batches';
import {
  type MemberScope,
  RANGE_LIMIT,
  summaryColumns,
  type SummaryRow,
  WHOLE_STACK,
  inAlbum,
  inShoot,
  ownShoot,
  orderByClause,
  representativeFilter,
  scoped,
  toSummary,
  uncollapsed,
} from './photo_query';

/** Either end of a range of the listing, inclusive. Null is that end of the collection. */
export interface RangeBounds {
  from: string | null;
  to: string | null;
}

export class PhotoNavigationRepository {
  constructor(private readonly db: Database) {}

  positionsInLibrary(
      libraryId: string,
      ordering: Ordering,
      keys: readonly string[],
      filters: PhotoListFilters,
    ): Map<string, number[]> {
      return this.positionsAt('FROM photos WHERE library_id = ?', [libraryId], ordering, keys, filters, WHOLE_STACK);
    }
  positionsInShoot(shootId: string, ordering: Ordering, keys: readonly string[], filters: PhotoListFilters): Map<string, number[]> {
      return this.positionsAt('FROM photos WHERE shoot_id = ?', [shootId], ordering, keys, ownShoot(shootId, filters), inShoot(shootId));
    }
  positionsInAlbum(albumId: string, ordering: Ordering, keys: readonly string[], filters: PhotoListFilters): Map<string, number[]> {
      return this.positionsAt(
        'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
        [albumId],
        ordering,
        keys,
        filters,
        inAlbum(albumId),
      );
    }
  /**
     * Where given rows sit in a scoped, ordered, filtered listing (§19.6.1).
     *
     * A key is a photo id or a stack id, and a row answers to whichever of the two
     * the caller asked about: a stack id names the one collapsed row that stack has,
     * and in an uncollapsed listing (§19.5.4) it names every member of it - which is
     * why the answer is positions rather than a position. So one lookup re-places an
     * open band, and the same one carries a selection across a change of listing
     * whether it was made on stacks, on members, or on both.
     *
     * One query for every key, never one per key. Numbering rows costs an ordered
     * pass over the collection, which is the same trap `idsAt` records: ten open
     * bands must not mean ten passes.
     */
    private positionsAt(
      fromWhere: string,
      baseParams: string[],
      ordering: Ordering,
      keys: readonly string[],
      filters: PhotoListFilters,
      promotion: MemberScope,
    ): Map<string, number[]> {
      const found = new Map<string, number[]>();
      if (keys.length === 0) return found;
      const { where, params } = scoped(fromWhere, baseParams, filters);
      const one = representativeFilter(filters, promotion);
      // Half the usual chunk, because each key is bound twice: the budget is in
      // SQLite variables rather than in keys.
      for (const batch of inChunks(keys, IN_CHUNK / 2)) {
        const wanted = new Set(batch);
        const placeholders = batch.map(() => '?').join(', ');
        const rows = this.db
          .query(
            `SELECT id, stack_id, position FROM (
               SELECT photos.id AS id, photos.stack_id AS stack_id,
                      ROW_NUMBER() OVER (ORDER BY ${orderByClause(ordering)}) - 1 AS position
               ${where} AND ${one.sql}
             ) WHERE id IN (${placeholders}) OR stack_id IN (${placeholders})`,
          )
          .all(...params, ...one.params, ...batch, ...batch) as { id: string; stack_id: string | null; position: number }[];
        // Under *both* keys where both were asked for, never under one of them: a
        // key names every position it stands for, so a member named by its own id
        // must not be subtracted from what its stack names. Filed under one, the
        // answer for a stack also depended on whether a sibling landed in the same
        // chunk.
        const file = (key: string, position: number): void => {
          const at = found.get(key);
          if (at == null) found.set(key, [position]);
          else at.push(position);
        };
        for (const row of rows) {
          if (wanted.has(row.id)) file(row.id, row.position);
          if (row.stack_id != null && wanted.has(row.stack_id)) file(row.stack_id, row.position);
        }
      }
      for (const at of found.values()) at.sort((a, b) => a - b);
      return found;
    }
  // --- stepping through the viewer (§19.5.3) ---
  
    neighboursInLibrary(
      libraryId: string,
      ordering: Ordering,
      photoId: string,
      limit: number,
      filters: PhotoListFilters,
    ): UnresolvedSummary[] {
      return this.neighboursAt('FROM photos WHERE library_id = ?', [libraryId], ordering, photoId, limit, filters);
    }
  neighboursInShoot(shootId: string, ordering: Ordering, photoId: string, limit: number, filters: PhotoListFilters): UnresolvedSummary[] {
      return this.neighboursAt('FROM photos WHERE shoot_id = ?', [shootId], ordering, photoId, limit, ownShoot(shootId, filters));
    }
  neighboursInAlbum(albumId: string, ordering: Ordering, photoId: string, limit: number, filters: PhotoListFilters): UnresolvedSummary[] {
      return this.neighboursAt(
        'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
        [albumId],
        ordering,
        photoId,
        limit,
        filters,
      );
    }
  /**
     * The run of photographs around one, in this collection's order and
     * **uncollapsed**.
     *
     * The listing collapses a stack to one row so it is one tile (§19.5.1).
     * Stepping through the viewer is the one place that has to see every frame, so
     * this is the same scope, the same filters and the same sort with
     * `representativeFilter` left off - which is the whole of the difference, and
     * why it costs less than the listing it is taken from.
     *
     * Note the absence of a `MemberScope`: that absence *is* the feature.
     *
     * A seek off the anchor's own sort key, never an offset. A position in an
     * uncollapsed listing is not something the client holds, and computing one is
     * the `ROW_NUMBER` pass §19.5.1 measures in the hundreds of milliseconds -
     * per arrow press. Nothing here is a position, so the grid's numbering is
     * untouched.
     */
    private neighboursAt(
      fromWhere: string,
      baseParams: string[],
      ordering: Ordering,
      photoId: string,
      limit: number,
      filters: PhotoListFilters,
    ): UnresolvedSummary[] {
      // Read through the scope but *not* the filters, deliberately. A photograph
      // the view excludes - the reject a verdict was just set on - still has
      // neighbours, because the seek compares its sort key rather than asking
      // whether it is in the listing. Outside the collection entirely it answers
      // with nothing, so a photo deep-linked from another library is a dead end
      // rather than a walk through this one.
      const anchor = this.db.query(`SELECT ${summaryColumns()} ${fromWhere} AND photos.id = ?`).get(...baseParams, photoId) as
        | SummaryRow
        | null;
      if (anchor == null) return [];
  
      const { where, params } = uncollapsed(fromWhere, baseParams, filters);
      return [
        ...this.seek(where, params, ordering, anchor, 'back', limit).reverse(),
        anchor,
        ...this.seek(where, params, ordering, anchor, 'forward', limit),
      ].map((row) => toSummary(row, ordering));
    }
  rangeInLibrary(libraryId: string, ordering: Ordering, bounds: RangeBounds, filters: PhotoListFilters): UnresolvedSummary[] {
      return this.rangeAt('FROM photos WHERE library_id = ?', [libraryId], ordering, bounds, filters);
    }
  rangeInShoot(shootId: string, ordering: Ordering, bounds: RangeBounds, filters: PhotoListFilters): UnresolvedSummary[] {
      return this.rangeAt('FROM photos WHERE shoot_id = ?', [shootId], ordering, bounds, ownShoot(shootId, filters));
    }
  rangeInAlbum(albumId: string, ordering: Ordering, bounds: RangeBounds, filters: PhotoListFilters): UnresolvedSummary[] {
      return this.rangeAt(
        'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
        [albumId],
        ordering,
        bounds,
        filters,
      );
    }
  /**
     * Everything between two photographs, inclusive, uncollapsed.
     *
     * The same listing `neighboursAt` walks, asked for by its ends rather than by a
     * middle: a caller that already knows what sits either side of a run - the
     * photographs a stack lies between, say - gets the run itself without having to
     * know the collection's ordering, or which end of it is "after".
     *
     * Either bound may be null for the start or end of the collection. A bound that
     * is not in the scope is treated as absent rather than as an error, because a
     * caller holding an id from before a re-order should get a usable answer rather
     * than a failure.
     */
    private rangeAt(
      fromWhere: string,
      baseParams: string[],
      ordering: Ordering,
      bounds: RangeBounds,
      filters: PhotoListFilters,
    ): UnresolvedSummary[] {
      const anchorOf = (photoId: string | null): SummaryRow | null =>
        photoId == null
          ? null
          : ((this.db.query(`SELECT ${summaryColumns()} ${fromWhere} AND photos.id = ?`).get(...baseParams, photoId) ?? null) as
              | SummaryRow
              | null);
      const from = anchorOf(bounds.from);
      const to = anchorOf(bounds.to);
  
      const { where, params } = uncollapsed(fromWhere, baseParams, filters);
      const clauses: string[] = [];
      const args: (string | number)[] = [...params];
      // Each bound is the same key comparison the seek uses, in the direction the
      // ordering runs, so the two agree about what "between" means.
      for (const [row, side] of [
        [from, 'from'],
        [to, 'to'],
      ] as const) {
        if (row == null) continue;
        const bound = this.boundClause(ordering, row, side);
        clauses.push(bound.sql);
        args.push(...bound.params);
      }
  
      // Capped, and read from the bound that exists. An absent bound means "that end
      // of the collection", which in a large one is most of it - and a caller cannot
      // always tell "the collection ended" from "my window ended", so an open end is
      // routinely a question about a few rows that would answer with a hundred
      // thousand. Reading from the wrong end would return a page of the collection
      // containing none of what was asked about, which is worse than truncating.
      const leading = from != null || to == null;
      args.push(RANGE_LIMIT);
      const rows = this.db
        .query(`SELECT ${summaryColumns()} ${where}${clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''}
           ORDER BY ${orderByClause(ordering, 'photos.', !leading)} LIMIT ?`)
        .all(...args) as SummaryRow[];
      if (!leading) rows.reverse();
      return rows.map((row) => toSummary(row, ordering));
    }
  /**
     * One end of a range, as a comparison on the key the listing orders by.
     *
     * `from` keeps everything at or after its row, `to` everything at or before it,
     * where "after" means later in this ordering rather than larger.
     *
     * `taken_*` sorts undated photographs last **in both directions** - the flag
     * leads the ORDER BY and is always ascending - so the two groups have to be
     * spelled out. A dated bound admits the whole undated tail on its after side and
     * none of it on its before side; an undated bound admits every dated row on its
     * before side and none on its after side. Within the tail the rows are ordered
     * by id in the ordering's own direction, which is why the same comparison
     * serves there too.
     */
    private boundClause(ordering: Ordering, row: SummaryRow, side: 'from' | 'to'): { sql: string; params: (string | number)[] } {
      const ascending = ordering === 'taken_asc' || ordering === 'added_asc';
      const keepsAfter = side === 'from';
      const cmp = keepsAfter === ascending ? '>=' : '<=';
  
      if (ordering === 'added_asc' || ordering === 'added_desc') {
        return { sql: `(photos.date_added, photos.id) ${cmp} (?, ?)`, params: [row.date_added, row.id] };
      }
      // `(date_taken IS NULL) = 0|1` rather than `IS NOT NULL` / `IS NULL`, for the
      // reason `seekArm` gives: that expression is what the ordering index leads
      // with, and only the exact spelling matches it.
      if (row.date_taken == null) {
        return keepsAfter
          ? { sql: `((photos.date_taken IS NULL) = 1 AND photos.id ${cmp} ?)`, params: [row.id] }
          : { sql: `((photos.date_taken IS NULL) = 0 OR photos.id ${cmp} ?)`, params: [row.id] };
      }
      return keepsAfter
        ? { sql: `((photos.date_taken IS NULL) = 1 OR (photos.date_taken, photos.id) ${cmp} (?, ?))`, params: [row.date_taken, row.id] }
        : { sql: `((photos.date_taken IS NULL) = 0 AND (photos.date_taken, photos.id) ${cmp} (?, ?))`, params: [row.date_taken, row.id] };
    }
  // `taken_*` sorts undated photographs last, so the listing is two groups and a
    // seek has to know which one it is in. `added_*` has one group, because
    // `date_added` is never null.
    private seek(
      where: string,
      params: (string | number)[],
      ordering: Ordering,
      anchor: SummaryRow,
      direction: 'forward' | 'back',
      limit: number,
    ): SummaryRow[] {
      const byTaken = ordering === 'taken_asc' || ordering === 'taken_desc';
      if (!byTaken) return this.seekArm(where, params, ordering, anchor, direction, limit, 'dated');
  
      const undated = anchor.date_taken == null;
      const rows = this.seekArm(where, params, ordering, anchor, direction, limit, undated ? 'undated' : 'dated');
      if (rows.length >= limit) return rows;
  
      // The run reached the end of its own group with room to spare, so it carries
      // on into the other one - forward out of the dated group into the undated
      // tail, back out of the undated tail into the dated rows. Unseeded, because
      // it enters that group at its first row rather than beside anything.
      const crossesForward = direction === 'forward' && !undated;
      const crossesBack = direction === 'back' && undated;
      if (!crossesForward && !crossesBack) return rows;
      return [...rows, ...this.seekArm(where, params, ordering, anchor, direction, limit - rows.length, undated ? 'dated' : 'undated', true)];
    }
  private seekArm(
      where: string,
      params: (string | number)[],
      ordering: Ordering,
      anchor: SummaryRow,
      direction: 'forward' | 'back',
      limit: number,
      group: 'dated' | 'undated',
      unseeded = false,
    ): SummaryRow[] {
      const forward = direction === 'forward';
      const ascending = (ordering === 'taken_asc' || ordering === 'added_asc') === forward;
      const dir = ascending ? 'ASC' : 'DESC';
      const cmp = ascending ? '>' : '<';
      const byTaken = ordering === 'taken_asc' || ordering === 'taken_desc';
      const column = byTaken ? 'photos.date_taken' : 'photos.date_added';
  
      const clauses: string[] = [];
      const args: (string | number)[] = [...params];
      if (byTaken) {
        // Spelled as the indexed *expression* `(date_taken IS NULL)`, never as
        // `IS NULL` / `IS NOT NULL` on the column. `idx_photos_*_order_taken` leads
        // with that expression, and only the exact expression matches it - written
        // the other way the leading column is unconstrained, so the row-value
        // comparison below cannot become a range constraint either and the whole
        // collection is scanned into a temp b-tree. 0.01ms against 4.8ms at 40k
        // rows, and it is on the path of every viewer open.
        clauses.push(`(${column} IS NULL) = ${group === 'undated' ? 1 : 0}`);
      }
      if (!unseeded) {
        if (group === 'undated') {
          clauses.push(`photos.id ${cmp} ?`);
          args.push(anchor.id);
        } else {
          // A row value, which SQLite turns into a single index range constraint.
          // Spelled as two comparisons it becomes a scan.
          clauses.push(`(${column}, photos.id) ${cmp} (?, ?)`);
          args.push(byTaken ? (anchor.date_taken as string) : anchor.date_added, anchor.id);
        }
      }
      args.push(limit);
  
      // `date_taken IS NULL` is deliberately *not* in this ORDER BY, though
      // `orderByClause` leads with it: inside one arm it is a constant, and leaving
      // it in stops the ORDER BY matching the index - measured at 11ms against
      // 0.2ms, per arrow press.
      return this.db
        .query(
          `SELECT ${summaryColumns()} ${where}${clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''}
           ORDER BY ${column} ${dir}, photos.id ${dir} LIMIT ?`,
        )
        .all(...args) as SummaryRow[];
    }
}
