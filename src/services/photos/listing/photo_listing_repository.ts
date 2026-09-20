import type { Database } from '../../../db/driver';
import type { Ordering } from '../../../schemas/common';
import { EditDocSchema } from '../../../schemas/photo_edits';
import type { PhotoDaysResponse, PhotoDetail, PhotoModelsResponse, PhotoSummary, Triage } from '../../../schemas/photos';
import {
  detailColumns,
  type DetailRow,
  NOT_A_FRAME,
  summaryColumns,
  type SummaryRow,
  WHOLE_STACK,
  inAlbum,
  inShoot,
  conditions,
  ownShoot,
  representativeFilter,
  scoped,
  sizeExpression,
  toDetail,
  toSummary,
  type MemberScope,
  orderByClause,
} from './photo_query';


/** Runs of positions in a filtered listing, both ends inclusive (§18.3.3). */
export type SelectionRanges = readonly { start: number; end: number }[];

export interface PhotoListFilters {
  includeDeleted: boolean;
  isMissing?: boolean;
  // Whether to include the photographs put away. Omitted is the only value that is not a chip:
  // it is where every listing starts, so it intersects. `true` is an ordinary chip and honours
  // `match`, so "hidden or picked" is a grid holding both.
  isHidden?: boolean;
  // One shoot whose hiding this listing does not apply, which is the shoot a listing *of* one shoot
  // is scoped to: asking a hidden shoot for its photographs is asking for them, and the alternative
  // is a page that opens onto nothing. Every other hidden shoot still hides, so a stack straddling
  // one is not dragged into view along with it.
  exemptShoot?: string;
  // Scope rather than a chip: under `match: 'any'` a chip is unioned away.
  noShoot?: boolean;
  // Only meaningful together with includeDeleted, which lifts the blanket
  // is_deleted = 0 clause this then narrows back down (the Bin view).
  isDeleted?: boolean;
  // true = rated at all (>= 1 star), false = unrated. Culling is mostly "show me
  // what I haven't judged yet", which a rating-equals filter can't express.
  rated?: boolean;
  // Verdicts to include; omitted means all three.
  triage?: Triage[];
  // Case-insensitive substring of file_path.
  search?: string;
  // Inclusive YYYY-MM-DD bounds on when the photo was taken.
  takenFrom?: string;
  takenTo?: string;
  // Bodies and lenses to include, spelled as the RAW header spelled them.
  cameraModels?: string[];
  lensModels?: string[];
  // 'any' unions the rated/triage/isMissing/isHidden filters instead of intersecting them.
  // Scope (deleted, no-shoot, search, dates) always intersects.
  match?: 'all' | 'any';
  // Every photograph of a stack as a row of its own, instead of the stack as one
  // row (§19.5.4). Collapsing is a filter, so this is nothing but its absence -
  // which is also why it costs less than the collapsed listing rather than more.
  expandStacks?: boolean;
  // Whether to answer with how many match. Defaults on; a client walking a
  // collection block by block turns it off after the first (§18.3.2).
  count?: boolean;
}

export interface PhotoListResult {
  photos: UnresolvedSummary[];
  /** Absent when the caller asked not to count (`PhotoListFilters.count`). */
  total?: number;
  /**
   * How many photographs match, counting every member of a stack rather than the
   * stack as one. Equal to `total` on an uncollapsed listing. Absent alongside it.
   *
   * A composite's frames are not among them: a stack's members are counted because the reader can
   * expand it and act on each, where a frame cannot be reached at all while the composite stands
   * for it.
   */
  photoTotal?: number;
}

/**
 * A row as this repository can answer for it: everything but which rendition to draw it
 * from, which is the library's and the settings' business and neither is here (§18.5).
 *
 * Typed as its absence rather than filled with a plausible default. `embedded` is a legal
 * answer for any photograph and the camera's JPEG never 404s, so a path that forgot to
 * resolve it served the wrong picture silently, for good; missing, the same mistake is a
 * compile error, and `withShownRendition` is the only thing that can produce the full type.
 */
