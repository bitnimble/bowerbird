import type { Database } from 'bun:sqlite';
import type { Ordering } from '../../schemas/common';
import type { Album } from '../../schemas/albums';

interface AlbumRow {
  id: string;
  name: string;
  ordering: string;
  banner_photo_id: string | null;
}

const SELECT = `SELECT a.id, a.name, a.ordering, b.photo_id AS banner_photo_id
  FROM albums a LEFT JOIN album_banners b ON b.album_id = a.id`;

function mapRow(row: AlbumRow): Album {
  return {
    id: row.id,
    name: row.name,
    ordering: row.ordering as Ordering,
    banner_photo_id: row.banner_photo_id,
  };
}

export interface NewAlbum {
  id: string;
  name: string;
  ordering: Ordering;
}

export class AlbumsRepository {
  constructor(private readonly db: Database) {}

  insert(album: NewAlbum): void {
    this.db.query('INSERT INTO albums (id, name, ordering) VALUES (?, ?, ?)').run(album.id, album.name, album.ordering);
  }

  getById(id: string): Album | null {
    const row = this.db.query(`${SELECT} WHERE a.id = ?`).get(id) as AlbumRow | null;
    return row ? mapRow(row) : null;
  }

  list(): Album[] {
    const rows = this.db.query(`${SELECT} ORDER BY a.name`).all() as AlbumRow[];
    return rows.map(mapRow);
  }

  updateFields(id: string, fields: { name?: string; ordering?: Ordering }): void {
    const sets: string[] = [];
    const params: string[] = [];
    for (const [col, val] of Object.entries(fields)) {
      if (val === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(val as string);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.query(`UPDATE albums SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM albums WHERE id = ?').run(id).changes > 0;
  }

  addPhotos(albumId: string, photoIds: string[], dateAddedIso: string): void {
    const stmt = this.db.query(
      'INSERT OR IGNORE INTO album_photos (album_id, photo_id, date_added) VALUES (?, ?, ?)',
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const pid of ids) stmt.run(albumId, pid, dateAddedIso);
    });
    tx(photoIds);
  }

  removePhotos(albumId: string, photoIds: string[]): void {
    const stmt = this.db.query('DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      for (const pid of ids) stmt.run(albumId, pid);
    });
    tx(photoIds);
  }

  // Album IDs a photo belongs to (used by sync move-detection bias, DESIGN §9.3).
  getAlbumIdsForPhoto(photoId: string): string[] {
    const rows = this.db.query('SELECT album_id FROM album_photos WHERE photo_id = ?').all(photoId) as {
      album_id: string;
    }[];
    return rows.map((r) => r.album_id);
  }

  setBanner(albumId: string, photoId: string | null): void {
    if (photoId == null) {
      this.db.query('DELETE FROM album_banners WHERE album_id = ?').run(albumId);
      return;
    }
    this.db
      .query(
        'INSERT INTO album_banners (album_id, photo_id) VALUES (?, ?) ON CONFLICT(album_id) DO UPDATE SET photo_id = excluded.photo_id',
      )
      .run(albumId, photoId);
  }
}
