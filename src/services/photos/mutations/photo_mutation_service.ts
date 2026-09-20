import { existsSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../errors';
import type { Library } from '../../../schemas/libraries';
import type { PhotoDetail, PhotoMarks, UpdatePhotoRequest } from '../../../schemas/photos';
import { soleInputOf } from '../../../schemas/recipes';
import { ensureDir, moveIntoDir } from '../../../utils/files';
import { getBinPath, libraryPath, originalPathOf, toLibraryRelative } from '../../../utils/paths';
import { shootContains } from '../../../utils/shoots';
import { ensureBinFolder } from '../../libraries/bin_folder';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import { libraryMutex } from '../../sync/coordination/library_mutex';
import type { PhotoStateRepository } from './photo_state_repository';
import type { BasicPhoto, DeletedPhoto, PhotoPathsRepository } from '../paths/photo_paths_repository';
import type { PhotoReadService } from '../listing/photo_read_service';
import { photoLog as log } from '../photo_service_log';

// Ids per `WHERE id IN (...)`, well under SQLite's variable limit.
export const ID_CHUNK = 500;

// Photos whose Bin moves are committed together. Small enough that a crash
// between the moves and the commit leaves a bounded mess to roll back, large
// enough that a million-photo bin is a couple of thousand commits and not a
// million.
export const DELETE_CHUNK = 500;

export function* inChunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let from = 0; from < items.length; from += size) yield items.slice(from, from + size);
}

export class PhotoMutationService {
  constructor(
    private readonly photoState: PhotoStateRepository,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly libraries: LibrariesRepository,
    private readonly read: PhotoReadService,
  ) {}

