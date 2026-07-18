import type { Database } from 'bun:sqlite';
import type { Ordering } from '../../schemas/common';
import type { PhotoDetail, PhotoSummary } from '../../schemas/photos';

export interface PhotoListFilters {
  includeDeleted: boolean;
  isMissing?: boolean;
  needsProcessing?: boolean;
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
  date_added: string;
  date_updated: string | null;
  file_size: number;
  latitude: number | null;
  longitude: number | null;
}

export interface SyncModification {
  file_hash: string;
  width: number;
  height: number;
  orientation: number;
  date_taken: string | null;
  date_updated: string | null;
  file_size: number;
  latitude: number | null;
  longitude: number | null;
}

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
  'photos.id, photos.library_id, photos.shoot_id, photos.width, photos.height, photos.date_taken, photos.date_added, photos.selected, photos.rating, photos.is_missing, photos.is_deleted';

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
  photos.orientation, photos.file_path, photos.file_hash, photos.date_taken, photos.date_added,
  photos.date_updated, photos.date_reprocessed, photos.needs_processing, photos.processing_error,
  photos.latitude, photos.longitude, photos.rating, photos.selected, photos.is_missing,
  photos.is_deleted, photos.notes`;

interface SummaryRow {
  id: string;
  library_id: string;
  shoot_id: string | null;
  width: number;
  height: number;
  date_taken: string | null;
  date_added: string;
  selected: number;
  rating: number;
  is_missing: number;
  is_deleted: number;
}

interface DetailRow extends SummaryRow {
  orientation: number;
  file_path: string;
  file_hash: string | null;
  date_updated: string | null;
  date_reprocessed: string | null;
  needs_processing: number;
  processing_error: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
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

function orderingDate(ordering: Ordering, row: SummaryRow): string | null {
  return ordering === 'taken_asc' || ordering === 'taken_desc' ? row.date_taken : row.date_added;
}

function toSummary(row: SummaryRow, ordering: Ordering): PhotoSummary {
  return {
    id: row.id,
    library_id: row.library_id,
    shoot_id: row.shoot_id,
    width: row.width,
    height: row.height,
    ordering_date: orderingDate(ordering, row),
    selected: row.selected === 1,
    rating: row.rating,
    is_missing: row.is_missing === 1,
    is_deleted: row.is_deleted === 1,
  };
}

function toDetail(row: DetailRow): PhotoDetail {
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
    date_added: row.date_added,
    date_updated: row.date_updated,
    date_reprocessed: row.date_reprocessed,
    needs_processing: row.needs_processing === 1,
    processing_error: row.processing_error,
    latitude: row.latitude,
    longitude: row.longitude,
    rating: row.rating,
    selected: row.selected === 1,
    is_missing: row.is_missing === 1,
    is_deleted: row.is_deleted === 1,
    notes: row.notes,
  };
}

export class PhotosRepository {
  constructor(private readonly db: Database) {}

  getById(id: string): PhotoDetail | null {
    const row = this.db
      .query(`SELECT ${DETAIL_COLS}, l.ordering AS lib_ordering FROM photos JOIN libraries l ON l.id = photos.library_id WHERE photos.id = ?`)
      .get(id) as DetailRow | null;
    return row ? toDetail(row) : null;
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

  update(id: string, fields: { rating?: number; selected?: boolean; notes?: string | null }): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (fields.rating != null) {
      sets.push('rating = ?');
      params.push(fields.rating);
    }
    if (fields.selected != null) {
      sets.push('selected = ?');
      params.push(fields.selected ? 1 : 0);
    }
    if (fields.notes != null) {
      sets.push('notes = ?');
      params.push(fields.notes);
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

  setShoot(photoId: string, shootId: string | null): void {
    this.db.query('UPDATE photos SET shoot_id = ? WHERE id = ?').run(shootId, photoId);
  }

  // Both clear is_missing: they run only after a successful physical move of a
  // specific file, so it provably exists at the new path. Without this, a
  // concurrent sync whose setMissing landed just before the move committed would
  // leave the (present) photo stuck is_missing=1 until the next sync (mirrors
  // applyMove). NOT for bulk path-prefix rewrites, see rewriteFilePath.
  setFilePathAndShoot(photoId: string, filePath: string, shootId: string | null): void {
    this.db.query('UPDATE photos SET file_path = ?, shoot_id = ?, is_missing = 0 WHERE id = ?').run(filePath, shootId, photoId);
  }

  setFilePath(photoId: string, filePath: string): void {
    this.db.query('UPDATE photos SET file_path = ?, is_missing = 0 WHERE id = ?').run(filePath, photoId);
  }

  // Path-prefix rewrite for a shoot-folder rename: preserves is_missing, since a
  // folder rename moves nothing for a photo that was already missing (its file
  // doesn't exist), so it must stay missing at the rewritten path.
  rewriteFilePath(photoId: string, filePath: string): void {
    this.db.query('UPDATE photos SET file_path = ? WHERE id = ?').run(filePath, photoId);
  }

  markDeleted(id: string): void {
    this.db.query('UPDATE photos SET is_deleted = 1, needs_processing = 0 WHERE id = ?').run(id);
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
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => '?').join(', ');
    return this.mapSyncRows(
      this.db
        .query(`SELECT ${SYNC_COLUMNS} FROM photos WHERE library_id = ? AND is_deleted = 0 AND file_path IN (${placeholders})`)
        .all(libraryId, ...paths) as SyncRow[],
    );
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
           is_missing, is_deleted, date_taken, date_added, date_updated, needs_processing,
           latitude, longitude, rating, selected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 1, ?, ?, 0, 0)`,
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
        record.date_added,
        record.date_updated,
        record.latitude,
        record.longitude,
      );
  }

  applyMove(photoId: string, newFilePath: string, shootId: string | null): void {
    this.db
      .query('UPDATE photos SET file_path = ?, shoot_id = ?, is_missing = 0 WHERE id = ?')
      .run(newFilePath, shootId, photoId);
  }

  applyModification(photoId: string, fields: SyncModification): void {
    this.db
      .query(
        `UPDATE photos SET file_hash = ?, width = ?, height = ?, orientation = ?, date_taken = ?,
          date_updated = ?, file_size = ?, latitude = ?, longitude = ?, needs_processing = 1, is_missing = 0 WHERE id = ?`,
      )
      .run(
        fields.file_hash,
        fields.width,
        fields.height,
        fields.orientation,
        fields.date_taken,
        fields.date_updated,
        fields.file_size,
        fields.latitude,
        fields.longitude,
        photoId,
      );
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
        `SELECT p.id AS photo_id, p.file_path, l.root_path, l.data_path
         FROM photos p JOIN libraries l ON l.id = p.library_id
         WHERE p.needs_processing = 1 AND p.is_missing = 0 AND p.is_deleted = 0 ${where}`,
      )
      .all(...params) as PendingPhoto[];
  }

  markProcessed(id: string, reprocessedAtIso: string): void {
    this.db
      .query('UPDATE photos SET needs_processing = 0, date_reprocessed = ?, processing_error = NULL WHERE id = ?')
      .run(reprocessedAtIso, id);
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
    const clauses: string[] = [];
    const params: (string | number)[] = [...baseParams];
    if (!filters.includeDeleted) clauses.push('is_deleted = 0');
    if (filters.isMissing != null) {
      clauses.push('is_missing = ?');
      params.push(filters.isMissing ? 1 : 0);
    }
    if (filters.needsProcessing != null) {
      clauses.push('needs_processing = ?');
      params.push(filters.needsProcessing ? 1 : 0);
    }
    const where = clauses.length ? `${fromWhere} AND ${clauses.join(' AND ')}` : fromWhere;

    const total = (this.db.query(`SELECT COUNT(*) AS n ${where}`).get(...params) as { n: number }).n;
    const rows = this.db
      .query(`SELECT ${SUMMARY_COLS} ${where} ORDER BY ${orderByClause(ordering)} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as SummaryRow[];

    return { photos: rows.map((r) => toSummary(r, ordering)), total };
  }
}
