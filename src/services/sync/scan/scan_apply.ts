import { AppError } from '../../../errors';
import { sequenceColumn } from '../../../schemas/capture_sequence';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import type { ScanBatch } from './scan_batch';
import type { ClassifiedScan } from './scan_classification';
import type { CollectedEvidence } from './scan_evidence';
import type { ScanLeases } from './scan_leases';
import type { ScanReconciler } from './scan_reconciler';
import type { ScanTiles } from './scan_tiles';

export interface AppliedCounts {
  removed: number;
  moved: number;
  modified: number;
}



  export function applyChanges(
  dependencies: {
    libraries: LibrariesRepository;
    photoPaths: PhotoPathsRepository;
    photoMetadata: PhotoMetadataRepository;
    photoScan: PhotoScanRepository;
    shoots: ShootsRepository;
    reconciler: ScanReconciler;
    leases: ScanLeases;
  },
  input: {
    libraryId: string;
    owner: string;
    batch: ScanBatch;
    tiles: ScanTiles;
    evidence: CollectedEvidence;
    classified: ClassifiedScan;
  },
): AppliedCounts {
  const { libraries, photoPaths, photoMetadata, photoScan, shoots, reconciler, leases } = dependencies;
  const { libraryId, owner, batch, tiles, evidence, classified } = input;

    const { followed, binFolder, binRoot } = evidence;
    const { diff, result, imported, relocations, moves, relocatedPath, nowUtc } = classified;
    let removed = 0;
    // The relocated photos moved too, they were just answered in bulk.
    let moved = result.moves.length - moves.length;
    let modified = 0;

    // The library can be deleted during the (async) scan above; its photos are
    // then cascade-gone and inserting against the dead library_id would raise an
    // FK violation. Re-check here, no await between this and the synchronous
    // transaction, so the delete can't interleave, and abort cleanly.
    if (!libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

    leases.applyOwned(libraryId, owner, () => {
      // **Before anything path-guarded.** `setMissing` only marks a row whose
      // `file_path` still equals the path the scan saw, and after a followed
      // rename the scan's paths are the new ones while the rows still hold the
      // old - so a `setMissing` issued first would match nothing and silently do
      // nothing, a guard designed to absorb a race quietly absorbing a correct
      // write instead (§9.1.1).
      if (followed.rename != null) {
        libraries.setBinName(libraryId, followed.rename.to);
        photoPaths.rewriteBinnedPathPrefix(libraryId, followed.rename.from, followed.rename.to);
      }
      // First, so the per-photo work below is only ever the remainder.
      for (const r of relocations) {
        shoots.relocate(r.shootId, r.oldFolderPath, r.newFolderPath);
        photoPaths.rewritePathPrefix(libraryId, r.oldFolderPath, r.newFolderPath);
      }
      for (const mv of moves) {
        photoPaths.setFilePathAndShoot(mv.photoId, mv.newFilePath, batch.shootFor(mv.newFilePath));
        moved++;
      }
      for (const md of result.modified) {
        photoScan.applyModification(md.photoId, {
          file_hash: md.newHash,
          width: md.metadata.width,
          height: md.metadata.height,
          orientation: md.metadata.orientation,
          date_taken: md.metadata.dateTaken,
          date_taken_offset: md.metadata.dateTakenOffset,
          date_updated: md.metadata.mtime,
          file_size: md.metadata.fileSize,
          latitude: md.metadata.latitude,
          longitude: md.metadata.longitude,
          iso: md.metadata.iso,
          shutter_speed: md.metadata.shutterSpeed,
          aperture: md.metadata.aperture,
          focal_length: md.metadata.focalLength,
          camera_make: md.metadata.cameraMake,
          camera_model: md.metadata.cameraModel,
          lens_model: md.metadata.lensModel,
          capture_sequence: sequenceColumn(md.metadata.sequence),
        });
        batch.touched?.push(md.photoId);
        // Its pixels changed, so the tile the scan just built off them is the one this photo
        // should be showing - and its row already has the id to name it with.
        tiles.claim(md.photoId, md.stagedTile);
        modified++;
      }
      for (const cr of result.crossings) {
        reconciler.applyCrossing(cr, (relPath) => batch.shootFor(relPath), binFolder);
        moved++;
      }
      for (const ad of result.added) {
        if (ad.channel === 'bin') continue; // §9.1.1, below
        batch.insertPhoto(ad, nowUtc);
        batch.added++;
      }
      // An unclaimed file under the bin is imported as already-binned, with
      // where it would restore to read off the mirrored layout: `<bin>/A/B/c.arw`
      // came from `A/B/c.arw`, and `<bin>/c.arw` from the library root.
      for (const ad of imported) {
        const id = reconciler.insertAdded(libraryId, ad, null, nowUtc, {
          deleted_from_path: ad.filePath.slice(binRoot!.length + 1),
        });
        // Its tile too. A binned photograph is still shown - in the bin, and in a search that
        // includes it - and the scan built this one exactly as it built every other, so
        // dropping it here would encode a tile and delete it in the same run.
        tiles.claim(id, ad.stagedTile);
        batch.added++;
      }
      for (const photoId of diff.reappeared) {
        photoMetadata.clearMissing(photoId);
        // A photo that went missing before its renditions were built is skipped
        // by the queue while it is missing (§9.4 step 4), so the scan that
        // brings it back is the one that owes them. Left out of a scoped run's
        // batch it would sit there unbuilt until the daily full scan.
        batch.touched?.push(photoId);
      }
      for (const rm of result.removed) {
        // Keyed on where the row is *now*, which a relocation applied a few
        // lines up may have moved: `setMissing` only marks a row whose
        // `file_path` still equals the path handed to it, so one keyed on the
        // pre-rename path matches nothing and silently does nothing - a guard
        // written to absorb a race quietly absorbing a correct write (§9.1.1).
        // A frame deleted out of a folder that was renamed in the same window
        // would otherwise read as present with a 404ing original.
        const at = relocatedPath(rm.filePath);
        // Skips if a concurrent rename/move relocated the photo during the scan
        // (its file_path no longer matches what we scanned); it isn't missing.
        const marked = photoMetadata.setMissing(rm.photoId, at);
        if (!marked || rm.wasMissing) continue; // per-scan delta only (§9.4 step 5)
        // A binned row going missing is not a photograph leaving the library,
        // which is what `photosRemoved` counts: it is a change to a row that is
        // already out of the collection (§9.1.1).
        if (rm.channel === 'bin') modified++;
        else removed++;
      }
    });

    return { removed, moved, modified };
  
}
