import type { Database } from 'bun:sqlite';
import { OrderingSchema, type Ordering } from '../../schemas/common';
import type { PhotoDetail, PhotoSummary, Triage } from '../../schemas/photos';
import type { ViewerRendition } from '../../schemas/settings';
import type { RenditionSource } from '../processing/processing_types';
import { refreshRepresentative } from '../stacks/representative';

/** Runs of positions in a filtered listing, both ends inclusive (§18.3.3). */
export type SelectionRanges = readonly { start: number; end: number }[];

export interface PhotoListFilters {
  includeDeleted: boolean;
  isMissing?: boolean;
  // Photos with no grid tile yet, which is what a gallery means by "no rendition".
  needsTile?: boolean;
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
  // 'any' unions the rated/triage/isMissing/needsTile filters instead of
  // intersecting them. Scope (deleted, search, dates) always intersects.
  match?: 'all' | 'any';
  // Whether to answer with how many match. Defaults on; a client walking a
  // collection block by block turns it off after the first (§18.3.2).
  count?: boolean;
}

export interface PhotoListResult {
  photos: PhotoSummary[];
  /** Absent when the caller asked not to count (`PhotoListFilters.count`). */
  total?: number;
}

export interface SyncInsert {
  id: string;
  library_id: string;
  shoot_id: string | null;
  file_hash: string;
  file_path: string;
  width: number;
  height: number;
  orientation: number;
  date_taken: string | null;
  date_taken_offset: string | null;
  date_added: string;
  date_updated: string | null;
  file_size: number;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutter_speed: number | null;
  aperture: number | null;
  focal_length: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
}

export interface SyncModification {
  file_hash: string;
  width: number;
  height: number;
  orientation: number;
  date_taken: string | null;
  date_taken_offset: string | null;
  date_updated: string | null;
  file_size: number;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutter_speed: number | null;
  aperture: number | null;
  focal_length: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
}

// Everything a re-read of the RAW header can refresh: no hash, no timestamps of
// our own, nothing that says the file changed.
export type PhotoMetadataFields = Omit<SyncModification, 'file_hash' | 'file_size' | 'date_updated'>;

// Fields the scan quick-check needs to decide whether to re-open a file (§9.1).
export interface SyncDbPhoto {
  id: string;
  file_path: string;
  file_hash: string | null;
  is_missing: boolean;
  date_updated: string | null;
  file_size: number | null;
}

export interface PendingPhoto {
  photo_id: string;
  file_path: string;
  root_path: string;
  data_path: string | null;
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
  rendition_hdr_video: number;
}

// Minimal shape for file/shoot bookkeeping (moves, adoption, reconciliation).
export interface BasicPhoto {
  id: string;
  library_id: string;
  file_path: string;
  shoot_id: string | null;
}

/** A binned row and where it came from, which is everything a restore needs (§12.3). */
export interface DeletedPhoto extends BasicPhoto {
  deleted_from_path: string | null;
}

// Bounds selecting exactly the file_paths under `folderPath` (prefix + '/').
// '0' (0x30) is the character right after '/' (0x2F), so [P+'/', P+'0') is the
// half-open range of all strings beginning with P+'/', index-friendly on file_path.
function folderRange(folderPath: string): [string, string] {
  return [`${folderPath}/`, `${folderPath}0`];
}

// Qualified with `photos.` because listByAlbum joins album_photos, which also has
// a date_added column (bare names would be ambiguous).
const SUMMARY_COLS =
  'photos.id, photos.library_id, photos.shoot_id, photos.file_path, photos.width, photos.height, photos.date_taken, photos.date_added, photos.date_updated, photos.tile_built_at, photos.renditions_built_at, photos.viewer_rendition, photos.triage, photos.rating, photos.is_missing, photos.is_deleted, photos.stack_id';

// How wide a stack counts in a listing (§19.5.2).
//
// A shoot shows the whole stack and dims the members that are not in it, so its
// tile has to say how many photographs the stack holds. An album is strict about
// what it contains, so there its tile may only count the members the album
// holds. Both are the same window function over different row sets, which is why
// this is a flag and not two queries.
export type StackScope = 'collection' | 'album';

/**
 * Which row of a stack a listing shows: a **filter**, not a window function.
 *
 * This is the whole reason listings are still fast. A window function has to see
 * every scoped row before `LIMIT` can take a hundred of them, so it sorts the
 * collection for every block a scroll fetches - measured at 179ms a page against
 * 0.9ms for the same listing without stacks, on every library whether or not it
 * has any. Expressed as a filter, the ordering index is walked and stops at the
 * page, and a 200k library costs 5ms.
 *
 * Two arms:
 *
 * - the stored `is_representative` flag, which is the fast answer for almost
 *   every row: it is set on every unstacked photo and on one member of each
 *   stack, so the common case is an equality test;
 * - failing that, "this stack has no visible flagged member, and no visible
 *   member of it sorts before me" - which promotes the next survivor when the
 *   flagged one is hidden by a filter, by the bin, or by being in another shoot.
 *
 * The flag is therefore a hint rather than a truth. Stale or missing, the second
 * arm still returns the right row and only costs a little more; what it must
 * never be is set on *two* visible members of one stack, which would show that
 * stack twice. A partial unique index makes that an error rather than a
 * duplicate (`migrations.ts`).
 *
 * `memberScope` is how a member of the same stack is recognised as being in this
 * listing at all - the shoot it must be in, the album that must hold it - so a
 * shoot promotes to the newest *in-shoot* member and never shows a tile for a
 * photograph that is not in it.
 */
