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
  photo_count: number;
}

// A shoot with no banner of its own shows its first photo, in the shoot's own
// ordering, so it is the one at the top of the grid the row opens into. Derived
// rather than written at import: the first photo moves as photos are added,
// binned or re-dated, and a stored default would go stale and then have to be
// told apart from a deliberate choice. `shoot_banners` therefore only ever holds
// a choice, and a chosen banner still wins here.
//
// One expression rather than four, because SQLite cannot take the direction from
// a column: for each ordering the two CASEs leave the other's term NULL for every
// row, which ties and so contributes nothing. The rule is `orderByClause`'s in
// `photos_repository.ts`, NULL capture dates last in both directions included.
const FIRST_PHOTO = `SELECT p.id FROM photos p
  WHERE p.shoot_id = s.id AND p.is_deleted = 0
  ORDER BY
    CASE s.ordering WHEN 'taken_asc' THEN p.date_taken IS NULL WHEN 'taken_desc' THEN p.date_taken IS NULL END,
    CASE s.ordering WHEN 'taken_asc' THEN p.date_taken WHEN 'added_asc' THEN p.date_added END ASC,
    CASE s.ordering WHEN 'taken_desc' THEN p.date_taken WHEN 'added_desc' THEN p.date_added END DESC,
    p.id ASC
  LIMIT 1`;

const SELECT = `SELECT s.id, s.parent_id, s.library_id, s.folder_path, s.name, s.description, s.ordering,
  COALESCE(b.photo_id, (${FIRST_PHOTO})) AS banner_photo_id,
  (SELECT COUNT(*) FROM photos p WHERE p.shoot_id = s.id AND p.is_deleted = 0) AS photo_count
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
    photo_count: row.photo_count,
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
  folder_ino: number | null;
  folder_birthtime: number | null;
}

// A shoot's folder as the filesystem knows it, which is what survives the folder
// being renamed (§9.4.1).
export interface ShootIdentity {
  id: string;
  folder_path: string;
  folder_ino: number | null;
  folder_birthtime: number | null;
}

export class ShootsRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insert(shoot: NewShoot): void {
    this.db
      .query(
        `INSERT INTO shoots (id, parent_id, library_id, folder_path, name, description, ordering, folder_ino, folder_birthtime)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        shoot.id,
        shoot.parent_id,
        shoot.library_id,
        shoot.folder_path,
        shoot.name,
        shoot.description,
        shoot.ordering,
        shoot.folder_ino,
        shoot.folder_birthtime,
      );
  }

  getById(id: string): Shoot | null {
    const row = this.db.query(`${SELECT} WHERE s.id = ?`).get(id) as ShootRow | null;
    return row ? mapRow(row) : null;
  }

  getByFolderPath(libraryId: string, folderPath: string): Shoot | null {
    const row = this.db
      .query(`${SELECT} WHERE s.library_id = ? AND s.folder_path = ?`)
      .get(libraryId, folderPath) as ShootRow | null;
    return row ? mapRow(row) : null;
  }

  listIdentities(libraryId: string): ShootIdentity[] {
    return this.db
      .query('SELECT id, folder_path, folder_ino, folder_birthtime FROM shoots WHERE library_id = ?')
      .all(libraryId) as ShootIdentity[];
  }

  setIdentity(id: string, ino: number, birthtimeMs: number): void {
    this.db.query('UPDATE shoots SET folder_ino = ?, folder_birthtime = ? WHERE id = ?').run(ino, birthtimeMs, id);
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

  // Points a shoot at the folder it was found at, taking its descendants with it:
  // a descendant's folder_path is this one's plus a suffix, so the whole subtree
  // shifts by the same prefix swap (§9.5). The name is untouched; only where the
  // shoot lives on disk changed.
  relocate(shootId: string, oldFolderPath: string, newFolderPath: string): void {
    this.db
      .query(
        `UPDATE shoots SET folder_path = ? || substr(folder_path, ?)
           WHERE library_id = (SELECT library_id FROM shoots WHERE id = ?)
             AND folder_path >= ? AND folder_path < ?`,
      )
      .run(newFolderPath, oldFolderPath.length + 1, shootId, `${oldFolderPath}/`, `${oldFolderPath}0`);
    this.db.query('UPDATE shoots SET folder_path = ? WHERE id = ?').run(newFolderPath, shootId);
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
