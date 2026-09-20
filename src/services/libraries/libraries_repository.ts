import type { Database } from '../../db/driver';
import type { Ordering, RenditionSource } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';
import { readStages, writeStages } from '../processing/renditions/render_stages';
import { RenderTimingsRepository } from '../processing/renditions/render_timings_repository';
import type { OptionalStage, RenderedRendition, RenderTimings } from '../../schemas/render_stages';
import { stamp } from '../replication/stamps';

/** The bin folder's identity, which is not on `Library` (§4.1). */
export interface BinIdentity {
  dev: number | null;
  ino: number | null;
  birthtime: number | null;
}

interface LibraryRow {
  id: string;
  root_path: string;
  bin_name: string | null;
  read_only: number;
  name: string;
  ordering: string;
  rendition_source: string;
  rendition_hdr: number;
  render_skip_full: string;
  render_skip_max: string;
  include_subfolders: number;
  include_non_raw: number;
  auto_stack: number;
  auto_stack_similarity: number;
  auto_stack_window_seconds: number;
  last_synced_at: string | null;
  photo_count: number;
}

// photo_count excludes binned photos: it answers "how big is this library", and
// the Bin has its own count in the UI.
const SELECT = `SELECT l.id, l.root_path, l.bin_name, l.read_only, l.name, l.ordering, l.rendition_source, l.rendition_hdr,
  l.render_skip_full, l.render_skip_max,
  l.include_subfolders, l.include_non_raw, l.auto_stack, l.auto_stack_similarity, l.auto_stack_window_seconds,
  l.last_synced_at,
  (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id AND p.is_deleted = 0) AS photo_count
  FROM libraries l`;

export class LibrariesRepository {
  private readonly timings: RenderTimingsRepository;

  constructor(private readonly db: Database) {
    this.timings = new RenderTimingsRepository(db);
  }