interface MemberScope {
  /** A predicate on alias `m`, or empty when the whole library is in scope. */
  sql: string;
  params: (string | number)[];
}

function representativeFilter(filters: PhotoListFilters, member: MemberScope): { sql: string; params: (string | number)[] } {
  const { clauses, params } = conditions(filters, 'm.');
  const visible = [...(member.sql === '' ? [] : [member.sql]), ...clauses].join(' AND ');
  const inListing = visible === '' ? '' : ` AND ${visible}`;
  const memberParams = [...member.params, ...params];
  const taken = (alias: string) => `COALESCE(${alias}date_taken, ${alias}date_added)`;
  return {
    sql: `(photos.is_representative = 1 OR (photos.stack_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM photos m
          WHERE m.stack_id = photos.stack_id AND m.is_representative = 1${inListing})
        AND NOT EXISTS (
          SELECT 1 FROM photos m
          WHERE m.stack_id = photos.stack_id${inListing}
            AND (${taken('m.')} > ${taken('photos.')}
              OR (${taken('m.')} = ${taken('photos.')} AND m.id > photos.id)))))`,
    params: [...memberParams, ...memberParams],
  };
}

/**
 * How many photographs the tile stands for.
 *
 * A correlated count rather than a window, and only ever evaluated for the rows
 * a page actually returns. In a shoot or the library it is the stack's whole
 * membership, because those views show the stack whole and dim the members that
 * are elsewhere; in an album it is what the album holds, because an album is
 * strict (§19.5.2). Either way it honours the listing's own view of the bin, so
 * the number on the tile and the set an action touches are the same.
 */
function sizeExpression(filters: PhotoListFilters, counting: MemberScope): { sql: string; params: (string | number)[] } {
  const { clauses, params } = conditions(filters, 'm.');
  const visible = [...(counting.sql === '' ? [] : [counting.sql]), ...clauses].join(' AND ');
  return {
    sql: `CASE WHEN photos.stack_id IS NULL THEN 1 ELSE (
            SELECT COUNT(*) FROM photos m WHERE m.stack_id = photos.stack_id${visible === '' ? '' : ` AND ${visible}`}
          ) END`,
    params: [...counting.params, ...params],
  };
}

// A photo the rendition queue owes work on. `prefix` is the table alias the
// caller's query uses, empty when it has none.
const PENDING_PROCESSING = (prefix: string): string =>
  `(${prefix}needs_tile = 1 OR ${prefix}needs_renditions = 1) AND ${prefix}is_missing = 0 AND ${prefix}is_deleted = 0`;

// Splits a value list into runs that fit under SQLITE_MAX_VARIABLE_NUMBER (999 on
// old builds), so a caller can pass an unbounded set to an IN (...) query.
const IN_CHUNK = 900;
function* inChunks(values: readonly string[]): Generator<readonly string[]> {
  for (let i = 0; i < values.length; i += IN_CHUNK) yield values.slice(i, i + IN_CHUNK);
}

const SYNC_COLUMNS = 'id, file_path, file_hash, is_missing, date_updated, file_size';
interface SyncRow {
  id: string;
  file_path: string;
  file_hash: string | null;
  is_missing: number;
  date_updated: string | null;
  file_size: number | null;
}

// Qualified: getById joins libraries to resolve ordering_date, so `id` etc. would
// otherwise be ambiguous.
const DETAIL_COLS = `photos.id, photos.library_id, photos.shoot_id, photos.width, photos.height,
  photos.orientation, photos.file_path, photos.file_hash, photos.date_taken, photos.date_taken_offset, photos.date_added,
  photos.date_updated, photos.tile_built_at, photos.renditions_built_at,
  photos.needs_tile, photos.needs_renditions, photos.processing_error,
  photos.latitude, photos.longitude, photos.rating, photos.triage, photos.is_missing,
  photos.is_deleted, photos.notes, photos.file_size, photos.iso, photos.shutter_speed, photos.aperture,
  photos.focal_length, photos.camera_make, photos.camera_model, photos.lens_model, photos.rendition_source, photos.viewer_rendition,
  photos.stack_id`;

interface SummaryRow {
  id: string;
  library_id: string;
  shoot_id: string | null;
  stack_id: string | null;
  // Absent from the queries that read a photo rather than a listing; those rows
  // stand for themselves, which is a stack of one.
  stack_size?: number;
  file_path: string;
  width: number;
  height: number;
  date_taken: string | null;
  date_added: string;
  date_updated: string | null;
  tile_built_at: string | null;
  renditions_built_at: string | null;
  viewer_rendition: ViewerRendition | null;
  triage: string | null;
  rating: number;
  is_missing: number;
  is_deleted: number;
}

interface DetailRow extends SummaryRow {
  orientation: number;
  file_path: string;
  file_hash: string | null;
  // Detail only: a grid tile is labelled with a wall clock, and a zone per tile
  // would be noise on 100 of them.
  date_taken_offset: string | null;
  needs_tile: number;
  needs_renditions: number;
  processing_error: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  file_size: number | null;
  iso: number | null;
  shutter_speed: number | null;
  aperture: number | null;
  focal_length: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  rendition_source: RenditionSource | null;
  lib_ordering: string; // the owning library's ordering, for ordering_date
}

