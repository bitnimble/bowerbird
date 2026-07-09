import type { Database } from 'bun:sqlite';
import type { Ordering } from '../../schemas/common';
import type { Shoot } from '../../schemas/shoots';

interface ShootRow {
  id: string;
  parent_id: string | null;
  library_id: string;
  folder_path: string;
  name: string;
  description: string | null;
  ordering: string;
  banner_photo_id: string | null;
}

const SELECT = `SELECT s.id, s.parent_id, s.library_id, s.folder_path, s.name, s.description, s.ordering,
  b.photo_id AS banner_photo_id
  FROM shoots s LEFT JOIN shoot_banners b ON b.shoot_id = s.id`;

function mapRow(row: ShootRow): Shoot {
  return {
    id: row.id,
    parent_id: row.parent_id,
    library_id: row.library_id,
    folder_path: row.folder_path,
    name: row.name,
    description: row.description,
    banner_photo_id: row.banner_photo_id,
    ordering: row.ordering as Ordering,
  };
}

export interface NewShoot {
  id: string;
  parent_id: string | null;
  library_id: string;
  folder_path: string;
  name: string;
  description: string | null;
  ordering: Ordering;
}

export class ShootsRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insert(shoot: NewShoot): void {
    this.db
      .query(
        'INSERT INTO shoots (id, parent_id, library_id, folder_path, name, description, ordering) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(shoot.id, shoot.parent_id, shoot.library_id, shoot.folder_path, shoot.name, shoot.description, shoot.ordering);
  }

  getById(id: string): Shoot | null {
    const row = this.db.query(`${SELECT} WHERE s.id = ?`).get(id) as ShootRow | null;
    return row ? mapRow(row) : null;
  }

  getByName(libraryId: string, name: string): Shoot | null {
    const row = this.db.query(`${SELECT} WHERE s.library_id = ? AND s.name = ?`).get(libraryId, name) as ShootRow | null;
    return row ? mapRow(row) : null;
  }

  listByLibrary(libraryId: string): Shoot[] {
    const rows = this.db.query(`${SELECT} WHERE s.library_id = ? ORDER BY s.folder_path`).all(libraryId) as ShootRow[];
    return rows.map(mapRow);
  }

  updateFields(id: string, fields: { name?: string; description?: string | null; ordering?: Ordering; folder_path?: string }): void {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    for (const [col, val] of Object.entries(fields)) {
      if (val == null) continue;
      sets.push(`${col} = ?`);
      params.push(val as string | null);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.query(`UPDATE shoots SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM shoots WHERE id = ?').run(id).changes > 0;
  }

  setBanner(shootId: string, photoId: string | null): void {
    if (photoId == null) {
      this.db.query('DELETE FROM shoot_banners WHERE shoot_id = ?').run(shootId);
      return;
    }
    this.db
      .query(
        'INSERT INTO shoot_banners (shoot_id, photo_id) VALUES (?, ?) ON CONFLICT(shoot_id) DO UPDATE SET photo_id = excluded.photo_id',
      )
      .run(shootId, photoId);
  }
}
