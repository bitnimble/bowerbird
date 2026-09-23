import type { Database } from '../../../db/driver';
import { stamp } from '../../replication/stamps';
import { IS_A_FILE } from '../paths/photo_paths_repository';
import type { ScanModification } from '../scan/photo_scan_repository';
import type { PhotoProcessingRepository } from '../renditions/photo_processing_repository';

// Everything a re-read of the RAW header can refresh: no hash, no timestamps of
// our own, nothing that says the file changed.
export type PhotoMetadataFields = Omit<ScanModification, 'file_hash' | 'file_size' | 'date_updated'>;

export class PhotoMetadataRepository {
  constructor(private readonly db: Database, private readonly processing: PhotoProcessingRepository) {}

  // Header fields only. Deliberately does not touch file_hash, date_updated or
    // either pending flag: re-reading metadata is not a content change, so it must
    // not look like one to the next scan or trigger a rebuild.
    updateMetadata(photoId: string, fields: PhotoMetadataFields): void {
      this.db
        .query(
          `UPDATE photos SET width = ?, height = ?, orientation = ?, date_taken = ?, date_taken_offset = ?, latitude = ?,
            longitude = ?, iso = ?, shutter_speed = ?, aperture = ?, focal_length = ?,
            camera_make = ?, camera_model = ?, lens_model = ?, capture_sequence = ?, stamp_imported = ? WHERE id = ?`,
        )
        .run(
          fields.width,
          fields.height,
          fields.orientation,
          fields.date_taken,
          fields.date_taken_offset,
          fields.latitude,
          fields.longitude,
          fields.iso,
          fields.shutter_speed,
          fields.aperture,
          fields.focal_length,
          fields.camera_make,
          fields.camera_model,
          fields.lens_model,
          fields.capture_sequence,
          stamp(this.db),
          photoId,
        );
    }
  // Every id in the catalogue, including soft-deleted rows: a binned photo still
    // has its renditions, which is what makes the Bin browsable (§12.1).
    allIds(): string[] {
      return (this.db.query('SELECT id FROM photos').all() as { id: string }[]).map((r) => r.id);
    }
  contentHashOf(photoId: string): string | null {
      const row = this.db.query('SELECT content_hash FROM photos WHERE id = ?').get(photoId) as
        | { content_hash: string | null }
        | null;
      return row?.content_hash ?? null;
    }
  // Written by the sending peer of the photo's first transfer, off the bytes it
    // was already streaming, and stamped into the imported unit as an ordinary
    // replicated write (docs/replication.md §7.1).
    setContentHash(photoId: string, contentHash: string): void {
      this.db
        .query('UPDATE photos SET content_hash = ?, stamp_imported = ? WHERE id = ?')
        .run(contentHash, stamp(this.db), photoId);
    }
  // An original arriving from a peer heals its placeholders without a rescan
    // (docs/replication.md §7.8). Per-peer columns only: nothing here replicates.
    markOriginalArrived(photoId: string): void {
      this.db.query('UPDATE photos SET is_missing = 0, processing_error = NULL WHERE id = ?').run(photoId);
      this.processing.queueBothPasses(photoId);
    }
  // A row binned in place whose file was moved by hand. Both columns follow,
    // because for such a row they name the same file: `deleted_from_path` is where
    // a restore puts it back, and left at the old path the restore would recreate
    // the folder the photographer just renamed away.
    moveBinnedInPlace(photoId: string, filePath: string): void {
      // Placement only, for the reason `rewritePathPrefix` gives at length: stamping
      // the bin unit for a path correction asserts the binning was decided now, and
      // loses a restore made on another peer while this one was apart. So
      // `deleted_from_path` is corrected here and does not travel, and a peer holds
      // the old origin against the new path until something decides the bin unit
      // again. Nothing reads the pair as a *classifier* any more, which is what made
      // that disagreement matter; it costs only the restore's tidiness, as a rename
      // does.
      this.db
        .query(
          `UPDATE photos SET recipe = json_set(recipe, '$.path', ?), deleted_from_path = ?, is_missing = 0,
             stamp_placement = ? WHERE id = ? AND ${IS_A_FILE}`,
        )
        .run(filePath, filePath, stamp(this.db), photoId);
    }
  // Which side of the bin a crossing's row is on now, which decides whether it is
    // a flag change or only a path update (§9.1.1).
    isBinned(photoId: string): boolean {
      const row = this.db.query('SELECT is_deleted FROM photos WHERE id = ?').get(photoId) as { is_deleted: number } | null;
      return row?.is_deleted === 1;
    }
  clearMissing(photoId: string): void {
      this.db.query('UPDATE photos SET is_missing = 0 WHERE id = ?').run(photoId);
    }
  // Guarded on the path the scan scanned: if a concurrent move/soft-delete
    // changed where the row's file is during the (async) scan, the row is no longer
    // "missing at that path", so this is a no-op. Returns whether it actually marked missing.
    setMissing(photoId: string, expectedFilePath: string): boolean {
      return (
        this.db
          .query(
            `UPDATE photos SET is_missing = 1
               WHERE id = ? AND EXISTS (SELECT 1 FROM photo_inputs i WHERE i.photo_id = photos.id AND i.path = ?)`,
          )
          .run(photoId, expectedFilePath).changes > 0
      );
    }
}