// `date_taken IS NULL` first keeps NULL capture dates last in both directions (DESIGN §5.1).
// `prefix` is the table's alias in the query being built, since the processing
// queue joins photos as `p` and orders by the same rule the grid reads by.
// The `id` tiebreak follows the direction of the sort it breaks, so a descending
// listing is the ordering index walked backwards rather than a temp b-tree over
// the whole library. Any total order will do - what matters is only that two
// separate LIMIT/OFFSET queries agree about which photo sits at which position
// (§18.3.3), which a tiebreak in either direction gives.
function orderByClause(ordering: Ordering, prefix = 'photos.'): string {
  switch (ordering) {
    case 'added_asc':
      return `${prefix}date_added ASC, ${prefix}id ASC`;
    case 'added_desc':
      return `${prefix}date_added DESC, ${prefix}id DESC`;
    case 'taken_asc':
      return `${prefix}date_taken IS NULL, ${prefix}date_taken ASC, ${prefix}id ASC`;
    case 'taken_desc':
      return `${prefix}date_taken IS NULL, ${prefix}date_taken DESC, ${prefix}id DESC`;
  }
}

// NULL in the column is the untriaged state on the wire.
function toTriage(value: string | null): Triage {
  return value === 'picked' || value === 'rejected' ? value : 'untriaged';
}

function orderingDate(ordering: Ordering, row: SummaryRow): string | null {
  return ordering === 'taken_asc' || ordering === 'taken_desc' ? row.date_taken : row.date_added;
}

function toSummary(row: SummaryRow, ordering: Ordering): PhotoSummary {
  return {
    id: row.id,
    library_id: row.library_id,
    shoot_id: row.shoot_id,
    file_path: row.file_path,
    width: row.width,
    height: row.height,
    ordering_date: orderingDate(ordering, row),
    triage: toTriage(row.triage),
    rating: row.rating,
    is_missing: row.is_missing === 1,
    is_deleted: row.is_deleted === 1,
    date_updated: row.date_updated,
    tile_built_at: row.tile_built_at,
    renditions_built_at: row.renditions_built_at,
    viewer_rendition: row.viewer_rendition,
    stack_id: row.stack_id,
    stack_size: row.stack_size ?? 1,
  };
}

function toDetail(row: DetailRow, albumIds: string[]): PhotoDetail {
  return {
    id: row.id,
    library_id: row.library_id,
    shoot_id: row.shoot_id,
    width: row.width,
    height: row.height,
    ordering_date: orderingDate(row.lib_ordering as Ordering, row),
    orientation: row.orientation,
    file_path: row.file_path,
    file_hash: row.file_hash,
    date_taken: row.date_taken,
    date_taken_offset: row.date_taken_offset,
    date_added: row.date_added,
    date_updated: row.date_updated,
    tile_built_at: row.tile_built_at,
    renditions_built_at: row.renditions_built_at,
    needs_tile: row.needs_tile === 1,
    needs_renditions: row.needs_renditions === 1,
    processing_error: row.processing_error,
    latitude: row.latitude,
    longitude: row.longitude,
    rating: row.rating,
    triage: toTriage(row.triage),
    is_missing: row.is_missing === 1,
    is_deleted: row.is_deleted === 1,
    notes: row.notes,
    file_size: row.file_size,
    iso: row.iso,
    shutter_speed: row.shutter_speed,
    aperture: row.aperture,
    focal_length: row.focal_length,
    camera_make: row.camera_make,
    camera_model: row.camera_model,
    lens_model: row.lens_model,
    rendition_source: row.rendition_source,
    viewer_rendition: row.viewer_rendition,
    // A photo read on its own stands for itself, whatever stack it belongs to:
    // the detail view opens one photograph, and collapsing is a property of a
    // listing rather than of a row.
    stack_id: row.stack_id,
    stack_size: 1,
    // All resolved by the service, which knows the library: they need its data
    // directory to stat or to build a path from, and its rendition settings. The
    // repository has no business doing either.
    original_path: null,
    default_rendition: 'embedded',
    renditions: null,
    album_ids: albumIds,
  };
}

// What a stack's other members are, for the two questions a collapsed listing
// asks about them (§19.5.1). `promotion` is which of them may stand for the
// stack here - a shoot's tile must be a photograph in that shoot - and `counting`
// is which of them the number on the tile is counting. They differ for a shoot,
// which shows the stack whole and dims the members that are elsewhere.
const WHOLE_STACK: MemberScope = { sql: '', params: [] };
const inAlbum = (albumId: string): MemberScope => ({
  sql: 'EXISTS (SELECT 1 FROM album_photos map WHERE map.photo_id = m.id AND map.album_id = ?)',
  params: [albumId],
});
const inShoot = (shootId: string): MemberScope => ({ sql: 'm.shoot_id = ?', params: [shootId] });

export class PhotosRepository {
  constructor(private readonly db: Database) {}

