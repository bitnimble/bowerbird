import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import type { Pagination } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';
import type { PhotoDetail, PhotoListQuery, PhotoListResponse, UpdatePhotoRequest } from '../../schemas/photos';
import { getBinPath, getHdrPath, getOriginalPath, getRenditionPath, toLibraryRelative } from '../../utils/paths';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { HDR_MEDIA, HDR_VARIANTS } from '../processing/hdr_media';
import type { Rendition } from '../processing/renditions';
import { extractMetadata, type FileMetadata } from '../processing/metadata';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { ProcessingService } from '../processing/processing_service';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { libraryMutex } from '../sync/library_mutex';
import type { BasicPhoto, PhotoListFilters, PhotoListResult, PhotosRepository } from './photos_repository';

function toFilters(query: PhotoListQuery): PhotoListFilters {
  return {
    includeDeleted: query.include_deleted,
    isMissing: query.is_missing,
    needsProcessing: query.needs_processing,
    isDeleted: query.is_deleted,
    rated: query.rated,
    triage: query.triage,
    search: query.q,
    takenFrom: query.taken_from,
    takenTo: query.taken_to,
    match: query.match,
  };
}

export class PhotosService {
  constructor(
    private readonly photos: PhotosRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly libraries: LibrariesRepository,
    private readonly processing: ProcessingService,
    // Defaulted rather than required, matching SyncService: a seam for tests
    // that must not pull LibRaw in, without every caller having to wire it.
    private readonly extract: (filePath: string) => Promise<FileMetadata> = extractMetadata,
  ) {}

  get(photoId: string): PhotoDetail {
    const photo = this.photos.getById(photoId);
    if (!photo) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    const library = this.libraries.getById(photo.library_id);
    if (library != null) this.repairGridTile(photo, library);
    // One stat, on a single-photo read only. The file is the cache, so asking
    // the filesystem beats a column that can disagree with what is on disk.
    return {
      ...photo,
      original_path: library == null ? null : getOriginalPath(library, photo.file_path),
      // A library that serves the camera's JPEG has no full-size rendition built,
      // so opening at one would mean waiting for a render nobody asked for.
      default_rendition: library?.preview_source === 'embedded' ? 'embedded' : 'full',
      renditions: library == null ? null : this.renditionsOf(library, photo.id, photo.file_path),
    };
  }

  // The grid tile is built at import, so a missing one means the file was cleared
  // under a photo that is still catalogued and the grid shows a hole nothing ever
  // fills: the queue only visits photos flagged for processing, and a reprocess
  // would take every other rendition with it (§10.3). Opening the photo is when a
  // person is looking, so that is when it is rebuilt - in the background, off the
  // read that reports it, and from the same source an import would have used.
  private readonly repairing = new Set<string>();

  private repairGridTile(photo: PhotoDetail, library: Library): void {
    if (this.repairing.has(photo.id)) return;
    if (existsSync(getRenditionPath(library, photo.id, 'grid', false))) return;
    const raw = getOriginalPath(library, photo.file_path);
    if (!existsSync(raw)) return; // nothing to render from; the photo reads as missing

    this.repairing.add(photo.id);
    void this.processing
      .renderOne(raw, photo.id, library, 'grid', false, photo.rendition_source ?? library.preview_source)
      .catch((err: unknown) => console.error(`could not rebuild the grid tile for ${photo.id}: ${String(err)}`))
      .finally(() => this.repairing.delete(photo.id));
  }

