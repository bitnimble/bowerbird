import type { Database } from '../../db/driver';
import { Logger } from '../../logger';
import type { ExportOptions } from '../../schemas/export';
import { newId } from '../../schemas/id';
import { EditDocSchema } from '../../schemas/photo_edits';
import type { ExportRun, ExportedPhoto, QueuedPhoto, RecordExportRequest } from '../../schemas/exports';
import { soleInputOf } from '../../schemas/recipes';
import type { PhotoEditsRepository } from '../photo_edits/photo_edits_repository';
import { PATH_OF } from '../photos/paths/photo_paths_repository';
import type { PhotoRenditionService } from '../photos/renditions/photo_rendition_service';
import { renditionBuiltAt } from '../processing/renditions/renditions_repository';
import type { SettingsRepository } from '../settings/settings_repository';

// Where photographs have been taken to (§10.5.1).
//
// Written by the client rather than by the export route, because the destination is the one
// part of an export the server never sees: a directory handle, the browser's downloads, a
// folder the desktop shell picked. Everything else is read here, at the moment the file
// lands, and stored as it stood.

interface ExportRow {
  id: string;
  run_id: string;
  photo_id: string;
  /** Joined off the photograph rather than stored, so a move is followed rather than frozen. */
  library_id: string | null;
  library_name: string | null;
  shoot_id: string | null;
  shoot_name: string | null;
  source_path: string;
  output_path: string;
  edits: string | null;
  width: number | null;
  height: number | null;
  has_thumbnail: number;
  exported_at: string;
}

interface QueuedRow {
  photo_id: string;
  library_id: string | null;
  library_name: string | null;
  shoot_id: string | null;
  shoot_name: string | null;
  source_path: string;
  tile_built_at: string | null;
  edits: string | null;
  width: number;
  height: number;
}

const log = new Logger('exports');

const ABANDONED_AFTER_MS = 60 * 60 * 1000;

const CHUNK = 500;

// Oldest first, which is the order the cull takes runs away in.
const RUNS_BY_AGE = `SELECT run_id, COUNT(*) AS files FROM exports
  GROUP BY run_id ORDER BY MAX(exported_at) ASC, MAX(rowid) ASC`;

export class ExportHistoryService {
  constructor(
    private readonly db: Database,
    private readonly photoRenditions: PhotoRenditionService,
    private readonly edits: PhotoEditsRepository,
    private readonly settings: SettingsRepository,
  ) {}

