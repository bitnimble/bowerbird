import type { Database } from 'bun:sqlite';
import type { Ordering } from '../../schemas/common';
import type { PhotoDetail, PhotoSummary, Triage } from '../../schemas/photos';
import type { PreviewRendition } from '../../schemas/settings';
import type { ThumbnailSource } from '../processing/processing_types';

export interface PhotoListFilters {
  includeDeleted: boolean;
  isMissing?: boolean;
  needsProcessing?: boolean;
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
  // 'any' unions the rated/triage/isMissing/needsProcessing filters instead of
  // intersecting them. Scope (deleted, search, dates) always intersects.
  match?: 'all' | 'any';
}

export interface PhotoListResult {
  photos: PhotoSummary[];
  total: number;
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
  // The source requested for this photo; NULL for rows queued before the setting
  // existed, which the service resolves to the library's default.
  rendition_source: ThumbnailSource | null;
  // The library's preview settings, carried along so the pool needs no second
  // lookup per job (§10.2).
  preview_source: ThumbnailSource;
  preview_hdr: number;
  preview_hdr_video: number;
}

// Minimal shape for file/shoot bookkeeping (moves, adoption, reconciliation).
export interface BasicPhoto {
  id: string;
  library_id: string;
  file_path: string;
  shoot_id: string | null;
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
  'photos.id, photos.library_id, photos.shoot_id, photos.file_path, photos.width, photos.height, photos.date_taken, photos.date_added, photos.triage, photos.rating, photos.is_missing, photos.is_deleted';

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
  photos.date_updated, photos.date_reprocessed, photos.needs_processing, photos.processing_error,
  photos.latitude, photos.longitude, photos.rating, photos.triage, photos.is_missing,
  photos.is_deleted, photos.notes, photos.file_size, photos.iso, photos.shutter_speed, photos.aperture,
  photos.focal_length, photos.camera_make, photos.camera_model, photos.lens_model, photos.rendition_source, photos.preview_rendition`;

interface SummaryRow {
  id: string;
  library_id: string;
  shoot_id: string | null;
  file_path: string;
  width: number;
  height: number;
  date_taken: string | null;
  date_added: string;
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
  date_updated: string | null;
  date_reprocessed: string | null;
  needs_processing: number;
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
  rendition_source: ThumbnailSource | null;
  preview_rendition: PreviewRendition | null;
  lib_ordering: string; // the owning library's ordering, for ordering_date
}

// `date_taken IS NULL` first keeps NULL capture dates last in both directions (DESIGN §5.1).
function orderByClause(ordering: Ordering): string {
  switch (ordering) {
    case 'added_asc':
      return 'photos.date_added ASC, photos.id ASC';
    case 'added_desc':
      return 'photos.date_added DESC, photos.id ASC';
    case 'taken_asc':
      return 'photos.date_taken IS NULL, photos.date_taken ASC, photos.id ASC';
    case 'taken_desc':
      return 'photos.date_taken IS NULL, photos.date_taken DESC, photos.id ASC';
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
    date_reprocessed: row.date_reprocessed,
    needs_processing: row.needs_processing === 1,
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
    preview_rendition: row.preview_rendition,
    // All resolved by the service, which knows the library: they need its data
    // directory to stat or to build a path from, and its preview settings. The
    // repository has no business doing either.
    original_path: null,
    default_rendition: 'embedded',
    renditions: null,
    album_ids: albumIds,
  };
}

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
    return this.list('FROM photos WHERE library_id = ?', [libraryId], ordering, offset, limit, filters);
  }

  listByShoot(shootId: string, ordering: Ordering, offset: number, limit: number, filters: PhotoListFilters): PhotoListResult {
    return this.list('FROM photos WHERE shoot_id = ?', [shootId], ordering, offset, limit, filters);
  }

  listByAlbum(albumId: string, ordering: Ordering, offset: number, limit: number, filters: PhotoListFilters): PhotoListResult {
    return this.list(
      'FROM photos JOIN album_photos ap ON ap.photo_id = photos.id WHERE ap.album_id = ?',
      [albumId],
      ordering,
      offset,
      limit,
      filters,
    );
  }

  update(id: string, fields: { rating?: number; triage?: Triage; notes?: string | null; preview_rendition?: PreviewRendition }): boolean {
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
    if (fields.preview_rendition != null) {
      sets.push('preview_rendition = ?');
      params.push(fields.preview_rendition);
    }
    if (sets.length === 0) return this.db.query('SELECT 1 FROM photos WHERE id = ?').get(id) != null;
    params.push(id);
    return this.db.query(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
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

  // Photos whose file_path is under `folderPath` (any depth). Excludes
  // soft-deleted photos unless includeDeleted (the shoot-rename cascade needs
  // them: they live in <folder>/Bin and physically move with the folder).
  listUnderFolder(libraryId: string, folderPath: string, includeDeleted = false): BasicPhoto[] {
    const [lo, hi] = folderRange(folderPath);
    const deletedClause = includeDeleted ? '' : 'AND is_deleted = 0 ';
    return this.db
      .query(
        `SELECT id, library_id, file_path, shoot_id FROM photos WHERE library_id = ? ${deletedClause}AND file_path >= ? AND file_path < ?`,
      )
      .all(libraryId, lo, hi) as BasicPhoto[];
  }

  // Bulk prefix rewrite for a shoot folder that moved on disk (§9.5). Two
  // statements rather than one UPDATE per photo: a folder move is the one case
  // where every path beneath it changes the same way, and a shoot can hold
  // thousands of frames.
  //
  // The non-deleted rows are provably present at the new prefix; the move is
  // only inferred when every one of them was found there; so is_missing clears.
  // The soft-deleted ones live in <folder>/Bin and were never scanned, so their
  // path travels with the folder but their state is left alone.
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
        `UPDATE photos SET file_path = ? || substr(file_path, ?)
           WHERE library_id = ? AND is_deleted = 1 AND file_path >= ? AND file_path < ?`,
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
  markDeleted(id: string, deletedFromPath: string): void {
    this.db
      .query('UPDATE photos SET is_deleted = 1, needs_processing = 0, deleted_from_path = ? WHERE id = ?')
      .run(deletedFromPath, id);
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
    this.db
      .query('UPDATE photos SET is_deleted = 0, file_path = ?, deleted_from_path = NULL, is_missing = 0 WHERE id = ?')
      .run(filePath, id);
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
  // reconciles, instead of the whole library (§9 scoped sync). Chunked so a scoped
  // sync over many discovered files can't exceed SQLite's bound-variable limit.
  listForSyncByPaths(libraryId: string, paths: readonly string[]): SyncDbPhoto[] {
    const CHUNK = 900; // safely under SQLITE_MAX_VARIABLE_NUMBER (999 on old builds)
    const rows: SyncRow[] = [];
    for (let i = 0; i < paths.length; i += CHUNK) {
      const batch = paths.slice(i, i + CHUNK);
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
           is_missing, is_deleted, date_taken, date_taken_offset, date_added, date_updated, needs_processing,
           latitude, longitude, iso, shutter_speed, aperture, focal_length,
           camera_make, camera_model, lens_model, rating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
          needs_processing = 1, is_missing = 0 WHERE id = ?`,
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
  // needs_processing: re-reading metadata is not a content change, so it must not
  // look like one to the next sync or trigger a thumbnail rebuild.
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
  // has its thumbnails, which is what makes the Bin browsable (§12.1).
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

