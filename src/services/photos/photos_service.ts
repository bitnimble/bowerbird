import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Ordering } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';
import type {
  PhotoDetail,
  PhotoListQuery,
  PhotoListResponse,
  PhotoSummary,
  PhotoNeighboursRequest,
  PhotoPositionsRequest,
  PhotoRangeRequest,
  PhotoSelection,
  PhotoTarget,
  UpdatePhotoRequest,
} from '../../schemas/photos';
import { deleteGeneratedFile } from '../../utils/deletions';
import { getBinPath, getDataPath, getOriginalPath, getRenditionPath, toLibraryRelative } from '../../utils/paths';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { shootContains } from '../../utils/shoots';
import { ensureBinFolder } from '../libraries/bin_folder';
import type { Rendition } from '../processing/renditions';
import { extractMetadata, type FileMetadata } from '../processing/metadata';
import { readEmbeddedJpeg } from '../processing/raw_decoder';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { ProcessingService } from '../processing/processing_service';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { libraryMutex } from '../sync/library_mutex';
import type { BasicPhoto, DeletedPhoto, PhotoListFilters, PhotoListResult, PhotosRepository } from './photos_repository';

const log = new Logger('photos');

// Ids per `WHERE id IN (...)`, well under SQLite's variable limit.
const ID_CHUNK = 500;
// Photos whose Bin moves are committed together. Small enough that a crash
// between the moves and the commit leaves a bounded mess to roll back, large
// enough that a million-photo bin is a couple of thousand commits and not a
// million.
const DELETE_CHUNK = 500;

function* inChunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let from = 0; from < items.length; from += size) yield items.slice(from, from + size);
}

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
    count: query.count,
    expandStacks: query.expand_stacks,
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
    expandStacks: filters.expand_stacks,
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
      //
      // Unless the photo has been edited. The camera's JPEG cannot carry an edit, so
      // opening at it would show the reader the picture they just changed, unchanged,
      // with nothing saying why - and `toStages` renders an edited photo whatever the
      // library says, so there is a rendition to open at.
      default_rendition:
        library?.rendition_source === 'embedded' && !photo.is_edited ? 'embedded' : 'full',
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
      const still = statSync(file, { throwIfNoEntry: false });
      return { path: file, built: still != null, bytes: still?.size ?? null, hdr };
    };
    const raw = getOriginalPath(library, filePath);
    return {
      // The camera's JPEG is the RAW's own bytes, so it is always available and
      // never built (§10.2).
      embedded: { path: raw, built: true, bytes: this.embeddedBytes(raw), hdr: false },
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

  listMissing(libraryId: string, query: PhotoListQuery): PhotoListResponse {
    return this.listByLibrary(libraryId, {
      ...query,
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
    if ('batch' in target) return this.photos.idsDeletedInBatch(target.batch);
    // Members are named by id because a collapsed row gives them no position, and
    // a run may name their stack's row as well - so each photo is taken once.
    return [...new Set([...this.idsAtRanges(target.selection), ...target.selection.members])];
  }

  private idsAtRanges(selection: PhotoSelection): string[] {
    const { scope, filters, ranges } = selection;
    if (ranges.length === 0) return [];
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

  /**
   * Where the given rows sit in a scoped listing now (§19.6.1).
   *
   * A key is a photo id or a stack id, and the answer is every position that key
   * names: one for a row of a collapsed listing, one per member for a stack in an
   * uncollapsed one (§19.5.4). Naming a member alongside its stack answers under
   * both, so neither takes anything away from the other. A key that is no longer
   * in the collection is simply absent, which is how a client learns that the band
   * it had open has been filtered away.
   */
  positionsOf(request: PhotoPositionsRequest): Record<string, number[]> {
    const { scope, filters, keys } = request;
    const listFilters = fromSelectionFilters(filters);
    const found = ((): Map<string, number[]> => {
      switch (scope.kind) {
        case 'library': {
          const library = this.libraries.getById(scope.id);
          if (!library) throw new AppError('NOT_FOUND', `library not found: ${scope.id}`);
          return this.photos.positionsInLibrary(scope.id, library.ordering, keys, listFilters);
        }
        case 'shoot': {
          const shoot = this.shoots.getById(scope.id);
          if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
          return this.photos.positionsInShoot(scope.id, shoot.ordering, keys, listFilters);
        }
        case 'album': {
          const album = this.albums.getById(scope.id);
          if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
          return this.photos.positionsInAlbum(scope.id, album.ordering, keys, listFilters);
        }
      }
    })();
    return Object.fromEntries(found);
  }

  /** The run of photographs around one, uncollapsed, for stepping the viewer (§19.5.3). */
  neighboursOf(request: PhotoNeighboursRequest): PhotoSummary[] {
    const { scope, filters, photo_id: photoId, limit } = request;
    const listFilters = fromSelectionFilters(filters);
    switch (scope.kind) {
      case 'library': {
        const library = this.libraries.getById(scope.id);
        if (!library) throw new AppError('NOT_FOUND', `library not found: ${scope.id}`);
        return this.photos.neighboursInLibrary(scope.id, library.ordering, photoId, limit, listFilters);
      }
      case 'shoot': {
        const shoot = this.shoots.getById(scope.id);
        if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
        return this.photos.neighboursInShoot(scope.id, shoot.ordering, photoId, limit, listFilters);
      }
      case 'album': {
        const album = this.albums.getById(scope.id);
        if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
        return this.photos.neighboursInAlbum(scope.id, album.ordering, photoId, limit, listFilters);
      }
    }
  }

  /** Everything between two photographs, uncollapsed (§19.5.3). */
  rangeOf(request: PhotoRangeRequest): PhotoSummary[] {
    const { scope, filters, from, to } = request;
    const listFilters = fromSelectionFilters(filters);
    const bounds = { from, to };
    switch (scope.kind) {
      case 'library': {
        const library = this.libraries.getById(scope.id);
        if (!library) throw new AppError('NOT_FOUND', `library not found: ${scope.id}`);
        return this.photos.rangeInLibrary(scope.id, library.ordering, bounds, listFilters);
      }
      case 'shoot': {
        const shoot = this.shoots.getById(scope.id);
        if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
        return this.photos.rangeInShoot(scope.id, shoot.ordering, bounds, listFilters);
      }
      case 'album': {
        const album = this.albums.getById(scope.id);
        if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
        return this.photos.rangeInAlbum(scope.id, album.ordering, bounds, listFilters);
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
    //
    // "Both" being `full` and `max`. The grid tile is never HDR and `target` throws
    // rather than coercing, so this line would reject one - it is the route that
    // keeps it from having to, refusing `grid` before this is reached. Widen that
    // route and this needs `&& rendition !== 'grid'` in the same commit.
    const hdr = library.rendition_hdr;
    const output = getRenditionPath(library, photo.id, rendition, hdr);
    // The file *is* the cache, so forcing a rebuild means removing it: the
    // builder returns early on a file that already exists, and would otherwise
    // hand back exactly the copy being rejected.
    if (force) {
      await deleteGeneratedFile(getDataPath(library), output);
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

  update(photoId: string, updates: UpdatePhotoRequest): PhotoDetail {
    if (!this.photos.update(photoId, updates)) {
      throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    }
    return this.get(photoId);
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
          const moved: { id: string; from: string; to: string; binRelPath: string; wasAt: string }[] = [];
          for (const photo of chunk) {
            const from = getOriginalPath(library, photo.file_path);
            try {
              // A row whose file has already gone still gets flagged, so the Bin
              // is not missing photos the catalogue thinks are binned. A read-only
              // library takes the same branch for every row: nothing moves,
              // `file_path` is left alone, and `deleted_from_path` ends up equal
              // to it (§12.1).
              const binDir = library.read_only ? null : getBinPath(library, path.dirname(photo.file_path));
              if (binDir == null || !existsSync(from)) {
                moved.push({ id: photo.id, from, to: from, binRelPath: photo.file_path, wasAt: photo.file_path });
                continue;
              }
              if (!binDirs.has(binDir)) {
                await ensureBinFolder(library, this.libraries);
                await ensureDir(binDir);
                binDirs.add(binDir);
              }
              const dest = await moveIntoDir(from, binDir, path.basename(photo.file_path));
              moved.push({
                id: photo.id,
                from,
                to: dest,
                binRelPath: toLibraryRelative(library.root_path, dest),
                wasAt: photo.file_path,
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
            this.photos.transaction(() => {
              for (const row of moved) {
                // Only when it actually moved: a photo binned while its file was
                // already gone keeps is_missing, which is still true of it.
                if (row.binRelPath !== row.wasAt) this.photos.setFilePath(row.id, row.binRelPath);
                this.photos.markDeleted(row.id, row.wasAt, batch);
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
              if (row.to === row.from) continue;
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
      for (const photo of this.photos.getBasicByIds(chunk)) {
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
      for (const photo of photos) if (this.isInBin(library, photo.file_path)) stuck.push(library.name);
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
        if (library.read_only && photos.some((photo) => this.isInBin(library, photo.file_path))) {
          throw new AppError('READ_ONLY', `${library.name} became read-only while this undo was queued`);
        }
        const dirs = new Set<string>();
        for (const chunk of inChunks(photos, DELETE_CHUNK)) {
          const moved: { id: string; path: string }[] = [];
          for (const photo of chunk) {
            try {
              const from = getOriginalPath(library, photo.file_path);
              // "No move" is not "no validation": without this a row whose file
              // has gone goes live with `is_missing` cleared and nothing behind
              // it, and the renditions make the grid look fine while every
              // original 404s.
              if (!existsSync(from)) throw new AppError('IO_ERROR', `the file is no longer there: ${photo.file_path}`);

              // Binned in place: the file is already where it belongs. It cannot
              // merely skip the move - `moveIntoDir` would claim the name the file
              // already holds, hit EEXIST, walk its suffix loop to `a_1.arw` and
              // then unlink the source, silently renaming it under the photographer.
              if (!this.isInBin(library, photo.file_path)) {
                moved.push({ id: photo.id, path: photo.file_path });
                continue;
              }

              // Pre-column rows have no recorded origin; the library root is the
              // only safe guess, and the next sync reconciles shoot membership
              // from the path.
              const target = photo.deleted_from_path ?? path.basename(photo.file_path);
              const destDir = path.dirname(getOriginalPath(library, target));
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
          this.photos.transaction(() => {
            for (const row of moved) this.photos.markRestored(row.id, row.path);
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
  private isInBin(library: Library, filePath: string): boolean {
    return library.bin_name != null && shootContains(library.bin_name, filePath);
  }

  private deletedByLibrary(photoIds: string[]): Map<string, DeletedPhoto[]> {
    const grouped = new Map<string, DeletedPhoto[]>();
    for (const chunk of inChunks(photoIds, ID_CHUNK)) {
      for (const photo of this.photos.getDeletedByIds(chunk)) {
        const known = grouped.get(photo.library_id);
        if (known == null) grouped.set(photo.library_id, [photo]);
        else known.push(photo);
      }
    }
    return grouped;
  }

  private respond(result: PhotoListResult, offset: number, limit: number, ordering: Ordering): PhotoListResponse {
    return { photos: result.photos, total: result.total, offset, limit, ordering };
  }
}
