import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Ordering, Pagination } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';
import type { PhotoDetail, PhotoListQuery, PhotoListResponse, PhotoSelection, PhotoTarget, UpdatePhotoRequest } from '../../schemas/photos';
import { deleteGeneratedFile } from '../../utils/deletions';
import { getBinPath, getDataPath, getHdrPath, getOriginalPath, getRenditionPath, toLibraryRelative } from '../../utils/paths';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { HDR_MEDIA, HDR_VARIANTS } from '../processing/hdr_media';
import type { Rendition } from '../processing/renditions';
import { extractMetadata, type FileMetadata } from '../processing/metadata';
import { readEmbeddedJpeg } from '../processing/raw_decoder';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { ProcessingService } from '../processing/processing_service';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { libraryMutex } from '../sync/library_mutex';
import type { BasicPhoto, PhotoListFilters, PhotoListResult, PhotosRepository } from './photos_repository';

const log = new Logger('photos');

function toFilters(query: PhotoListQuery): PhotoListFilters {
  return {
    includeDeleted: query.include_deleted,
    isMissing: query.is_missing,
    needsTile: query.needs_tile,
    isDeleted: query.is_deleted,
    rated: query.rated,
    triage: query.triage,
    search: query.q,
    takenFrom: query.taken_from,
    takenTo: query.taken_to,
    match: query.match,
  };
}

