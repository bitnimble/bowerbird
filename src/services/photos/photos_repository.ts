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

const SUMMARY_COLS =
  'id, library_id, shoot_id, width, height, date_taken, date_added, selected, rating, is_missing, is_deleted';

const DETAIL_COLS = `id, library_id, shoot_id, width, height, orientation, file_path, file_hash,
  date_taken, date_added, date_updated, date_reprocessed, needs_processing, processing_error,
  latitude, longitude, rating, selected, is_missing, is_deleted, notes`;

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
}

// `date_taken IS NULL` first keeps NULL capture dates last in both directions (DESIGN §5.1).
function orderByClause(ordering: Ordering): string {
  switch (ordering) {
    case 'added_asc':
      return 'date_added ASC, id ASC';
    case 'added_desc':
      return 'date_added DESC, id ASC';
    case 'taken_asc':
      return 'date_taken IS NULL, date_taken ASC, id ASC';
    case 'taken_desc':
      return 'date_taken IS NULL, date_taken DESC, id ASC';
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
    ordering_date: row.date_taken ?? row.date_added,
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
    const row = this.db.query(`SELECT ${DETAIL_COLS} FROM photos WHERE id = ?`).get(id) as DetailRow | null;
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
    if (fields.rating !== undefined) {
      sets.push('rating = ?');
      params.push(fields.rating);
    }
    if (fields.selected !== undefined) {
      sets.push('selected = ?');
      params.push(fields.selected ? 1 : 0);
    }
    if (fields.notes !== undefined) {
      sets.push('notes = ?');
      params.push(fields.notes);
    }
    if (sets.length === 0) return this.db.query('SELECT 1 FROM photos WHERE id = ?').get(id) != null;
    params.push(id);
    return this.db.query(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
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
    if (filters.isMissing !== undefined) {
      clauses.push('is_missing = ?');
      params.push(filters.isMissing ? 1 : 0);
    }
    if (filters.needsProcessing !== undefined) {
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