  /**
   * The row for a file that has just been rendered, before anybody knows where it will land.
   *
   * Written here rather than by the client because the tile is: it comes off the export's own
   * render (`ExportService.exportOne`), and sending it out to the page only for the page to
   * send it back would be a picture crossing the wire twice for nothing. What the client
   * still owes is the destination, which is the one part of an export the server never sees.
   */
  began(runId: string, photoId: string, options: ExportOptions, thumbnail: Uint8Array | null): void {
    const { photo } = this.photoRenditions.locate(photoId);
    const edits = options.includeEdits ? (this.edits.docFor(photoId)?.doc ?? null) : null;
    this.db
      .query(
        `INSERT INTO exports (id, run_id, photo_id, source_path, output_path, edits, thumbnail, exported_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      // The one file this row is, where it is one: a composite is a recipe over several and has
      // no path of its own, so it is named by its id as an export of one is (`ExportService`).
      .run(
        newId(),
        runId,
        photoId,
        soleInputOf(photo.recipe) ?? photoId,
        edits,
        thumbnail,
        new Date().toISOString(),
      );
    this.cull();
  }

  /**
   * Where the file went, which is what makes the row a history rather than a note that a
   * render happened - and what `list` waits for before showing it.
   *
   * Named by the run and the photograph rather than by a row id the render would have had to
   * hand back through two hosts. The newest match is the one being reported on: a run exports
   * a photograph once, and a reader who exported the same frame twice in one run is reporting
   * the second.
   */
  landed(request: RecordExportRequest): void {
    this.db
      .query(
        `UPDATE exports SET output_path = ?
          WHERE id = (SELECT id FROM exports
                       WHERE run_id = ? AND photo_id = ? AND output_path IS NULL
                       ORDER BY rowid DESC LIMIT 1)`,
      )
      .run(request.output_path, request.run_id, request.photo_id);
  }

  /**
   * Whole runs, oldest first, until the history is inside the reader's limit.
   *
   * **Runs rather than files**, which is why the limit is a floor: half a run listed as
   * "Exported 40 photos" over the twelve that survived is a worse history than one that stops
   * earlier. The newest run always stays, however large it is - a single export of two
   * thousand photographs is still the thing that just happened.
   *
   * Deleting the row takes its thumbnail with it, the picture being a column rather than a
   * file, so there is nothing else to sweep.
   */
  private cull(): void {
    // A render whose file never landed - the write failed, or the run was stopped between the
    // two - is a row nothing will ever report a destination for. It is not listed, so it is
    // swept here rather than by anything of its own; an hour is longer than any single export
    // takes and shorter than a reader would notice.
    this.db
      .query(`DELETE FROM exports WHERE output_path IS NULL AND exported_at < ?`)
      .run(new Date(Date.now() - ABANDONED_AFTER_MS).toISOString());

    const limit = this.settings.get().export_history_limit;
    // Counted before it is grouped: this runs once per exported file, and a bulk export of a
    // thousand photographs would otherwise group and sort the whole history a thousand times
    // to be told each time that nothing has to go.
    const { files } = this.db.query('SELECT COUNT(*) AS files FROM exports').get() as { files: number };
    if (files <= limit) return;

    const runs = this.db.query(RUNS_BY_AGE).all() as { run_id: string; files: number }[];
    let kept = runs.reduce((total, run) => total + run.files, 0);

    const drop = this.db.query('DELETE FROM exports WHERE run_id = ?');
    for (const run of runs.slice(0, -1)) {
      if (kept <= limit) return;
      drop.run(run.run_id);
      kept -= run.files;
      log.info('dropped the oldest export run to stay inside the history limit', { run: run.run_id, limit });
    }
  }

  /** The stored AVIF, or null where none was made. */
  thumbnailFor(id: string): Uint8Array | null {
    const row = this.db.query('SELECT thumbnail FROM exports WHERE id = ?').get(id) as
      | { thumbnail: Uint8Array | null }
      | null;
    return row?.thumbnail ?? null;
  }

  list(): ExportRun[] {
    // Every column but the picture, which is fetched a tile at a time by the page: selected
    // here it would be a thousand AVIFs read off disk to answer a list of paths. The table
    // itself is bounded by the cull, so there is no second limit here.
    //
    // `rowid` breaks the tie, not the id: a run writes several rows inside one millisecond,
    // and ordering those by a random id shuffles a run's files under the reader.
    //
    // The library and the shoot are joined off the photograph rather than stored: they are
    // facts about where it lives now, so a photograph moved between shoots reads under the one
    // holding it rather than the one it was exported from. Left joins, since the row outlives
    // the photograph and a history of a deleted one still says where its file went.
    const rows = this.db
      .query(
        `SELECT e.id, e.run_id, e.photo_id, e.source_path, e.output_path, e.edits, e.exported_at,
                e.thumbnail IS NOT NULL AS has_thumbnail, p.width, p.height,
                l.id AS library_id, l.name AS library_name,
                s.id AS shoot_id, s.folder_path AS shoot_name
           FROM exports e
           LEFT JOIN photos p ON p.id = e.photo_id
           LEFT JOIN libraries l ON l.id = p.library_id
           LEFT JOIN shoots s ON s.id = p.shoot_id
          WHERE e.output_path IS NOT NULL
          ORDER BY e.exported_at DESC, e.rowid DESC`,
      )
      .all() as ExportRow[];

    const runs = new Map<string, ExportRun>();
    for (const row of rows) {
      // The rows arrive newest first, so the run's own moment is its first row's and every
      // later one falls in under it.
      const run = runs.get(row.run_id) ?? { id: row.run_id, exported_at: row.exported_at, photos: [] };
      run.photos.push(photoOf(row));
      runs.set(row.run_id, run);
    }
    // Newest run first, and inside one the order it wrote them: a run is a list of files
    // rather than a sequence of moments, and reading it backwards helps nobody.
    return [...runs.values()].map((run) => ({ ...run, photos: run.photos.reverse() }));
  }

  /**
   * The rows a queued run would leave, read off the photographs it is about.
   *
   * The same joins `list` makes, so a run waiting to be written and one that has been read the
   * same way. In the order asked for rather than the order SQLite matched them, and short of
   * it where a photograph has left the catalogue since the run was queued.
   */
  queued(photoIds: string[], includeEdits: boolean): QueuedPhoto[] {
    const found = new Map<string, QueuedPhoto>();
    // Chunked: SQLite takes 32k bound parameters and a selection's export is not bounded by
    // anything this side of the library's size.
    for (let from = 0; from < photoIds.length; from += CHUNK) {
      const chunk = photoIds.slice(from, from + CHUNK);
      const rows = this.db
        .query(
          // **Neither of the first two is a column.** A photograph is a recipe over files
          // (`schemas/recipes`), so its path is read out of one - null for a composite, which is
          // named by its id as an export of one is - and what its copies were built at lives in
          // `renditions`. The table keeps its own name rather than taking an alias, so `PATH_OF`
          // is the rule stated once rather than a second `json_extract` to go stale.
          `SELECT photos.id AS photo_id, COALESCE(${PATH_OF}, photos.id) AS source_path,
                  ${renditionBuiltAt(`'grid'`, 'photos.id')} AS tile_built_at,
                  l.id AS library_id, l.name AS library_name,
                  s.id AS shoot_id, s.folder_path AS shoot_name,
                  e.doc AS edits, photos.width, photos.height
             FROM photos
             LEFT JOIN libraries l ON l.id = photos.library_id
             LEFT JOIN shoots s ON s.id = photos.shoot_id
             LEFT JOIN photo_edits e ON e.photo_id = photos.id
            WHERE photos.id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as QueuedRow[];
      for (const row of rows) found.set(row.photo_id, queuedOf(row, includeEdits));
    }
    return photoIds.map((id) => found.get(id)).filter((photo): photo is QueuedPhoto => photo != null);
  }