  // Photos awaiting thumbnails, joined with their library paths. is_missing is
  // excluded so a photo whose file vanished mid-queue is not failed against it.
  listPendingProcessing(libraryId?: string): PendingPhoto[] {
    const where = libraryId ? 'AND p.library_id = ?' : '';
    const params = libraryId ? [libraryId] : [];
    return this.db
      .query(
        `SELECT p.id AS photo_id, p.file_path, p.rendition_source, l.root_path, l.data_path,
                l.preview_source, l.preview_hdr, l.preview_hdr_video
         FROM photos p JOIN libraries l ON l.id = p.library_id
         WHERE p.needs_processing = 1 AND p.is_missing = 0 AND p.is_deleted = 0 ${where}`,
      )
      .all(...params) as PendingPhoto[];
  }

  markProcessed(id: string, reprocessedAtIso: string, source: ThumbnailSource): void {
    this.db
      .query(
        `UPDATE photos SET needs_processing = 0, date_reprocessed = ?, processing_error = NULL,
          rendition_source = ? WHERE id = ?`,
      )
      .run(reprocessedAtIso, source, id);
  }

  // Queues thumbnails to be rebuilt from `source`. Returns how many rows were
  // actually queued, so a request naming missing or binned photos reports it.
  queueReprocess(photoIds: string[], source: ThumbnailSource): number {
    if (photoIds.length === 0) return 0;
    const placeholders = photoIds.map(() => '?').join(', ');
    return this.db
      .query(
        `UPDATE photos SET needs_processing = 1, processing_error = NULL, rendition_source = ?
         WHERE id IN (${placeholders}) AND is_missing = 0 AND is_deleted = 0`,
      )
      .run(source, ...photoIds).changes;
  }