  insert(
    library: Pick<
      Library,
      | 'id'
      | 'root_path'
      | 'bin_name'
      | 'read_only'
      | 'name'
      | 'ordering'
      | 'rendition_source'
      | 'auto_stack'
      | 'include_subfolders'
      | 'include_non_raw'
    > & { identity?: BinIdentity },
  ): void {
    this.db
      .query(
        `INSERT INTO libraries (id, root_path, bin_name, read_only, name, ordering, rendition_source, auto_stack,
           include_subfolders, include_non_raw, bin_dev, bin_ino, bin_birthtime, stamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        library.id,
        library.root_path,
        library.bin_name,
        library.read_only ? 1 : 0,
        library.name,
        library.ordering,
        library.rendition_source,
        library.auto_stack ? 1 : 0,
        library.include_subfolders ? 1 : 0,
        library.include_non_raw ? 1 : 0,
        library.identity?.dev ?? null,
        library.identity?.ino ?? null,
        library.identity?.birthtime ?? null,
        stamp(this.db),
      );
  }

  getById(id: string): Library | null {
    const row = this.db.query(`${SELECT} WHERE l.id = ?`).get(id) as LibraryRow | null;
    return row ? mapRow(row, this.timings.forLibrary(row.id)) : null;
  }

  getByRootPath(rootPath: string): Library | null {
    const row = this.db.query(`${SELECT} WHERE l.root_path = ?`).get(rootPath) as LibraryRow | null;
    return row ? mapRow(row, this.timings.forLibrary(row.id)) : null;
  }

  list(): Library[] {
    const rows = this.db.query(`${SELECT} ORDER BY l.root_path`).all() as LibraryRow[];
    // One query for every library's timings rather than one per row: a settings page reads the
    // whole list, and most libraries have none at all.
    const measured = this.timings.byLibrary();
    return rows.map((row) => mapRow(row, measured.get(row.id) ?? {}));
  }

  setName(id: string, name: string): boolean {
    return this.db.query('UPDATE libraries SET name = ?, stamp = ? WHERE id = ?').run(name, stamp(this.db), id).changes > 0;
  }

  setOrdering(id: string, ordering: Ordering): boolean {
    return (
      this.db.query('UPDATE libraries SET ordering = ?, stamp = ? WHERE id = ?').run(ordering, stamp(this.db), id).changes > 0
    );
  }

  setRenditionSource(id: string, source: RenditionSource): boolean {
    return this.db.query('UPDATE libraries SET rendition_source = ? WHERE id = ?').run(source, id).changes > 0;
  }

  setRenditionHdr(id: string, hdr: boolean): boolean {
    return this.db.query('UPDATE libraries SET rendition_hdr = ? WHERE id = ?').run(hdr ? 1 : 0, id).changes > 0;
  }

  setRenderSkip(id: string, rendition: RenderedRendition, stages: readonly OptionalStage[]): boolean {
    // Chosen between the two spelled here rather than built out of anything a caller sent.
    const column = rendition === 'full' ? 'render_skip_full' : 'render_skip_max';
    return this.db.query(`UPDATE libraries SET ${column} = ? WHERE id = ?`).run(writeStages(stages), id).changes > 0;
  }

  setIncludeSubfolders(id: string, include: boolean): boolean {
    return (
      this.db.query('UPDATE libraries SET include_subfolders = ?, stamp = ? WHERE id = ?').run(include ? 1 : 0, stamp(this.db), id)
        .changes > 0
    );
  }

  setIncludeNonRaw(id: string, include: boolean): boolean {
    return (
      this.db.query('UPDATE libraries SET include_non_raw = ?, stamp = ? WHERE id = ?').run(include ? 1 : 0, stamp(this.db), id)
        .changes > 0
    );
  }

  setAutoStack(id: string, enabled: boolean): boolean {
    return (
      this.db.query('UPDATE libraries SET auto_stack = ?, stamp = ? WHERE id = ?').run(enabled ? 1 : 0, stamp(this.db), id)
        .changes > 0
    );
  }

  setAutoStackSimilarity(id: string, similarity: number): boolean {
    return (
      this.db.query('UPDATE libraries SET auto_stack_similarity = ?, stamp = ? WHERE id = ?').run(similarity, stamp(this.db), id)
        .changes > 0
    );
  }

  setAutoStackWindow(id: string, seconds: number): boolean {
    return (
      this.db.query('UPDATE libraries SET auto_stack_window_seconds = ?, stamp = ? WHERE id = ?').run(seconds, stamp(this.db), id)
        .changes > 0
    );
  }

  setReadOnly(id: string, readOnly: boolean): boolean {
    return this.db.query('UPDATE libraries SET read_only = ? WHERE id = ?').run(readOnly ? 1 : 0, id).changes > 0;
  }

  setBinName(id: string, binName: string | null): boolean {
    return (
      this.db.query('UPDATE libraries SET bin_name = ?, stamp = ? WHERE id = ?').run(binName, stamp(this.db), id).changes > 0
    );
  }

  // Read and written apart from `Library`, mirroring the shoots' folder identity
  // (`shoots_repository.ts`): on the row it would leak into every API response.
  getBinIdentity(id: string): BinIdentity | null {
    const row = this.db.query('SELECT bin_dev, bin_ino, bin_birthtime FROM libraries WHERE id = ?').get(id) as
      | { bin_dev: number | null; bin_ino: number | null; bin_birthtime: number | null }
      | null;
    return row == null ? null : { dev: row.bin_dev, ino: row.bin_ino, birthtime: row.bin_birthtime };
  }

  setBinIdentity(id: string, identity: BinIdentity): void {
    this.db
      .query('UPDATE libraries SET bin_dev = ?, bin_ino = ?, bin_birthtime = ? WHERE id = ?')
      .run(identity.dev, identity.ino, identity.birthtime, id);
  }

  // Stamped when a scan finishes, so the UI can say how stale the catalogue is
  // even after a restart (the in-memory status does not survive one, §9.6).
  setLastScannedAt(id: string, iso: string): void {
    this.db.query('UPDATE libraries SET last_synced_at = ? WHERE id = ?').run(iso, id);
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM libraries WHERE id = ?').run(id).changes > 0;
  }
}

function mapRow(row: LibraryRow, timings: RenderTimings): Library {
  return {
    id: row.id,
    root_path: row.root_path,
    bin_name: row.bin_name,
    read_only: row.read_only === 1,
    name: row.name,
    ordering: row.ordering as Ordering,
    rendition_source: row.rendition_source as RenditionSource,
    rendition_hdr: row.rendition_hdr === 1,
    render_skip_full: readStages(row.render_skip_full),
    render_skip_max: readStages(row.render_skip_max),
    render_timings: timings,
    include_subfolders: row.include_subfolders === 1,
    include_non_raw: row.include_non_raw === 1,
    auto_stack: row.auto_stack === 1,
    auto_stack_similarity: row.auto_stack_similarity,
    auto_stack_window_seconds: row.auto_stack_window_seconds,
    last_synced_at: row.last_synced_at,
    photo_count: row.photo_count,
  };
}