// The same shape from a JSON body rather than a query string. include_deleted
// defaults to false here as it does there, so a selection made outside the Bin
// can never resolve to a photo already in it.
function fromSelectionFilters(filters: PhotoSelection['filters']): PhotoListFilters {
  return {
    includeDeleted: filters.include_deleted ?? false,
    isMissing: filters.is_missing,
    needsTile: filters.needs_tile,
    isDeleted: filters.is_deleted,
    rated: filters.rated,
    triage: filters.triage,
    search: filters.q,
    takenFrom: filters.taken_from,
    takenTo: filters.taken_to,
    match: filters.match,
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
      default_rendition: library?.rendition_source === 'embedded' ? 'embedded' : 'full',
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
      // Always the embedded JPEG, matching the import: the grid wants a small SDR
      // rendition from the fastest source there is, whatever the viewer is set to.
      .renderOne(raw, photo.id, library, 'grid', false, 'embedded')
      .catch((err: unknown) => log.error('could not rebuild a grid tile', { photo: photo.id, err }))
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
    const hdr = library.rendition_hdr;
    const stored = (rendition: Rendition) => {
      const file = getRenditionPath(library, photoId, rendition, hdr);
      const twin = getRenditionPath(library, photoId, rendition, hdr, true);
      const still = statSync(file, { throwIfNoEntry: false });
      const video = hdr ? statSync(twin, { throwIfNoEntry: false }) : undefined;
      return {
        path: file,
        built: still != null,
        bytes: still?.size ?? null,
        hdr,
        video: video == null ? null : { path: twin, bytes: video.size },
      };
    };
    const raw = getOriginalPath(library, filePath);
    return {
      // The camera's JPEG is the RAW's own bytes, so it is always available and
      // never built (§10.2).
      embedded: { path: raw, built: true, bytes: this.embeddedBytes(raw), hdr: false, video: null },
      full: stored('full'),
      max: stored('max'),
    };
  }

  // The camera's JPEG has no file of its own to stat, so its weight is only
  // known by lifting it out - a header read and a copy, ~1ms, on a single-photo
  // read. Null for a RAW that has gone, which is also what keeps LibRaw out of
  // the tests: they name files that do not exist.
  private embeddedBytes(raw: string): number | null {
    if (!existsSync(raw)) return null;
    return readEmbeddedJpeg(raw)?.length ?? null;
  }

  // The collection's stored ordering is the answer unless the request names one,
  // and either way the response says which was used. The sort is the collection's
  // own property, held in one place, rather than something every client keeps a
  // copy of and can disagree with (§18.3.1).
  listByLibrary(libraryId: string, query: PhotoListQuery): PhotoListResponse {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    const ordering = query.ordering ?? library.ordering;
    return this.respond(
      this.photos.listByLibrary(libraryId, ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
      ordering,
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
    const ordering = query.ordering ?? shoot.ordering;
    return this.respond(
      this.photos.listByShoot(shootId, ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
      ordering,
    );
  }

  listByAlbum(albumId: string, query: PhotoListQuery): PhotoListResponse {
    const album = this.albums.getById(albumId);
    if (!album) throw new AppError('NOT_FOUND', `album not found: ${albumId}`);
    const ordering = query.ordering ?? album.ordering;
    return this.respond(
      this.photos.listByAlbum(albumId, ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
      ordering,
    );
  }

  // What a bulk action applies to. A client that named its photos by id gets
  // them straight back; one that named them by position in a filtered collection
  // (§18.3.3) has them resolved here, against the same query and the same
  // collection-owned ordering the grid was listed with - so a selection of a
  // hundred thousand photos is one small request rather than a client reading
  // back every id first.
  resolve(target: PhotoTarget): string[] {
    if ('photo_ids' in target) return target.photo_ids;
    const { scope, filters, ranges } = target.selection;
    const listFilters = fromSelectionFilters(filters);
    switch (scope.kind) {
      case 'library': {
        const library = this.libraries.getById(scope.id);
        if (!library) throw new AppError('NOT_FOUND', `library not found: ${scope.id}`);
        return this.photos.idsInLibrary(scope.id, library.ordering, ranges, listFilters);
      }
      case 'shoot': {
        const shoot = this.shoots.getById(scope.id);
        if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
        return this.photos.idsInShoot(scope.id, shoot.ordering, ranges, listFilters);
      }
      case 'album': {
        const album = this.albums.getById(scope.id);
        if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
        return this.photos.idsInAlbum(scope.id, album.ordering, ranges, listFilters);
      }
    }
  }

  // Re-reads the RAW header and updates the stored metadata. Sync only re-opens
  // a file whose stat changed, so photos catalogued before a metadata field
  // existed keep NULLs forever without this. Renditions are untouched: nothing
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
        log.warn('metadata refresh failed', { photo: photoId, file: photo.file_path, err });
      }
    }
    log.info('metadata refreshed', { asked: photoIds.length, updated });
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
    const hdr = library.rendition_hdr;
    const output = getRenditionPath(library, photo.id, rendition, hdr);
    // The file *is* the cache, so forcing a rebuild means removing it: the
    // builder returns early on a file that already exists, and would otherwise
    // hand back exactly the copy being rejected. Its HDR video twin goes too, or
    // Firefox would keep the old frame while every other browser got the new one.
    if (force) {
      const dataPath = getDataPath(library);
      await deleteGeneratedFile(dataPath, output);
      await deleteGeneratedFile(dataPath, getRenditionPath(library, photo.id, rendition, hdr, true));
    } else if (existsSync(output)) {
      return;
    }

    // A photo whose file is gone has nothing to render from, and LibRaw's
    // "Input/output error" surfaces as a 500 that says nothing useful.
    const raw = getOriginalPath(library, photo.file_path);
    if (!existsSync(raw)) throw new AppError('NOT_FOUND', `original file not found: ${photo.file_path}`);
    const startedAt = Date.now();
    await this.processing.renderOne(raw, photo.id, library, rendition, hdr);
    log.info('rendition built on demand', { photo: photo.id, rendition, hdr, forced: force, ms: Date.now() - startedAt });
  }

  // Builds every rendition at once, both media and including the SDR
  // references: the point of the exercise is comparing them on real hardware,
  // and a browser that does one may not do the other. Sequential rather than
  // parallel because each is a full-resolution decode and encode.
  async buildHdr(photoId: string): Promise<void> {
    const { photo, library } = this.locate(photoId);

    const source = getOriginalPath(library, photo.file_path);
    if (!existsSync(source)) throw new AppError('NOT_FOUND', `original file not found: ${photo.file_path}`);

    const startedAt = Date.now();
    let built = 0;
    for (const medium of HDR_MEDIA) {
      for (const variant of HDR_VARIANTS) {
        const output = getHdrPath(library, photo.id, medium, variant);
        if (existsSync(output)) continue; // the file is the cache, as with the lossless render
        await this.processing.renderHdr(source, output, photo.id, medium, variant);
        built++;
      }
    }
    log.info('HDR renditions built', { photo: photo.id, built, ms: Date.now() - startedAt });
  }

  update(photoId: string, updates: UpdatePhotoRequest): PhotoDetail {
    if (!this.photos.update(photoId, updates)) {
      throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    }
    return this.get(photoId);
  }

  // Soft-delete: move the RAW to a Bin and flag is_deleted (§12). Renditions are
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
            await moveIntoDir(movedToBin, path.dirname(from), path.basename(from)).catch((e: unknown) =>
              log.error('could not roll a Bin move back; the file is in the Bin but the photo is not deleted', {
                photo: photo.id,
                file: movedToBin,
                err: e,
              }),
            );
          }
          throw dbErr;
        }

        });
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    log.info('photos deleted to the Bin', { asked: photoIds.length, failed: failures.length });
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
    log.info('photos restored from the Bin', { asked: photoIds.length, failed: failures.length });
    if (failures.length > 0) {
      throw new AppError('IO_ERROR', `failed to restore ${failures.length} photo(s): ${failures.join('; ')}`);
    }
  }

  // Bin lives inside the shoot folder for shoot photos, else at the library root.
  private binDir(library: Library, shootId: string | null): string {
    if (shootId) {
      const shoot = this.shoots.getById(shootId);
      if (shoot) return path.join(library.root_path, shoot.folder_path, 'Bin');
    }
    return getBinPath(library);
  }

  private respond(result: PhotoListResult, offset: number, limit: number, ordering: Ordering): PhotoListResponse {
    return { photos: result.photos, total: result.total, offset, limit, ordering };
  }
}