  // The photo and its library, and nothing else. Everything that serves bytes or
  // builds a file wants these three columns; `get` above assembles the detail
  // view's payload - a second query for album membership, a stat per rendition,
  // a join for the ordering date - and used to be what every image request went
  // through to read them. A grid page of 100 tiles paid for all of it 100 times.
  locate(photoId: string): { photo: BasicPhoto; library: Library } {
    const photo = this.photos.getBasicById(photoId);
    if (!photo) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    const library = this.libraries.getById(photo.library_id);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${photo.library_id}`);
    return { photo, library };
  }

  // Answered from disk rather than from a column, because settings are not
  // retroactive: a library switched to HDR after an import has SDR renditions,
  // and a client asking for a file that was never built would sit on a retrying
  // 404 rather than showing what is actually there.
  private renditionsOf(library: Library, photoId: string, filePath: string): PhotoDetail['renditions'] {
    const hdr = library.preview_hdr;
    const stored = (rendition: Rendition) => {
      const file = getRenditionPath(library, photoId, rendition, hdr);
      const twin = getRenditionPath(library, photoId, rendition, hdr, true);
      const video = hdr ? statSync(twin, { throwIfNoEntry: false }) : undefined;
      return {
        path: file,
        built: existsSync(file),
        hdr,
        video: video == null ? null : { path: twin, bytes: video.size },
      };
    };
    return {
      // The camera's JPEG is the RAW's own bytes, so it is always available and
      // never built (§10.2).
      embedded: { path: getOriginalPath(library, filePath), built: true, hdr: false, video: null },
      full: stored('full'),
      max: stored('max'),
    };
  }

  listByLibrary(libraryId: string, query: PhotoListQuery): PhotoListResponse {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    // The request's ordering wins over the collection's stored default, so a sort
    // control is a per-view choice rather than an edit to the library.
    return this.respond(
      this.photos.listByLibrary(libraryId, query.ordering ?? library.ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
    );
  }

  listMissing(libraryId: string, pagination: Pagination): PhotoListResponse {
    return this.listByLibrary(libraryId, {
      ...pagination,
      include_deleted: false,
      is_missing: true,
    });
  }

  listByShoot(shootId: string, query: PhotoListQuery): PhotoListResponse {
    const shoot = this.shoots.getById(shootId);
    if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);
    return this.respond(
      this.photos.listByShoot(shootId, query.ordering ?? shoot.ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
    );
  }

  listByAlbum(albumId: string, query: PhotoListQuery): PhotoListResponse {
    const album = this.albums.getById(albumId);
    if (!album) throw new AppError('NOT_FOUND', `album not found: ${albumId}`);
    return this.respond(
      this.photos.listByAlbum(albumId, query.ordering ?? album.ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
    );
  }

  // Re-reads the RAW header and updates the stored metadata. Sync only re-opens
  // a file whose stat changed, so photos catalogued before a metadata field
  // existed keep NULLs forever without this. Thumbnails are untouched: nothing
  // about the pixels changed.
  async refreshMetadata(photoIds: string[]): Promise<number> {
    let updated = 0;
    for (const photoId of photoIds) {
      const photo = this.photos.getById(photoId);
      if (!photo || photo.is_missing) continue;
      const library = this.libraries.getById(photo.library_id);
      if (!library) continue;

      const filePath = getOriginalPath(library, photo.file_path);
      if (!existsSync(filePath)) continue;
      try {
        const metadata = await this.extract(filePath);
        this.photos.updateMetadata(photoId, {
          width: metadata.width,
          height: metadata.height,
          orientation: metadata.orientation,
          date_taken: metadata.dateTaken,
          date_taken_offset: metadata.dateTakenOffset,
          latitude: metadata.latitude,
          longitude: metadata.longitude,
          iso: metadata.iso,
          shutter_speed: metadata.shutterSpeed,
          aperture: metadata.aperture,
          focal_length: metadata.focalLength,
          camera_make: metadata.cameraMake,
          camera_model: metadata.cameraModel,
          lens_model: metadata.lensModel,
        });
        updated++;
      } catch (err) {
        // One unreadable file must not abandon the rest of the selection.
        console.error(`metadata refresh failed for ${photo.file_path}: ${(err as Error).message}`);
      }
    }
    return updated;
  }

  // One rendition of one photo, cached on disk: the file is the cache, and
  // processing clears it when the RAW changes, so switching renditions in the
  // detail view costs one build each and nothing after that. The full-resolution
  // one is seconds of work and tens of megabytes, which is why none of this
  // happens at import.
  async buildRendition(photoId: string, rendition: Rendition, force = false): Promise<void> {
    const { photo, library } = this.locate(photoId);

    // Both renditions follow the library's HDR setting: they are the same render
    // from the same RAW, and dropping one to SDR would make it the odd one out.
    const hdr = library.preview_hdr;
    const output = getRenditionPath(library, photo.id, rendition, hdr);
    // The file *is* the cache, so forcing a rebuild means removing it: the
    // builder returns early on a file that already exists, and would otherwise
    // hand back exactly the copy being rejected. Its HDR video twin goes too, or
    // Firefox would keep the old frame while every other browser got the new one.
    if (force) {
      await rm(output, { force: true });
      await rm(getRenditionPath(library, photo.id, rendition, hdr, true), { force: true });
    } else if (existsSync(output)) {
      return;
    }

    // A photo whose file is gone has nothing to render from, and LibRaw's
    // "Input/output error" surfaces as a 500 that says nothing useful.
    const raw = getOriginalPath(library, photo.file_path);
    if (!existsSync(raw)) throw new AppError('NOT_FOUND', `original file not found: ${photo.file_path}`);
    await this.processing.renderOne(raw, photo.id, library, rendition, hdr);
  }

  // Builds every rendition at once, both media and including the SDR
  // references: the point of the exercise is comparing them on real hardware,
  // and a browser that does one may not do the other. Sequential rather than
  // parallel because each is a full-resolution decode and encode.
  async buildHdr(photoId: string): Promise<void> {
    const { photo, library } = this.locate(photoId);

    const source = getOriginalPath(library, photo.file_path);
    if (!existsSync(source)) throw new AppError('NOT_FOUND', `original file not found: ${photo.file_path}`);

    for (const medium of HDR_MEDIA) {
      for (const variant of HDR_VARIANTS) {
        const output = getHdrPath(library, photo.id, medium, variant);
        if (existsSync(output)) continue; // the file is the cache, as with the lossless render
        await this.processing.renderHdr(source, output, photo.id, medium, variant);
      }
    }
  }

  update(photoId: string, updates: UpdatePhotoRequest): PhotoDetail {
    if (!this.photos.update(photoId, updates)) {
      throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    }
    return this.get(photoId);
  }

  // Soft-delete: move the RAW to a Bin and flag is_deleted (§12). Thumbnails are
  // deliberately KEPT: the Bin exists to be browsed and restored from, which is
  // impossible without them, and a WebP pair is ~1% of the RAW the Bin is already
  // holding. Each photo is isolated so one failure doesn't abandon the rest.
  async delete(photoIds: string[]): Promise<void> {
    const failures: string[] = [];
    for (const id of photoIds) {
      try {
        const photo = this.photos.getById(id);
        if (!photo || photo.is_deleted) continue;
        const library = this.libraries.getById(photo.library_id);
        if (!library) continue;

        // Queue behind any in-flight sync of this library: the Bin move would
        // otherwise invalidate its mid-scan snapshot.
        await libraryMutex.run(photo.library_id, async () => {
        const from = getOriginalPath(library, photo.file_path);
        let binRelPath: string | null = null;
        let movedToBin: string | null = null;
        if (existsSync(from)) {
          const binDir = this.binDir(library, photo.shoot_id);
          await ensureDir(binDir);
          const dest = await moveIntoDir(from, binDir, path.basename(photo.file_path));
          movedToBin = dest;
          binRelPath = toLibraryRelative(library.root_path, dest);
        }

        // Commit the Bin path and the deleted flag atomically: a crash between
        // them would otherwise leave an active photo whose file is in the Bin.
        try {
          this.photos.transaction(() => {
            if (binRelPath != null) this.photos.setFilePath(photo.id, binRelPath);
            this.photos.markDeleted(photo.id, photo.file_path);
          });
        } catch (dbErr) {
          // The DB write failed AFTER the file was moved into the Bin. Unlike the
          // shoot move-ops (whose destination is scanned, so a later sync
          // move-detects and self-heals), the Bin is excluded from scanning, so a
          // photo left is_deleted=0 with its file in the Bin is orphaned forever.
          // Move it back out so state stays consistent (as if delete never ran).
          if (movedToBin != null) {
            await moveIntoDir(movedToBin, path.dirname(from), path.basename(from)).catch((e) =>
              console.error(`failed to roll back Bin move for ${photo.id}: ${(e as Error).message}`),
            );
          }
          throw dbErr;
        }

        });
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new AppError('IO_ERROR', `failed to delete ${failures.length} photo(s): ${failures.join('; ')}`);
    }
  }

  // Undo of delete: move the RAW out of the Bin back to exactly where it was and
  // clear is_deleted (§12.3). Shoot and album membership are untouched by delete,
  // so they need no restoring; only the file and its path moved.
  async restore(photoIds: string[]): Promise<void> {
    const failures: string[] = [];
    for (const id of photoIds) {
      try {
        const photo = this.photos.getById(id);
        if (!photo || !photo.is_deleted) continue;
        const library = this.libraries.getById(photo.library_id);
        if (!library) continue;

        await libraryMutex.run(photo.library_id, async () => {
          const from = getOriginalPath(library, photo.file_path);
          if (!existsSync(from)) {
            throw new AppError('IO_ERROR', `the file is no longer in the Bin: ${photo.file_path}`);
          }

          // Pre-column rows have no recorded origin; the library root is the only
          // safe guess, and the next sync reconciles shoot membership from the path.
          const target = this.photos.getDeletedFromPath(id) ?? path.basename(photo.file_path);
          const destDir = path.dirname(getOriginalPath(library, target));
          await ensureDir(destDir);

          // Restores to the recorded name, or a suffixed one if something took
          // the path meanwhile, so a restore can never overwrite a live photo.
          const dest = await moveIntoDir(from, destDir, path.basename(target));
          this.photos.markRestored(id, toLibraryRelative(library.root_path, dest));
        });
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new AppError('IO_ERROR', `failed to restore ${failures.length} photo(s): ${failures.join('; ')}`);
    }
  }

  // Bin lives inside the shoot folder for shoot photos, else the library data dir.
  private binDir(library: Library, shootId: string | null): string {
    if (shootId) {
      const shoot = this.shoots.getById(shootId);
      if (shoot) return path.join(library.root_path, shoot.folder_path, 'Bin');
    }
    return getBinPath(library);
  }

  private respond(result: PhotoListResult, offset: number, limit: number): PhotoListResponse {
    return { photos: result.photos, total: result.total, offset, limit };
  }
}