  markProcessingFailed(id: string, error: string): void {
    this.db.query('UPDATE photos SET needs_processing = 0, processing_error = ? WHERE id = ?').run(error, id);
  }

  countPendingProcessing(libraryId?: string): number {
    const where = libraryId ? 'AND library_id = ?' : '';
    const params = libraryId ? [libraryId] : [];
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM photos WHERE needs_processing = 1 AND is_deleted = 0 ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  private list(
    fromWhere: string,
    baseParams: string[],
    ordering: Ordering,
    offset: number,
    limit: number,
    filters: PhotoListFilters,
  ): PhotoListResult {
    // Scope says which rows are in play at all; user holds the filter chips. They
    // are built separately because only the chips honour `match`.
    const scope: string[] = [];
    const scopeParams: (string | number)[] = [];
    const user: string[] = [];
    const userParams: (string | number)[] = [];

    if (!filters.includeDeleted) scope.push('is_deleted = 0');
    if (filters.isDeleted != null) {
      scope.push('is_deleted = ?');
      scopeParams.push(filters.isDeleted ? 1 : 0);
    }
    if (filters.search != null) {
      // LIKE is case-insensitive for ASCII in SQLite, which is what filenames are.
      scope.push('file_path LIKE ?');
      scopeParams.push(`%${filters.search}%`);
    }
    // COALESCE rather than date_taken alone: a file the camera never dated still
    // has to be reachable, and this is the same date the grid sorts and labels by.
    if (filters.takenFrom != null) {
      scope.push('COALESCE(photos.date_taken, photos.date_added) >= ?');
      scopeParams.push(filters.takenFrom);
    }
    if (filters.takenTo != null) {
      // The bound is a whole day but the column is a timestamp, so compare against
      // the start of the next one.
      scope.push(`COALESCE(photos.date_taken, photos.date_added) < date(?, '+1 day')`);
      scopeParams.push(filters.takenTo);
    }

    if (filters.isMissing != null) {
      user.push('is_missing = ?');
      userParams.push(filters.isMissing ? 1 : 0);
    }
    if (filters.needsProcessing != null) {
      user.push('needs_processing = ?');
      userParams.push(filters.needsProcessing ? 1 : 0);
    }
    if (filters.rated != null) user.push(filters.rated ? 'rating > 0' : 'rating = 0');
    if (filters.triage != null && filters.triage.length > 0) {
      // NULL is the untriaged bucket, so it needs an IS NULL arm rather than an IN.
      const wanted = filters.triage.filter((t) => t !== 'untriaged');
      const arms: string[] = [];
      if (filters.triage.includes('untriaged')) arms.push('triage IS NULL');
      if (wanted.length > 0) {
        arms.push(`triage IN (${wanted.map(() => '?').join(', ')})`);
        userParams.push(...wanted);
      }
      user.push(`(${arms.join(' OR ')})`);
    }

    const combined = filters.match === 'any' && user.length > 1 ? [`(${user.join(' OR ')})`] : user;
    const clauses = [...scope, ...combined];
    const params: (string | number)[] = [...baseParams, ...scopeParams, ...userParams];
    const where = clauses.length ? `${fromWhere} AND ${clauses.join(' AND ')}` : fromWhere;

    const total = (this.db.query(`SELECT COUNT(*) AS n ${where}`).get(...params) as { n: number }).n;
    const rows = this.db
      .query(`SELECT ${SUMMARY_COLS} ${where} ORDER BY ${orderByClause(ordering)} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as SummaryRow[];

    return { photos: rows.map((r) => toSummary(r, ordering)), total };
  }
}
