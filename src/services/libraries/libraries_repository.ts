import type { Database } from 'bun:sqlite';
import type { Ordering, RenditionSource } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';

interface LibraryRow {
  id: string;
  root_path: string;
  data_path: string | null;
  name: string | null;
  ordering: string;
  rendition_source: string;
  rendition_hdr: number;
  rendition_hdr_video: number;
  include_subfolders: number;
  mirror_shoots: number;
  auto_stack: number;
  auto_stack_similarity: number;
  auto_stack_window_seconds: number;
  last_synced_at: string | null;
  photo_count: number;
}

// photo_count excludes binned photos: it answers "how big is this library", and
// the Bin has its own count in the UI.
const SELECT = `SELECT l.id, l.root_path, l.data_path, l.name, l.ordering, l.rendition_source, l.rendition_hdr, l.rendition_hdr_video,
  l.include_subfolders, l.mirror_shoots, l.auto_stack, l.auto_stack_similarity, l.auto_stack_window_seconds, l.last_synced_at,
  (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id AND p.is_deleted = 0) AS photo_count
  FROM libraries l`;

export class LibrariesRepository {
  constructor(private readonly db: Database) {}

  insert(
    library: Pick<Library, 'id' | 'root_path' | 'data_path' | 'name' | 'ordering' | 'include_subfolders' | 'mirror_shoots'>,
  ): void {
    this.db
      .query(
        `INSERT INTO libraries (id, root_path, data_path, name, ordering, include_subfolders, mirror_shoots)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        library.id,
        library.root_path,
        library.data_path,
        library.name,
        library.ordering,
        library.include_subfolders ? 1 : 0,
        library.mirror_shoots ? 1 : 0,
      );
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

  setName(id: string, name: string | null): boolean {
    return this.db.query('UPDATE libraries SET name = ? WHERE id = ?').run(name, id).changes > 0;
  }

  setOrdering(id: string, ordering: Ordering): boolean {
    return this.db.query('UPDATE libraries SET ordering = ? WHERE id = ?').run(ordering, id).changes > 0;
  }

  setRenditionSource(id: string, source: RenditionSource): boolean {
    return this.db.query('UPDATE libraries SET rendition_source = ? WHERE id = ?').run(source, id).changes > 0;
  }

  setRenditionHdr(id: string, hdr: boolean): boolean {
    return this.db.query('UPDATE libraries SET rendition_hdr = ? WHERE id = ?').run(hdr ? 1 : 0, id).changes > 0;
  }

  setRenditionHdrVideo(id: string, enabled: boolean): boolean {
    return this.db.query('UPDATE libraries SET rendition_hdr_video = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  setIncludeSubfolders(id: string, include: boolean): boolean {
    return this.db.query('UPDATE libraries SET include_subfolders = ? WHERE id = ?').run(include ? 1 : 0, id).changes > 0;
  }

  setMirrorShoots(id: string, mirror: boolean): boolean {
    return this.db.query('UPDATE libraries SET mirror_shoots = ? WHERE id = ?').run(mirror ? 1 : 0, id).changes > 0;
  }

  setAutoStack(id: string, enabled: boolean): boolean {
    return this.db.query('UPDATE libraries SET auto_stack = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  setAutoStackSimilarity(id: string, similarity: number): boolean {
    return this.db.query('UPDATE libraries SET auto_stack_similarity = ? WHERE id = ?').run(similarity, id).changes > 0;
  }

  setAutoStackWindow(id: string, seconds: number): boolean {
    return this.db.query('UPDATE libraries SET auto_stack_window_seconds = ? WHERE id = ?').run(seconds, id).changes > 0;
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
    name: row.name,
    ordering: row.ordering as Ordering,
    rendition_source: row.rendition_source as RenditionSource,
    rendition_hdr: row.rendition_hdr === 1,
    rendition_hdr_video: row.rendition_hdr_video === 1,
    include_subfolders: row.include_subfolders === 1,
    mirror_shoots: row.mirror_shoots === 1,
    auto_stack: row.auto_stack === 1,
    auto_stack_similarity: row.auto_stack_similarity,
    auto_stack_window_seconds: row.auto_stack_window_seconds,
    last_synced_at: row.last_synced_at,
    photo_count: row.photo_count,
  };
}