  getById(id: string): PhotoDetail | null {
    const row = this.db
      .query(`SELECT ${DETAIL_COLS}, l.ordering AS lib_ordering FROM photos JOIN libraries l ON l.id = photos.library_id WHERE photos.id = ?`)
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
    return this.list('FROM photos WHERE shoot_id = ?', [shootId], ordering, offset, limit, filters, inShoot(shootId), WHOLE_STACK);
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
    return this.idsAt('FROM photos WHERE shoot_id = ?', [shootId], ordering, ranges, filters, inShoot(shootId));
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

  update(id: string, fields: { rating?: number; triage?: Triage; notes?: string | null; viewer_rendition?: ViewerRendition }): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (fields.rating != null) {
      sets.push('rating = ?');
      params.push(fields.rating);
    }
    if (fields.triage != null) {
      sets.push('triage = ?');
      // 'untriaged' is stored as NULL, so clearing a verdict is a real update.
      params.push(fields.triage === 'untriaged' ? null : fields.triage);
    }
    if (fields.notes != null) {
      sets.push('notes = ?');
      params.push(fields.notes);
    }
    if (fields.viewer_rendition != null) {
      sets.push('viewer_rendition = ?');
      params.push(fields.viewer_rendition);
    }
    if (sets.length === 0) return this.db.query('SELECT 1 FROM photos WHERE id = ?').get(id) != null;
    params.push(id);
    // One transaction, so one commit. A verdict on a stacked photo is four
    // statements, and in autocommit that is four durable writes where a verdict
    // used to be one - measured at 3.65ms against 1.19ms, per keypress, which is
    // more than the correlated subquery it exists to save. Wrapped, it is 1.18ms.
    // It also closes the window in which a crash between the clear and the set
    // would leave a stack with no flagged member at all.
    return this.db.transaction(() => {
      const changed = this.db.query(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
      // A verdict can make the member a stack's tile stands for the wrong one to
      // stand for it. The listing would cope - its second arm promotes the newest
      // visible member - but that arm is a correlated subquery per row and the
      // flag exists to keep the common case an equality test. Rejecting the
      // representative is not an edge case: it is what a triage session does.
      if (changed && fields.triage != null) this.refreshStackOf(id);
      return changed;
    })();
  }

  // Only for a photo that is in a stack, and only on the stack it is in.
  private refreshStackOf(photoId: string): void {
    const row = this.db.query('SELECT stack_id FROM photos WHERE id = ?').get(photoId) as { stack_id: string | null } | null;
    if (row?.stack_id != null) refreshRepresentative(this.db, row.stack_id);
  }

  // One row, three columns, no joins: what the byte-serving paths need, as
  // opposed to getById's detail payload. Soft-deleted rows included, unlike
  // getBasicByIds below - the Bin is a browsable view and its images are served.
  getBasicById(id: string): BasicPhoto | null {
    return this.db.query('SELECT id, library_id, file_path, shoot_id FROM photos WHERE id = ?').get(id) as BasicPhoto | null;
  }

  // Excludes soft-deleted photos. Callers are shoot/album membership ops and
  // banner validation; a Bin-resident deleted photo must not be movable/settable
  // via these paths (it would escape the Bin while still flagged is_deleted and
  // get re-imported as a duplicate).
  getBasicByIds(ids: string[]): BasicPhoto[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db
      .query(`SELECT id, library_id, file_path, shoot_id FROM photos WHERE id IN (${placeholders}) AND is_deleted = 0`)
      .all(...ids) as BasicPhoto[];
  }

  // Photos belonging to `folderPath` (any depth), which for a live photo is where
  // its file is and for a soft-deleted one is where its file came from: the bin
  // is one tree at the library root (§12.3), so a binned photo's `file_path` sits
  // under the bin rather than under the folder it was taken from, and only
  // `deleted_from_path` still points at that folder.
  listUnderFolder(libraryId: string, folderPath: string, includeDeleted = false): BasicPhoto[] {
    const [lo, hi] = folderRange(folderPath);
    const live = 'is_deleted = 0 AND file_path >= ? AND file_path < ?';
    if (!includeDeleted) {
      return this.db
        .query(`SELECT id, library_id, file_path, shoot_id FROM photos WHERE library_id = ? AND ${live}`)
        .all(libraryId, lo, hi) as BasicPhoto[];
    }
    return this.db
      .query(
        `SELECT id, library_id, file_path, shoot_id FROM photos
           WHERE library_id = ?
             AND ((${live}) OR (is_deleted = 1 AND deleted_from_path >= ? AND deleted_from_path < ?))`,
      )
      .all(libraryId, lo, hi, lo, hi) as BasicPhoto[];
  }

  // Hands every photo under `folderPath` to that folder's shoot. Callers run it
  // shallowest folder first, so a deeper shoot's own claim lands last and wins,
  // which is the same "most specific folder" rule the per-photo path uses (§9.4).
  setShootForFolder(libraryId: string, folderPath: string, shootId: string): void {
    const [lo, hi] = folderRange(folderPath);
    this.db
      .query('UPDATE photos SET shoot_id = ? WHERE library_id = ? AND file_path >= ? AND file_path < ?')
      .run(shootId, libraryId, lo, hi);
  }

  // Removes the rows outright, unlike the soft delete in §12, which moves a file
  // to a Bin so it can come back. This is for a folder leaving the library (§4.7):
  // the files stay exactly where they are on disk, and what goes is the
  // catalogue's record of them. Album membership, banners and the rest cascade.
  deleteByIds(ids: readonly string[]): number {
    let deleted = 0;
    for (const batch of inChunks(ids)) {
      const placeholders = batch.map(() => '?').join(', ');
      deleted += this.db.query(`DELETE FROM photos WHERE id IN (${placeholders})`).run(...batch).changes;
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
  // A soft-deleted row's file is in the bin at the library root and did not move
  // with the folder, so its `file_path` is left exactly as it is. What does have
  // to follow is `deleted_from_path`: it is where a restore puts the photo back,
  // and left pointing at the old prefix a restore would recreate the folder that
  // was renamed away and put the photo outside the shoot it still belongs to.
  rewritePathPrefix(libraryId: string, oldFolderPath: string, newFolderPath: string): void {
    const [lo, hi] = folderRange(oldFolderPath);
    const tailFrom = oldFolderPath.length + 1; // 1-based: first char after the old prefix
    this.db
      .query(
        `UPDATE photos SET file_path = ? || substr(file_path, ?), is_missing = 0
           WHERE library_id = ? AND is_deleted = 0 AND file_path >= ? AND file_path < ?`,
      )
      .run(newFolderPath, tailFrom, libraryId, lo, hi);
    this.db
      .query(
        `UPDATE photos SET deleted_from_path = ? || substr(deleted_from_path, ?)
           WHERE library_id = ? AND is_deleted = 1 AND deleted_from_path >= ? AND deleted_from_path < ?`,
      )
      .run(newFolderPath, tailFrom, libraryId, lo, hi);
  }

  setShoot(photoId: string, shootId: string | null): void {
    this.db.query('UPDATE photos SET shoot_id = ? WHERE id = ?').run(shootId, photoId);
  }

  // Clears is_missing: callers (a user move, or sync applying a detected move)
  // run only after a specific file provably exists at the new path. Without this,
  // a concurrent sync whose setMissing landed just before the move committed
  // would leave the present photo stuck is_missing=1 until the next sync.
  setFilePathAndShoot(photoId: string, filePath: string, shootId: string | null): void {
    this.db.query('UPDATE photos SET file_path = ?, shoot_id = ?, is_missing = 0 WHERE id = ?').run(filePath, shootId, photoId);
  }

  setFilePath(photoId: string, filePath: string): void {
    this.db.query('UPDATE photos SET file_path = ?, is_missing = 0 WHERE id = ?').run(filePath, photoId);
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
  markDeleted(id: string, deletedFromPath: string, batch?: string): void {
    this.db.transaction(() => {
      this.db
        .query(
          'UPDATE photos SET is_deleted = 1, needs_tile = 0, needs_renditions = 0, deleted_from_path = ?, deleted_batch = ? WHERE id = ?',
        )
        .run(deletedFromPath, batch ?? null, id);
      // Binning is the other way the member a stack's tile stands for stops being
      // the one to stand for it, and `refreshRepresentative` ranks a binned member
      // last for exactly that reason. Without this the ranking would be a claim
      // nothing kept: bin a burst's keeper and that stack is on the slow arm for
      // good.
      this.refreshStackOf(id);
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
    return this.db
      .query(
        `SELECT id, library_id, file_path, shoot_id, deleted_from_path FROM photos WHERE id IN (${placeholders}) AND is_deleted = 1`,
      )
      .all(...ids) as DeletedPhoto[];
  }

  // The path this photo was at when it was binned, or null if it predates the
  // column (restore then falls back to the library root).
  getDeletedFromPath(id: string): string | null {
    const row = this.db.query('SELECT deleted_from_path FROM photos WHERE id = ?').get(id) as
      | { deleted_from_path: string | null }
      | null;
    return row?.deleted_from_path ?? null;
  }

  markRestored(id: string, filePath: string): void {
    this.db.transaction(() => {
      this.db
        .query('UPDATE photos SET is_deleted = 0, file_path = ?, deleted_from_path = NULL, is_missing = 0 WHERE id = ?')
        .run(filePath, id);
      this.refreshStackOf(id);
    })();
  }

  // --- sync (DESIGN §9) ---

  listForSync(libraryId: string): SyncDbPhoto[] {
    return this.mapSyncRows(
      this.db
        .query(`SELECT ${SYNC_COLUMNS} FROM photos WHERE library_id = ? AND is_deleted = 0`)
        .all(libraryId) as SyncRow[],
    );
  }

  // Sync rows at specific paths, the candidate set a scoped (watcher-driven) sync
  // reconciles, instead of the whole library (§9 scoped sync).
  listForSyncByPaths(libraryId: string, paths: readonly string[]): SyncDbPhoto[] {
    const rows: SyncRow[] = [];
    for (const batch of inChunks(paths)) {
      const placeholders = batch.map(() => '?').join(', ');
      rows.push(
        ...(this.db
          .query(`SELECT ${SYNC_COLUMNS} FROM photos WHERE library_id = ? AND is_deleted = 0 AND file_path IN (${placeholders})`)
          .all(libraryId, ...batch) as SyncRow[]),
      );
    }
    return this.mapSyncRows(rows);
  }

  // Already-missing rows; the move-source pool a scoped sync pairs new files
  // against by hash, so a relocation still resolves to a move across syncs (§9.3).
  listMissingForSync(libraryId: string): SyncDbPhoto[] {
    return this.mapSyncRows(
      this.db
        .query(`SELECT ${SYNC_COLUMNS} FROM photos WHERE library_id = ? AND is_deleted = 0 AND is_missing = 1`)
        .all(libraryId) as SyncRow[],
    );
  }

  private mapSyncRows(rows: SyncRow[]): SyncDbPhoto[] {
    return rows.map((r) => ({
      id: r.id,
      file_path: r.file_path,
      file_hash: r.file_hash,
      is_missing: r.is_missing === 1,
      date_updated: r.date_updated,
      file_size: r.file_size,
    }));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insertFromSync(record: SyncInsert): void {
    this.db
      .query(
        `INSERT INTO photos
          (id, library_id, shoot_id, file_hash, file_path, file_size, width, height, orientation,
           is_missing, is_deleted, date_taken, date_taken_offset, date_added, date_updated,
           needs_tile, needs_renditions,
           latitude, longitude, iso, shutter_speed, aperture, focal_length,
           camera_make, camera_model, lens_model, rating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        record.id,
        record.library_id,
        record.shoot_id,
        record.file_hash,
        record.file_path,
        record.file_size,
        record.width,
        record.height,
        record.orientation,
        record.date_taken,
        record.date_taken_offset,
        record.date_added,
        record.date_updated,
        record.latitude,
        record.longitude,
        record.iso,
        record.shutter_speed,
        record.aperture,
        record.focal_length,
        record.camera_make,
        record.camera_model,
        record.lens_model,
      );
  }

  applyModification(photoId: string, fields: SyncModification): void {
    this.db
      .query(
        `UPDATE photos SET file_hash = ?, width = ?, height = ?, orientation = ?, date_taken = ?, date_taken_offset = ?,
          date_updated = ?, file_size = ?, latitude = ?, longitude = ?, iso = ?, shutter_speed = ?,
          aperture = ?, focal_length = ?, camera_make = ?, camera_model = ?, lens_model = ?,
          needs_tile = 1, needs_renditions = 1, is_missing = 0 WHERE id = ?`,
      )
      .run(
        fields.file_hash,
        fields.width,
        fields.height,
        fields.orientation,
        fields.date_taken,
        fields.date_taken_offset,
        fields.date_updated,
        fields.file_size,
        fields.latitude,
        fields.longitude,
        fields.iso,
        fields.shutter_speed,
        fields.aperture,
        fields.focal_length,
        fields.camera_make,
        fields.camera_model,
        fields.lens_model,
        photoId,
      );
  }

  // Header fields only. Deliberately does not touch file_hash, date_updated or
  // either pending flag: re-reading metadata is not a content change, so it must
  // not look like one to the next sync or trigger a rebuild.
  updateMetadata(photoId: string, fields: PhotoMetadataFields): void {
    this.db
      .query(
        `UPDATE photos SET width = ?, height = ?, orientation = ?, date_taken = ?, date_taken_offset = ?, latitude = ?,
          longitude = ?, iso = ?, shutter_speed = ?, aperture = ?, focal_length = ?,
          camera_make = ?, camera_model = ?, lens_model = ? WHERE id = ?`,
      )
      .run(
        fields.width,
        fields.height,
        fields.orientation,
        fields.date_taken,
        fields.date_taken_offset,
        fields.latitude,
        fields.longitude,
        fields.iso,
        fields.shutter_speed,
        fields.aperture,
        fields.focal_length,
        fields.camera_make,
        fields.camera_model,
        fields.lens_model,
        photoId,
      );
  }

  // Every id in the catalogue, including soft-deleted rows: a binned photo still
  // has its renditions, which is what makes the Bin browsable (§12.1).
  allIds(): string[] {
    return (this.db.query('SELECT id FROM photos').all() as { id: string }[]).map((r) => r.id);
  }

  clearMissing(photoId: string): void {
    this.db.query('UPDATE photos SET is_missing = 0 WHERE id = ?').run(photoId);
  }

  // Guarded on the path the sync scanned: if a concurrent move/soft-delete
  // changed file_path during the (async) scan, the row is no longer "missing at
  // that path", so this is a no-op. Returns whether it actually marked missing.
  setMissing(photoId: string, expectedFilePath: string): boolean {
    return this.db.query('UPDATE photos SET is_missing = 1 WHERE id = ? AND file_path = ?').run(photoId, expectedFilePath).changes > 0;
  }

  // --- processing (DESIGN §10) ---

  // Photos awaiting renditions, joined with their library paths. is_missing is
  // excluded so a photo whose file vanished mid-queue is not failed against it.
  // `photoIds` narrows to a named set: a scoped sync processes the files it
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
      `SELECT p.id AS photo_id, p.file_path, p.rendition_source, p.needs_tile, p.needs_renditions,
              l.root_path, l.data_path, l.rendition_source AS library_rendition_source, l.rendition_hdr, l.rendition_hdr_video
       FROM photos p JOIN libraries l ON l.id = p.library_id
       WHERE ${PENDING_PROCESSING('p.')} ${where} ${idClause} ${order}`;

    if (photoIds == null) return this.db.query(query('')).all(...params) as PendingPhoto[];
    const rows: PendingPhoto[] = [];
    for (const batch of inChunks(photoIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      rows.push(...(this.db.query(query(`AND p.id IN (${placeholders})`)).all(...params, ...batch) as PendingPhoto[]));
    }
    return rows;
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

  // The grid tile has landed. Its own flag and its own stamp, because the
  // renditions are still to come and a client versions the tile's URL off this
  // one alone: sharing a stamp with the second pass re-fetched every tile on the
  // page whenever any photo's renditions were rebuilt.
  markTileBuilt(id: string, builtAtIso: string): void {
    this.db.query('UPDATE photos SET needs_tile = 0, tile_built_at = ? WHERE id = ?').run(builtAtIso, id);
  }

  // The viewer's renditions have landed, which is also when `rendition_source`
  // becomes true: it records what the viewer is served (§10.2).
  markRenditionsBuilt(id: string, builtAtIso: string, source: RenditionSource): void {
    this.db
      .query(
        `UPDATE photos SET needs_renditions = 0, renditions_built_at = ?, processing_error = NULL,
          rendition_source = ? WHERE id = ?`,
      )
      .run(builtAtIso, source, id);
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
    const placeholders = photoIds.map(() => '?').join(', ');
    return this.db
      .query(
        `UPDATE photos SET needs_tile = 1, processing_error = NULL
         WHERE id IN (${placeholders}) AND is_missing = 0 AND is_deleted = 0`,
      )
      .run(...photoIds).changes;
  }

  // Both stages: the failure is the file rather than the stage, so a photo whose
  // tile could not be built has nothing to gain from being asked for renditions.
  markProcessingFailed(id: string, error: string): void {
    this.db
      .query('UPDATE photos SET needs_tile = 0, needs_renditions = 0, processing_error = ? WHERE id = ?')
      .run(error, id);
  }

  // Pending while *either* stage is: the sync strip counts photos, not stages,
  // and one still building its renditions is not done. Same predicate as
  // `listPendingProcessing`, or the status would count work no batch will ever
  // pick up and never settle.
  countPendingProcessing(libraryId?: string, photoIds?: readonly string[]): number {
    const where = libraryId ? 'AND library_id = ?' : '';
    const params = libraryId ? [libraryId] : [];
    const query = (idClause: string): string =>
      `SELECT COUNT(*) AS n FROM photos WHERE ${PENDING_PROCESSING('')} ${where} ${idClause}`;

    if (photoIds == null) return (this.db.query(query('')).get(...params) as { n: number }).n;
    let total = 0;
    for (const batch of inChunks(photoIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      total += (this.db.query(query(`AND id IN (${placeholders})`)).get(...params, ...batch) as { n: number }).n;
    }
    return total;
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
    const { where, params } = this.scoped(fromWhere, baseParams, filters);
    const one = representativeFilter(filters, promotion);
    const size = sizeExpression(filters, counting);
    // Counted only when asked. No ordering index can cover it - the filter chips
    // vary, so it is a scan of everything that matches - and at a million photos
    // it is 774ms of a 792ms listing, re-run for each of ten thousand blocks a
    // scroll walks through, for a number that cannot move underneath it.
    //
    // Distinct over the collapsing key, so a stack is one entry of the collection
    // just as it is one tile of it (§19.5.1).
    const total =
      filters.count === false
        ? undefined
        : (this.db.query(`SELECT COUNT(DISTINCT COALESCE(photos.stack_id, photos.id)) AS n ${where}`).get(...params) as { n: number }).n;
    const rows = this.db
      .query(
        `SELECT ${SUMMARY_COLS}, ${size.sql} AS stack_size ${where} AND ${one.sql}
         ORDER BY ${orderByClause(ordering)} LIMIT ? OFFSET ?`,
      )
      // Bound in the order the placeholders appear in the text, and the size
      // expression is in the SELECT list, so it comes before the scope.
      .all(...size.params, ...params, ...one.params, limit, offset) as SummaryRow[];

    return { photos: rows.map((r) => toSummary(r, ordering)), total };
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
    const { where, params } = this.scoped(fromWhere, baseParams, filters);
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
    const members = conditions(filters, 'm.');
    const memberVisible = [...(promotion.sql === '' ? [] : [promotion.sql]), ...members.clauses];
    const rows = this.db
      .query(
        `SELECT m.id FROM (
           SELECT id, stack_id, ROW_NUMBER() OVER (ORDER BY ${orderByClause(ordering)}) - 1 AS position
           ${where} AND ${one.sql} LIMIT ?
         ) chosen
         JOIN photos m
           ON m.id = chosen.id
           OR (chosen.stack_id IS NOT NULL AND m.stack_id = chosen.stack_id)
         WHERE (${spans})${memberVisible.map((clause) => ` AND ${clause}`).join('')}`,
      )
      // Bound in the order the placeholders appear in the text: the scoped rows,
      // the representative filter, the bound on the numbering, the runs being
      // read out, then the member set.
      .all(...params, ...one.params, last + 1, ...bounds, ...promotion.params, ...members.params) as { id: string }[];
    return [...new Set(rows.map((row) => row.id))];
  }

  // Where given rows sit in a scoped, ordered, filtered listing (§19.6.1).
  //
  // Keyed by `COALESCE(stack_id, id)`, which is what identifies a row of a
  // collapsed listing: a stack by its stack, an ordinary photo by itself. That is
  // what an open expansion band and the scroll anchor both hold, so that neither
  // stores a position that a re-order or an import would silently invalidate.
  //
  // One query for every key, never one per key. Numbering rows costs an ordered
  // pass over the collection, which is the same trap `idsAt` records: ten open
  // bands must not mean ten passes.
  private positionsAt(
    fromWhere: string,
    baseParams: string[],
    ordering: Ordering,
    keys: readonly string[],
    filters: PhotoListFilters,
    promotion: MemberScope,
  ): Map<string, number> {
    const found = new Map<string, number>();
    if (keys.length === 0) return found;
    const { where, params } = this.scoped(fromWhere, baseParams, filters);
    const one = representativeFilter(filters, promotion);
    for (const batch of inChunks(keys)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .query(
          `SELECT key, position FROM (
             SELECT COALESCE(photos.stack_id, photos.id) AS key,
                    ROW_NUMBER() OVER (ORDER BY ${orderByClause(ordering)}) - 1 AS position
             ${where} AND ${one.sql}
           ) WHERE key IN (${placeholders})`,
        )
        .all(...params, ...one.params, ...batch) as { key: string; position: number }[];
      for (const row of rows) found.set(row.key, row.position);
    }
    return found;
  }

  positionsInLibrary(
    libraryId: string,
    ordering: Ordering,
    keys: readonly string[],
    filters: PhotoListFilters,
  ): Map<string, number> {
    return this.positionsAt('FROM photos WHERE library_id = ?', [libraryId], ordering, keys, filters, WHOLE_STACK);
  }

  positionsInShoot(shootId: string, ordering: Ordering, keys: readonly string[], filters: PhotoListFilters): Map<string, number> {
    return this.positionsAt('FROM photos WHERE shoot_id = ?', [shootId], ordering, keys, filters, inShoot(shootId));
  }

  positionsInAlbum(albumId: string, ordering: Ordering, keys: readonly string[], filters: PhotoListFilters): Map<string, number> {
    return this.positionsAt(
      'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
      [albumId],
      ordering,
      keys,
      filters,
      inAlbum(albumId),
    );
  }

  private scoped(
    fromWhere: string,
    baseParams: string[],
    filters: PhotoListFilters,
  ): { where: string; params: (string | number)[] } {
    const { clauses, params } = conditions(filters, 'photos.');
    return {
      where: clauses.length ? `${fromWhere} AND ${clauses.join(' AND ')}` : fromWhere,
      params: [...baseParams, ...params],
    };
  }
}

/**
 * Everything a listing filters by, written against one table alias.
 *
 * Taking the alias as an argument is what lets the promotion clause (§19.5.1)
 * ask about a stack's *other* members under exactly the filters the listing is
 * running: a second copy of this would drift, and a listing whose promotion
 * disagreed with its own filter would show a stack twice or not at all.
 */
function conditions(filters: PhotoListFilters, prefix: string): { clauses: string[]; params: (string | number)[] } {
  // Scope says which rows are in play at all; user holds the filter chips. They
  // are built separately because only the chips honour `match`.
  const scope: string[] = [];
  const scopeParams: (string | number)[] = [];
  const user: string[] = [];
  const userParams: (string | number)[] = [];
  const taken = `COALESCE(${prefix}date_taken, ${prefix}date_added)`;

  if (!filters.includeDeleted) scope.push(`${prefix}is_deleted = 0`);
  if (filters.isDeleted != null) {
    scope.push(`${prefix}is_deleted = ?`);
    scopeParams.push(filters.isDeleted ? 1 : 0);
  }
  if (filters.search != null) {
    // LIKE is case-insensitive for ASCII in SQLite, which is what filenames are.
    scope.push(`${prefix}file_path LIKE ?`);
    scopeParams.push(`%${filters.search}%`);
  }
  // COALESCE rather than date_taken alone: a file the camera never dated still
  // has to be reachable, and this is the same date the grid sorts and labels by.
  if (filters.takenFrom != null) {
    scope.push(`${taken} >= ?`);
    scopeParams.push(filters.takenFrom);
  }
  if (filters.takenTo != null) {
    // The bound is a whole day but the column is a timestamp, so compare against
    // the start of the next one.
    scope.push(`${taken} < date(?, '+1 day')`);
    scopeParams.push(filters.takenTo);
  }

  if (filters.isMissing != null) {
    user.push(`${prefix}is_missing = ?`);
    userParams.push(filters.isMissing ? 1 : 0);
  }
  // "No rendition" is about the grid tile: the renditions behind it are the
  // viewer's business and a photo with a tile is not a hole in the gallery.
  if (filters.needsTile != null) {
    user.push(`${prefix}needs_tile = ?`);
    userParams.push(filters.needsTile ? 1 : 0);
  }
  if (filters.rated != null) user.push(filters.rated ? `${prefix}rating > 0` : `${prefix}rating = 0`);
  if (filters.triage != null && filters.triage.length > 0) {
    // NULL is the untriaged bucket, so it needs an IS NULL arm rather than an IN.
    const wanted = filters.triage.filter((t) => t !== 'untriaged');
    const arms: string[] = [];
    if (filters.triage.includes('untriaged')) arms.push(`${prefix}triage IS NULL`);
    if (wanted.length > 0) {
      arms.push(`${prefix}triage IN (${wanted.map(() => '?').join(', ')})`);
      userParams.push(...wanted);
    }
    user.push(`(${arms.join(' OR ')})`);
  }

  const combined = filters.match === 'any' && user.length > 1 ? [`(${user.join(' OR ')})`] : user;
  return { clauses: [...scope, ...combined], params: [...scopeParams, ...userParams] };
}
