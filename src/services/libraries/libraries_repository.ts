import type { Database } from 'bun:sqlite';
import type { Ordering } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';

interface LibraryRow {
  id: string;
  root_path: string;
  data_path: string | null;
  ordering: string;
}

export class LibrariesRepository {
  constructor(private readonly db: Database) {}

  insert(library: Library): void {
    this.db
      .query('INSERT INTO libraries (id, root_path, data_path, ordering) VALUES (?, ?, ?, ?)')
      .run(library.id, library.root_path, library.data_path, library.ordering);
  }

  getById(id: string): Library | null {
    const row = this.db
      .query('SELECT id, root_path, data_path, ordering FROM libraries WHERE id = ?')
      .get(id) as LibraryRow | null;
    return row ? mapRow(row) : null;
  }

  getByRootPath(rootPath: string): Library | null {
    const row = this.db
      .query('SELECT id, root_path, data_path, ordering FROM libraries WHERE root_path = ?')
      .get(rootPath) as LibraryRow | null;
    return row ? mapRow(row) : null;
  }

  list(): Library[] {
    const rows = this.db
      .query('SELECT id, root_path, data_path, ordering FROM libraries ORDER BY root_path')
      .all() as LibraryRow[];
    return rows.map(mapRow);
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
  };
}