  update(photoId: string, updates: UpdatePhotoRequest): PhotoDetail {
      if (!this.photoState.update(photoId, updates)) {
        throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
      }
      return this.read.get(photoId);
    }
  // A verdict or a rating over a selection. Answers how many rows took it rather
    // than the rows themselves: the caller re-reads the collection anyway, since a
    // verdict can move a photograph out of the slice being viewed, and an id per
    // photo would be a 36MB answer at the sizes this is for.
    mark(photoIds: string[], marks: PhotoMarks): number {
      return this.photoState.updateMany(photoIds, marks);
    }
  // Putting a selection away, or bringing it back (§12.4). Nothing on disk moves and no rendition
    // is dropped: hiding is about what a listing answers with, so it is undone by asking again.
    hide(photoIds: string[], hidden: boolean): number {
      return this.photoState.setHidden(photoIds, hidden);
    }
  // Soft-delete: flag is_deleted, and where the library has a bin, move the RAW
    // into it (§12). The move is not what makes a photograph binned - the flag is;
    // the move exists so the next scan does not re-import the file, and the bin
    // channel (§9.1.1) arranges that without one. Renditions are deliberately KEPT: the
    // Bin exists to be browsed and restored from, which is impossible without them,
    // and a WebP pair is ~1% of the RAW the Bin is already holding. A photo that
    // fails is reported and the rest still go.
    //
    // Everything that is not per-file is done per *batch* (§12.1): the rows are
    // read in one query rather than one detail payload each, each bin directory is
    // created once however many photos land in it, `libraryMutex` is taken
    // once, and the flags are committed a chunk at a time. Done per photo - which is what
    // this was - binning a selection of a million cost 34 minutes before a single
    // byte moved on disk.
    async delete(photoIds: string[], batch?: string): Promise<void> {
      const failures: string[] = [];
      let deleted = 0;
      for (const [libraryId, photos] of this.byLibrary(photoIds)) {
        // Re-read inside the mutex, not before it: `bin_name` can be renamed now
        // (§4.1), and a queued bin move resuming with a stale name would recreate
        // the old folder and land its RAWs where the bin channel never walks.
        await libraryMutex.run(libraryId, async () => {
          const library = this.libraries.getById(libraryId);
          if (library == null) return;
          const binDirs = new Set<string>();
          for (const chunk of inChunks(photos, DELETE_CHUNK)) {
            // `from` and `to` are null for a row with no file of its own, which bins as the flag
            // alone - the same shape as a read-only library's binning, where nothing moves either.
            const moved: { id: string; from: string | null; to: string | null; binRelPath: string | null; wasAt: string | null }[] = [];
            for (const photo of chunk) {
              const was = soleInputOf(photo.recipe);
              const from = originalPathOf(library, photo);
              try {
                // A row whose file has already gone still gets flagged, so the Bin
                // is not missing photos the catalogue thinks are binned. A read-only
                // library takes the same branch for every row, and so does a row with
                // no file of its own: nothing moves, the recipe is left alone, and
                // `deleted_from_path` ends up equal to it (§12.1).
                const binDir = library.read_only || was == null ? null : getBinPath(library, path.dirname(was));
                if (binDir == null || from == null || !existsSync(from)) {
                  moved.push({ id: photo.id, from, to: from, binRelPath: was, wasAt: was });
                  continue;
                }
                if (!binDirs.has(binDir)) {
                  await ensureBinFolder(library, this.libraries);
                  await ensureDir(binDir);
                  binDirs.add(binDir);
                }
                const dest = await moveIntoDir(from, binDir, path.basename(from));
                moved.push({
                  id: photo.id,
                  from,
                  to: dest,
                  binRelPath: toLibraryRelative(library.root_path, dest),
                  wasAt: was,
                });
              } catch (err) {
                failures.push(`${photo.id}: ${(err as Error).message}`);
              }
            }
            if (moved.length === 0) continue;
  
            // The Bin paths and the deleted flags commit together, so no photo is
            // ever active with its file in the Bin. A chunk bounds how much a
            // crash between the moves and the commit could leave behind.
            try {
              this.photoPaths.transaction(() => {
                for (const row of moved) {
                  // Only when it actually moved: a photo binned while its file was
                  // already gone keeps is_missing, which is still true of it.
                  if (row.binRelPath != null && row.binRelPath !== row.wasAt) {
                    this.photoPaths.setFilePath(row.id, row.binRelPath);
                  }
                  this.photoPaths.markDeleted(row.id, row.wasAt, batch);
                }
              });
              deleted += moved.length;
            } catch (dbErr) {
              // The DB write failed AFTER the files moved. Unlike the shoot
              // move-ops (whose destination is scanned, so a later sync
              // move-detects and self-heals), the Bin is excluded from the live
              // scan, so a photo left is_deleted=0 with its file in the Bin is
              // orphaned forever. Move them back out, as if the delete never ran.
              // Unreachable for an in-place binning, where every row's `to` equals
              // its `from`.
              for (const row of moved) {
                if (row.to == null || row.from == null || row.to === row.from) continue;
                await moveIntoDir(row.to, path.dirname(row.from), path.basename(row.from)).catch((e: unknown) =>
                  log.error('could not roll a Bin move back; the file is in the Bin but the photo is not deleted', {
                    photo: row.id,
                    file: row.to,
                    err: e,
                  }),
                );
              }
              failures.push(`${moved.length} photo(s): ${(dbErr as Error).message}`);
            }
          }
        });
      }
      log.info('photos deleted to the Bin', { asked: photoIds.length, deleted, failed: failures.length });
      if (failures.length > 0) {
        throw new AppError('IO_ERROR', `failed to delete ${failures.length} photo(s): ${failures.join('; ')}`);
      }
    }
  // The photos to act on, grouped by the library whose lock and Bin they share.
    // One query per chunk of ids rather than a detail payload each: `delete` needs
    // four columns, and `getById` is a join plus a second query for album
    // membership it never looks at.
    private byLibrary(photoIds: string[]): Map<string, BasicPhoto[]> {
      const grouped = new Map<string, BasicPhoto[]>();
      for (const chunk of inChunks(photoIds, ID_CHUNK)) {
        for (const photo of this.photoPaths.getBasicByIds(chunk)) {
          const known = grouped.get(photo.library_id);
          if (known == null) grouped.set(photo.library_id, [photo]);
          else known.push(photo);
        }
      }
      return grouped;
    }
  // Undo of delete: clear is_deleted, and where the file is inside the bin, move
    // it back to exactly where it was (§12.3). Shoot and album membership are
    // untouched by delete, so they need no restoring.
    //
    // It branches on **where the file is**, not on the flag: `read_only` only
    // decides whether the bin arm may move anything. Two arms would break every
    // writable library, whose binned files are all inside the bin.
    //
    // Batched exactly as `delete` is, and for the same reason: an undo puts back
    // however many the bin took, so per-photo lookups and one commit each would
    // make the undo as slow as the thing it is undoing.
    async restore(photoIds: string[]): Promise<void> {
      const failures: string[] = [];
      let restored = 0;
      const byLibrary = this.deletedByLibrary(photoIds);
  
      // Every row's position is tested before any of them is restored, and across
      // every library the batch spans rather than one at a time: an undo is stamped
      // with a batch id, not with a library, so grouping first and refusing per
      // group restores whichever libraries happened to be iterated before the one
      // that refuses. A half-landed undo is worse than none.
      const stuck: string[] = [];
      for (const [libraryId, photos] of byLibrary) {
        const library = this.libraries.getById(libraryId);
        if (library?.read_only !== true) continue;
        for (const photo of photos) if (this.isInBin(library, soleInputOf(photo.recipe))) stuck.push(library.name);
      }
      if (stuck.length > 0) {
        throw new AppError(
          'READ_ONLY',
          `${stuck.length} of these photographs are in a read-only library's bin folder; clear the flag on ${[...new Set(stuck)].join(', ')} first`,
        );
      }
  
      for (const [libraryId, photos] of byLibrary) {
        await libraryMutex.run(libraryId, async () => {
          const library = this.libraries.getById(libraryId);
          if (library == null) return;
          // Re-read inside the fence, where `bin_name` and the flag are held still.
          // The check above is what keeps a batch from half-landing; this is the
          // narrow window where the flag was set while this queued.
          if (library.read_only && photos.some((photo) => this.isInBin(library, soleInputOf(photo.recipe)))) {
            throw new AppError('READ_ONLY', `${library.name} became read-only while this undo was queued`);
          }
          const dirs = new Set<string>();
          for (const chunk of inChunks(photos, DELETE_CHUNK)) {
            const moved: { id: string; path: string | null }[] = [];
            for (const photo of chunk) {
              try {
                const was = soleInputOf(photo.recipe);
                const from = originalPathOf(library, photo);
                // A row with no file of its own has nothing that could have been moved into the
                // Bin, so restoring one is the flag and nothing else.
                if (from == null || was == null) {
                  moved.push({ id: photo.id, path: was });
                  continue;
                }
                // "No move" is not "no validation": without this a row whose file
                // has gone goes live with `is_missing` cleared and nothing behind
                // it, and the renditions make the grid look fine while every
                // original 404s.
                if (!existsSync(from)) throw new AppError('IO_ERROR', `the file is no longer there: ${was}`);
  
                // Binned in place: the file is already where it belongs. It cannot
                // merely skip the move - `moveIntoDir` would claim the name the file
                // already holds, hit EEXIST, walk its suffix loop to `a_1.arw` and
                // then unlink the source, silently renaming it under the photographer.
                if (!this.isInBin(library, was)) {
                  moved.push({ id: photo.id, path: was });
                  continue;
                }
  
                // Pre-column rows have no recorded origin; the library root is the
                // only safe guess, and the next sync reconciles shoot membership
                // from the path.
                const target = photo.deleted_from_path ?? path.basename(was);
                const destDir = path.dirname(libraryPath(library, target));
                if (!dirs.has(destDir)) {
                  await ensureDir(destDir);
                  dirs.add(destDir);
                }
  
                // Restores to the recorded name, or a suffixed one if something
                // took the path meanwhile, so a restore never overwrites a live
                // photo.
                const dest = await moveIntoDir(from, destDir, path.basename(target));
                moved.push({ id: photo.id, path: toLibraryRelative(library.root_path, dest) });
              } catch (err) {
                failures.push(`${photo.id}: ${(err as Error).message}`);
              }
            }
            if (moved.length === 0) continue;
            this.photoPaths.transaction(() => {
              for (const row of moved) this.photoPaths.markRestored(row.id, row.path);
            });
            restored += moved.length;
          }
        });
      }
      log.info('photos restored from the Bin', { asked: photoIds.length, restored, failed: failures.length });
      if (failures.length > 0) {
        throw new AppError('IO_ERROR', `failed to restore ${failures.length} photo(s): ${failures.join('; ')}`);
      }
    }
  // Position, not the flag: a library flipped to read-only still holds the RAWs
    // the app put in its bin, and an in-place binned row's file is outside it.
    //
    // A row with no file is in no folder, so it is not in the bin folder either - which is what
    // lets the read-only refusals below pass over one rather than block a whole undo on it.
    private isInBin(library: Library, filePath: string | null): boolean {
      return filePath != null && library.bin_name != null && shootContains(library.bin_name, filePath);
    }
  private deletedByLibrary(photoIds: string[]): Map<string, DeletedPhoto[]> {
      const grouped = new Map<string, DeletedPhoto[]>();
      for (const chunk of inChunks(photoIds, ID_CHUNK)) {
        for (const photo of this.photoPaths.getDeletedByIds(chunk)) {
          const known = grouped.get(photo.library_id);
          if (known == null) grouped.set(photo.library_id, [photo]);
          else known.push(photo);
        }
      }
      return grouped;
    }
}