  forget(id: string): void {
    this.db.query('DELETE FROM exports WHERE id = ?').run(id);
  }

  /** A whole run, which is what the reader is looking at when a selection is one row. */
  forgetRun(runId: string): void {
    this.db.query('DELETE FROM exports WHERE run_id = ?').run(runId);
  }
}

function photoOf(row: ExportRow): ExportedPhoto {
  return {
    id: row.id,
    photo_id: row.photo_id,
    library_id: row.library_id,
    library_name: row.library_name,
    shoot_id: row.shoot_id,
    shoot_name: row.shoot_name,
    source_path: row.source_path,
    output_path: row.output_path,
    edits: parsedEdits(row.edits),
    width: row.width,
    height: row.height,
    has_thumbnail: row.has_thumbnail === 1,
    exported_at: row.exported_at,
  };
}

function queuedOf(row: QueuedRow, includeEdits: boolean): QueuedPhoto {
  return {
    photo_id: row.photo_id,
    library_id: row.library_id,
    library_name: row.library_name,
    shoot_id: row.shoot_id,
    shoot_name: row.shoot_name,
    source_path: row.source_path,
    edits: includeEdits ? parsedEdits(row.edits) : null,
    width: row.width,
    height: row.height,
    tile_built_at: row.tile_built_at,
  };
}

// A document a newer build wrote, or a corrupt one, costs this row its list of edits rather
// than the page it is on.
function parsedEdits(stored: string | null): ExportedPhoto['edits'] {
  if (stored == null) return null;
  try {
    const parsed = EditDocSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