// `has_embedded` joins the three below: it is a fact about the file's format, and a repository
// holds rows rather than the rule that reads one (§18.5). `withShownRendition` fills it in.
export type UnresolvedSummary = Omit<PhotoSummary, 'shown_rendition' | 'has_embedded'>;

export type UnresolvedDetail = Omit<
  PhotoDetail,
  'shown_rendition' | 'rendition_to_build' | 'rendition_stale' | 'has_embedded'
>;

export class PhotoListingRepository {
  constructor(private readonly db: Database) {}

  editOrientation(photoId: string): number {
      const row = this.db.query('SELECT doc FROM photo_edits WHERE photo_id = ?')
        .get(photoId) as { doc: string } | null;
      if (row == null) return 0;
      try {
        const doc = EditDocSchema.safeParse(JSON.parse(row.doc));
        return doc.success ? doc.data.rotate : 0;
      } catch {
        return 0;
      }
    }
  getById(id: string): UnresolvedDetail | null {
      const row = this.db
        .query(
          `SELECT ${detailColumns()}, l.ordering AS lib_ordering,
                  (SELECT e.doc FROM photo_edits e WHERE e.photo_id = photos.id) AS edited
             FROM photos JOIN libraries l ON l.id = photos.library_id WHERE photos.id = ?`,
        )
        .get(id) as DetailRow | null;
      if (row == null) return null;
      const albums = this.db.query('SELECT album_id FROM album_photos WHERE photo_id = ?').all(id) as { album_id: string }[];
      return toDetail(
        row,
        albums.map((a) => a.album_id),
      );
    }
  listByLibrary(libraryId: string, ordering: Ordering, offset: number, limit: number, filters: PhotoListFilters): PhotoListResult {
      return this.list('FROM photos WHERE library_id = ?', [libraryId], ordering, offset, limit, filters, WHOLE_STACK, WHOLE_STACK);
    }
  listByShoot(shootId: string, ordering: Ordering, offset: number, limit: number, filters: PhotoListFilters): PhotoListResult {
      return this.list(
        'FROM photos WHERE shoot_id = ?',
        [shootId],
        ordering,
        offset,
        limit,
        ownShoot(shootId, filters),
        inShoot(shootId),
        WHOLE_STACK,
      );
    }
  listByAlbum(albumId: string, ordering: Ordering, offset: number, limit: number, filters: PhotoListFilters): PhotoListResult {
      return this.list(
        'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
        [albumId],
        ordering,
        offset,
        limit,
        filters,
        inAlbum(albumId),
        inAlbum(albumId),
      );
    }
  idsInLibrary(libraryId: string, ordering: Ordering, ranges: SelectionRanges, filters: PhotoListFilters): string[] {
      return this.idsAt('FROM photos WHERE library_id = ?', [libraryId], ordering, ranges, filters, WHOLE_STACK);
    }
  idsInShoot(shootId: string, ordering: Ordering, ranges: SelectionRanges, filters: PhotoListFilters): string[] {
      return this.idsAt('FROM photos WHERE shoot_id = ?', [shootId], ordering, ranges, ownShoot(shootId, filters), inShoot(shootId));
    }
  idsInAlbum(albumId: string, ordering: Ordering, ranges: SelectionRanges, filters: PhotoListFilters): string[] {
      return this.idsAt(
        'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
        [albumId],
        ordering,
        ranges,
        filters,
        inAlbum(albumId),
      );
    }
  modelsInLibrary(libraryId: string, filters: PhotoListFilters): PhotoModelsResponse {
      return this.models('FROM photos WHERE library_id = ?', [libraryId], filters);
    }
  modelsInShoot(shootId: string, filters: PhotoListFilters): PhotoModelsResponse {
      return this.models('FROM photos WHERE shoot_id = ?', [shootId], ownShoot(shootId, filters));
    }
  modelsInAlbum(albumId: string, filters: PhotoListFilters): PhotoModelsResponse {
      return this.models(
        'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
        [albumId],
        filters,
      );
    }
  // Every body and lens a listing holds, under the same filters the listing runs:
    // a body whose every frame is in the bin is not one the gallery can be narrowed
    // to, and offering it there is a tick that empties the grid.
    private models(fromWhere: string, baseParams: string[], filters: PhotoListFilters): PhotoModelsResponse {
      const { where, params } = scoped(fromWhere, baseParams, filters);
      const pairs = this.db
        .query(
          `SELECT DISTINCT photos.camera_model, photos.lens_model ${where}
             AND (photos.camera_model IS NOT NULL OR photos.lens_model IS NOT NULL)`,
        )
        .all(...params) as PhotoModelsResponse['pairs'];
      return { pairs };
    }
  daysInLibrary(libraryId: string, filters: PhotoListFilters): PhotoDaysResponse {
      return this.days('FROM photos WHERE library_id = ?', [libraryId], filters);
    }
  daysInShoot(shootId: string, filters: PhotoListFilters): PhotoDaysResponse {
      return this.days('FROM photos WHERE shoot_id = ?', [shootId], ownShoot(shootId, filters));
    }
  daysInAlbum(albumId: string, filters: PhotoListFilters): PhotoDaysResponse {
      return this.days('FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?', [albumId], filters);
    }
  private days(fromWhere: string, baseParams: string[], filters: PhotoListFilters): PhotoDaysResponse {
      const { where, params } = scoped(fromWhere, baseParams, filters);
      // substr rather than date(): date_taken is the camera's wall clock stored as a Z
      // string, so its first ten characters are the day the shutter fired wherever it
      // fired - and they are what the range filter above compares against.
      const days = this.db
        .query(
          `SELECT substr(COALESCE(photos.date_taken, photos.date_added), 1, 10) AS day, COUNT(*) AS count
             ${where} GROUP BY day ORDER BY day`,
        )
        .all(...params) as PhotoDaysResponse['days'];
      return { days };
    }
  private list(
      fromWhere: string,
      baseParams: string[],
      ordering: Ordering,
      offset: number,
      limit: number,
      filters: PhotoListFilters,
      promotion: MemberScope,
      counting: MemberScope,
    ): PhotoListResult {
      const { where, params } = scoped(fromWhere, baseParams, filters);
      const one = representativeFilter(filters, promotion);
      const size = sizeExpression(filters, counting);
      // Counted only when asked. No ordering index can cover it - the filter chips
      // vary, so it is a scan of everything that matches - and at a million photos
      // it is 774ms of a 792ms listing, re-run for each of ten thousand blocks a
      // scroll walks through, for a number that cannot move underneath it.
      //
      // `one.sql` and not a `DISTINCT` over the collapsing key that means the same thing: it selects
      // the rows, so counting it counts them, where a second expression of the same rule drifts from
      // it - and one entry too many reserves a grid slot nothing arrives for. In the SELECT rather
      // than the WHERE so `members`, the photographs those entries stand for, is the same pass.
      //
      // A frame is out of `members` too. It is one of *the composite's* photographs, not one of the
      // collection's, and the reader has no way to reach it or act on it while the composite stands
      // for it - so counting it would put "27 photos" under a grid holding one.
      const counts =
        filters.count === false
          ? undefined
          : (this.db
              .query(
                `SELECT COALESCE(SUM(CASE WHEN ${NOT_A_FRAME} THEN 1 ELSE 0 END), 0) AS members,
                        COALESCE(SUM(CASE WHEN ${one.sql} THEN 1 ELSE 0 END), 0) AS entries ${where}`,
              )
              .get(...one.params, ...params) as { members: number; entries: number });
      const total = counts?.entries;
      const rows = this.db
        .query(
          `SELECT ${summaryColumns()}, ${size.sql} AS stack_size ${where} AND ${one.sql}
           ORDER BY ${orderByClause(ordering)} LIMIT ? OFFSET ?`,
        )
        // Bound in the order the placeholders appear in the text, and the size
        // expression is in the SELECT list, so it comes before the scope.
        .all(...size.params, ...params, ...one.params, limit, offset) as SummaryRow[];
  
      return { photos: rows.map((r) => toSummary(r, ordering)), total, photoTotal: counts?.members };
    }
  // The ids at runs of positions in the same filtered, ordered listing the grid
    // is built from, which is how a selection made by position is acted on without
    // any of those ids ever reaching a client (§18.3.3).
    //
    // One query for the whole selection, not one per run. A run costs the same
    // whether it covers ten photos or a hundred thousand, but the *sort* costs the
    // whole collection every time it is asked for - so resolving five hundred
    // scattered picks as five hundred `LIMIT/OFFSET` queries meant five hundred
    // sorts of the library, which at a million photos is seven minutes of
    // uninterruptible server for a few hundred ctrl-clicks. Numbering the rows
    // once and reading the runs out of that numbering is a single sort.
    private idsAt(
      fromWhere: string,
      baseParams: string[],
      ordering: Ordering,
      ranges: SelectionRanges,
      filters: PhotoListFilters,
      promotion: MemberScope,
    ): string[] {
      if (ranges.length === 0) return [];
      const { where, params } = scoped(fromWhere, baseParams, filters);
      const one = representativeFilter(filters, promotion);
      // The runs are ascending and disjoint (`PhotoSelectionSchema`), so the last
      // one's end bounds the numbering: nothing past it is ever asked for.
      const last = ranges[ranges.length - 1]!.end;
      const spans = ranges.map(() => 'position BETWEEN ? AND ?').join(' OR ');
      const bounds = ranges.flatMap(({ start, end }) => [start, end]);
      // Numbered over the *collapsed* listing, because that is the listing the grid
      // was built from: number the raw rows instead and position 400 means one
      // photograph to the client and a different one here (§19.5.1).
      //
      // Selecting a stack then means selecting every photograph in it, and the join
      // below is the whole of how that happens: a chosen row stands for its stack,
      // so expanding it to its members is one join in one place and no client ever
      // holds a member id to do it with.
      //
      // The member set has to match whatever `stack_size` counted, or the number on
      // the tile and the set the action touches are two different things. That is
      // the same pair of scopes the listing was built with: an album is strict, a
      // shoot acts on the stack whole, and both honour the listing's own view of
      // the bin - the Bin is nothing but deleted rows, and a member set that
      // excluded those would resolve every selection there to nothing.
      //
      // Uncollapsed, the row *is* the photograph, so that join arm comes off with
      // the collapse: picking one frame of a burst out of an expanded grid must act
      // on that frame alone (§19.5.4).
      const members = conditions(filters, 'm.');
      const memberVisible = [...(promotion.sql === '' ? [] : [promotion.sql]), ...members.clauses];
      const standsForStack = filters.expandStacks !== true;
      const rows = this.db
        .query(
          `SELECT m.id FROM (
             SELECT id, stack_id, ROW_NUMBER() OVER (ORDER BY ${orderByClause(ordering)}) - 1 AS position
             ${where} AND ${one.sql} LIMIT ?
           ) chosen
           JOIN photos m
             ON m.id = chosen.id${standsForStack ? `
             OR (chosen.stack_id IS NOT NULL AND m.stack_id = chosen.stack_id)` : ''}
           WHERE (${spans})${memberVisible.map((clause) => ` AND ${clause}`).join('')}`,
        )
        // Bound in the order the placeholders appear in the text: the scoped rows,
        // the representative filter, the bound on the numbering, the runs being
        // read out, then the member set.
        .all(...params, ...one.params, last + 1, ...bounds, ...promotion.params, ...members.params) as { id: string }[];
      return [...new Set(rows.map((row) => row.id))];
    }
}
