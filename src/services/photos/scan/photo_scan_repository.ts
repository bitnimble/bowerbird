import type { Database } from '../../../db/driver';
import { fileRecipe } from '../../../schemas/recipes';
import { formatOf } from '../../../utils/scan';
import { stamp } from '../../replication/stamps';
import { inChunks } from '../photo_batches';
import { folderRange, IS_A_FILE } from '../paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../renditions/photo_processing_repository';

export interface ScanDbPhoto {
  id: string;
  file_path: string;
  file_hash: string | null;
  is_missing: boolean;
  date_updated: string | null;
  file_size: number | null;
}

export interface ScanInsert {
  id: string;
  library_id: string;
  shoot_id: string | null;
  file_hash: string;
  file_path: string;
  width: number;
  height: number;
  orientation: number;
  date_taken: string | null;
  date_taken_offset: string | null;
  date_added: string;
  date_updated: string | null;
  file_size: number;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutter_speed: number | null;
  aperture: number | null;
  focal_length: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  /**
   * An unclaimed file found under the bin comes in already binned (§9.1.1), with
   * where it would restore to and no rendition work queued: `PENDING_PROCESSING`
   * excludes `is_deleted = 1` anyway, and building renditions for something
   * already thrown away is work nobody asked for.
   */
  binned?: { deleted_from_path: string };
}

export interface ScanModification {
  file_hash: string;
  width: number;
  height: number;
  orientation: number;
  date_taken: string | null;
  date_taken_offset: string | null;
  date_updated: string | null;
  file_size: number;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutter_speed: number | null;
  aperture: number | null;
  focal_length: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
}

// Fields the scan quick-check needs to decide whether to re-open a file (§9.1).
/**
 * A scan row is a **file** the catalogue knows about, joined to the photograph it feeds.
 *
 * One row per input rather than per photograph, which is what carries a change on disk to
 * everything composed from it: a file two rows name arrives twice, and the diff reports it
 * against both (`buildDiff`).
 *
 * `IS_A_FILE` holds it to the rows that have a file at all. A composite has no path to be found
 * at, so a walk that included it would read it as an absence and mark it missing on the first
 * pass after it was made - and never unmark it, there being nothing that could appear.
 */
const SCAN_FROM = 'FROM photos JOIN photo_inputs i ON i.photo_id = photos.id';

export const SCAN_COLUMNS =
  'photos.id AS id, i.path AS file_path, photos.file_hash, photos.is_missing, photos.date_updated, photos.file_size';

export interface ScanRow {
  id: string;
  file_path: string;
  file_hash: string | null;
  is_missing: number;
  date_updated: string | null;
  file_size: number | null;
}

export class PhotoScanRepository {
  constructor(private readonly db: Database, private readonly processing: PhotoProcessingRepository) {}

  // --- scan (DESIGN §9) ---
  
