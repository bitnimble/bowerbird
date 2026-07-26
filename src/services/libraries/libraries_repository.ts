import type { Database } from 'bun:sqlite';
import type { Ordering } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';

interface LibraryRow {
  id: string;
  root_path: string;
  data_path: string | null;
  ordering: string;
  last_synced_at: string | null;
  photo_count: number;
}

// photo_count excludes binned photos: it answers "how big is this library", and
// the Bin has its own count in the UI.
const SELECT = `SELECT l.id, l.root_path, l.data_path, l.ordering, l.last_synced_at,
  (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id AND p.is_deleted = 0) AS photo_count
  FROM libraries l`;

export class LibrariesRepository {
  constructor(private readonly db: Database) {}

  insert(library: Pick<Library, 'id' | 'root_path' | 'data_path' | 'ordering'>): void {
    this.db
      .query('INSERT INTO libraries (id, root_path, data_path, ordering) VALUES (?, ?, ?, ?)')
      .run(library.id, library.root_path, library.data_path, library.ordering);
  }

  getById(id: string): Library | null {
    const row = this.db.query(`${SELECT} WHERE l.id = ?`).get(id) as LibraryRow | null;
    return row ? mapRow(row) : null;
  }

  getByRootPath(rootPath: string): Library | null {
    const row = this.db.query(`${SELECT} WHERE l.root_path = ?`).get(rootPath) as LibraryRow | null;
    return row ? mapRow(row) : null;
  }

  list(): Library[] {
    const rows = this.db.query(`${SELECT} ORDER BY l.root_path`).all() as LibraryRow[];
    return rows.map(mapRow);
  }

  setOrdering(id: string, ordering: Ordering): boolean {
    return this.db.query('UPDATE libraries SET ordering = ? WHERE id = ?').run(ordering, id).changes > 0;
  }

  // Stamped when a sync finishes, so the UI can say how stale the catalogue is
  // even after a restart (the in-memory status does not survive one, §9.6).
  setLastSyncedAt(id: string, iso: string): void {
    this.db.query('UPDATE libraries SET last_synced_at = ? WHERE id = ?').run(iso, id);
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM libraries WHERE id = ?').run(id).changes > 0;
  }
}

function mapRow(row: LibraryRow): Library {
  return {
    id: row.id,
    root_path: row.root_path,
    data_path: row.data_path,
    ordering: row.ordering as Ordering,
    last_synced_at: row.last_synced_at,
    photo_count: row.photo_count,
  };
}