    listForScan(libraryId: string): ScanDbPhoto[] {
      return this.mapScanRows(
        this.db
          .query(`SELECT ${SCAN_COLUMNS} ${SCAN_FROM} WHERE photos.library_id = ? AND is_deleted = 0 AND ${IS_A_FILE}`)
          .all(libraryId) as ScanRow[],
      );
    }
  // The binned rows, which the bin channel diffs its own walk against and which
    // the live channel needs in order to know that a path is already claimed (§9.1.1).
    // Never restricted by scope: one read on `idx_photos_is_deleted`.
    listBinnedForScan(libraryId: string): ScanDbPhoto[] {
      return this.mapScanRows(
        this.db
          .query(`SELECT ${SCAN_COLUMNS} ${SCAN_FROM} WHERE photos.library_id = ? AND is_deleted = 1 AND ${IS_A_FILE}`)
          .all(libraryId) as ScanRow[],
      );
    }
  // Scan rows at specific paths, the candidate set a scoped (watcher-driven) scan
    // reconciles, instead of the whole library (§9 scoped scan).
    listForScanByPaths(libraryId: string, paths: readonly string[]): ScanDbPhoto[] {
      const rows: ScanRow[] = [];
      for (const batch of inChunks(paths)) {
        const placeholders = batch.map(() => '?').join(', ');
        rows.push(
          ...(this.db
            .query(
              `SELECT ${SCAN_COLUMNS} ${SCAN_FROM}
                 WHERE photos.library_id = ? AND is_deleted = 0 AND ${IS_A_FILE} AND i.path IN (${placeholders})`,
            )
            .all(libraryId, ...batch) as ScanRow[]),
        );
      }
      return this.mapScanRows(rows);
    }
  // Scan rows recorded directly in each of these folders, which is what a poll
    // pass reconciles a folder listing against (§9.8). Direct children only: a row
    // in a subfolder would be diffed against a listing that never descended, and
    // read as a removal.
    listForScanInDirs(libraryId: string, dirs: readonly string[]): ScanDbPhoto[] {
      const rows: ScanRow[] = [];
      for (const dir of dirs) {
        // `instr` on what follows the folder's own prefix is the "no deeper slash"
        // test; the range in front of it is what keeps this on idx_photo_inputs_path.
        const where =
          dir === ''
            ? { clause: `instr(i.path, '/') = 0`, params: [] as (string | number)[] }
            : { clause: `i.path >= ? AND i.path < ? AND instr(substr(i.path, ?), '/') = 0`, params: [...folderRange(dir), dir.length + 2] };
        rows.push(
          ...(this.db
            .query(
              `SELECT ${SCAN_COLUMNS} ${SCAN_FROM}
                 WHERE photos.library_id = ? AND is_deleted = 0 AND ${IS_A_FILE} AND ${where.clause}`,
            )
            .all(libraryId, ...where.params) as ScanRow[]),
        );
      }
      return this.mapScanRows(rows);
    }
  // Already-missing rows; the move-source pool a scoped scan pairs new files
    // against by hash, so a relocation still resolves to a move across syncs (§9.3).
    listMissingForScan(libraryId: string): ScanDbPhoto[] {
      return this.mapScanRows(
        this.db
          .query(
            `SELECT ${SCAN_COLUMNS} ${SCAN_FROM}
               WHERE photos.library_id = ? AND is_deleted = 0 AND is_missing = 1 AND ${IS_A_FILE}`,
          )
          .all(libraryId) as ScanRow[],
      );
    }
  private mapScanRows(rows: ScanRow[]): ScanDbPhoto[] {
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
  // Takes the write lock up front, for a transaction that reads before it writes.
    // A deferred one takes its read snapshot at that first SELECT and has to
    // upgrade at the first write, which returns SQLITE_BUSY_SNAPSHOT - and
    // `busy_timeout` does not retry that one (§9.7).
    immediateTransaction<T>(fn: () => T): T {
      return this.db.transaction(fn).immediate();
    }
  insertFromScan(record: ScanInsert): void {
      const binned = record.binned != null;
      const at = stamp(this.db);
      this.db
        .query(
          `INSERT INTO photos
            (id, library_id, shoot_id, file_hash, recipe, format, file_size, width, height, orientation,
             is_missing, is_deleted, date_taken, date_taken_offset, date_added, date_updated,
             deleted_from_path,
             latitude, longitude, iso, shutter_speed, aperture, focal_length,
             camera_make, camera_model, lens_model, rating,
             -- The verdict and the stacking are left unstamped: this import has no
             -- opinion about either, and a NULL stamp is how a peer says so - anyone
             -- else's rating then wins rather than racing a default.
             stamp_imported, stamp_placement${binned ? ', stamp_bin' : ''})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ${binned ? 1 : 0}, ?, ?, ?, ?, ${binned ? '?' : 'NULL'},
             ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?${binned ? ', ?' : ''})`,
        )
        .run(
          record.id,
          record.library_id,
          record.shoot_id,
          record.file_hash,
          // An import is always one file, so the recipe it becomes is that file. Everything a
          // scan finds is this shape; a composite is made by whatever composed it, not found.
          JSON.stringify(fileRecipe(record.file_path)),
          // From the path rather than from the caller: the two would be a pair to keep in agreement,
          // and this is the only place a photograph's format is decided.
          formatOf(record.file_path),
          record.file_size,
          record.width,
          record.height,
          record.orientation,
          record.date_taken,
          record.date_taken_offset,
          record.date_added,
          record.date_updated,
          ...(record.binned == null ? [] : [record.binned.deleted_from_path]),
          record.latitude,
          record.longitude,
          record.iso,
          record.shutter_speed,
          record.aperture,
          record.focal_length,
          record.camera_make,
          record.camera_model,
          record.lens_model,
          ...(binned ? [at, at, at] : [at, at]),
        );
    }
  applyModification(photoId: string, fields: ScanModification): void {
      // The stamp only moves if the import facts did. A photograph whose original
      // has just arrived from a peer has no local scan baseline yet - `file_hash`
      // and `date_updated` are per-peer and do not replicate - so the next scan
      // reads the same bytes as "modified" and would otherwise mint a stamp that
      // re-broadcasts import facts nobody changed, and could beat the importer's own
      // on nothing but a rounding difference (§5.4: write only if different).
      const moved = this.importedUnitDiffers(photoId, fields) ? stamp(this.db) : null;
      this.db
        .query(
          `UPDATE photos SET file_hash = ?, width = ?, height = ?, orientation = ?, date_taken = ?, date_taken_offset = ?,
            date_updated = ?, file_size = ?, latitude = ?, longitude = ?, iso = ?, shutter_speed = ?,
            aperture = ?, focal_length = ?, camera_make = ?, camera_model = ?, lens_model = ?,
            -- rendition_source cleared with the flag that re-queues them, for the same reason
            -- queueRenditionRebuildForLibrary clears it: the column says what the *last* build
            -- used, and toStages reads it to decide whether a viewer rendition is owed at all.
            -- Left standing, a photo imported under an 'embedded' library and edited after the
            -- library moved to 'render' keeps resolving 'embedded', so no full rendition is
            -- ever built and the viewer asks for a file nothing writes.
            rendition_source = NULL, is_missing = 0,
            stamp_imported = COALESCE(?, stamp_imported) WHERE id = ?`,
        )
        .run(
          fields.file_hash,
          fields.width,
          fields.height,
          fields.orientation,
          fields.date_taken,
          fields.date_taken_offset,
          fields.date_updated,
          fields.file_size,
          fields.latitude,
          fields.longitude,
          fields.iso,
          fields.shutter_speed,
          fields.aperture,
          fields.focal_length,
          fields.camera_make,
          fields.camera_model,
          fields.lens_model,
          moved,
          photoId,
        );
      // The file's pixels changed, so every derived copy of it is of the old one.
      this.processing.queueBothPasses(photoId);
    }
  // What the `imported` unit actually carries, against what the scan just read.
    // `file_hash` and `date_updated` are per-peer and are not part of it.
    private importedUnitDiffers(photoId: string, fields: ScanModification): boolean {
      const held = this.db
        .query(
          `SELECT width, height, orientation, date_taken, date_taken_offset, file_size, latitude, longitude,
                  iso, shutter_speed, aperture, focal_length, camera_make, camera_model, lens_model
             FROM photos WHERE id = ?`,
        )
        .get(photoId) as Record<string, unknown> | null;
      if (held == null) return true;
      return Object.entries(held).some(
        ([column, value]) => value !== (fields as unknown as Record<string, unknown>)[column],
      );
    }
}
