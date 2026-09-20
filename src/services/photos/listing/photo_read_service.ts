import { existsSync, statSync } from 'node:fs';
import { AppError } from '../../../errors';
import type { Ordering } from '../../../schemas/common';
import type { Library } from '../../../schemas/libraries';
import type {
  PhotoDaysRequest,
  PhotoDaysResponse,
  PhotoDetail,
  PhotoListQuery,
  PhotoListResponse,
  PhotoModelsRequest,
  PhotoModelsResponse,
  PhotoNeighboursRequest,
  PhotoPositionsRequest,
  PhotoRangeRequest,
  PhotoSelection,
  PhotoSummary,
  PhotoTarget,
} from '../../../schemas/photos';
import { isComposite } from '../../../schemas/recipes';
import type { AlbumsRepository } from '../../albums/albums_repository';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { ProcessingService } from '../../processing/pipeline/processing_service';
import { readEmbeddedJpeg } from '../../processing/rawshim/raw_decoder';
import type { Rendition } from '../../processing/renditions/renditions';
import type { SettingsRepository } from '../../settings/settings_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import { getRenditionPath, originalPathOf } from '../../../utils/paths';
import { hasEmbeddedJpeg, isEmbeddedJpegItself } from '../../../utils/scan';
import type { PhotoCompositesRepository } from '../composites/photo_composites_repository';
import type { PhotoPathsRepository } from '../paths/photo_paths_repository';
import type { PhotoNavigationRepository } from './photo_navigation_repository';
import type { PhotoListFilters, PhotoListResult, PhotoListingRepository, UnresolvedDetail, UnresolvedSummary } from './photo_listing_repository';
import type { PhotoRenditionService } from '../renditions/photo_rendition_service';
import { photoLog as log } from '../photo_service_log';
import {
  builtSetFrom,
  builtSetFromRow,
  contextOf,
  resolveRenditionToBuild,
  resolveShownRendition,
} from '../renditions/photo_rendition_policy';


export function toFilters(query: PhotoListQuery): PhotoListFilters {
  return {
    includeDeleted: query.include_deleted,
    isMissing: query.is_missing,
    isHidden: query.is_hidden,
    noShoot: query.no_shoot,
    isDeleted: query.is_deleted,
    rated: query.rated,
    triage: query.triage,
    search: query.q,
    takenFrom: query.taken_from,
    takenTo: query.taken_to,
    cameraModels: query.camera_models,
    lensModels: query.lens_models,
    match: query.match,
    count: query.count,
    expandStacks: query.expand_stacks,
  };
}

// The same shape from a JSON body rather than a query string. include_deleted
// defaults to false here as it does there, so a selection made outside the Bin
// can never resolve to a photo already in it.
export function fromSelectionFilters(filters: PhotoSelection['filters']): PhotoListFilters {
  return {
    includeDeleted: filters.include_deleted ?? false,
    isMissing: filters.is_missing,
    isHidden: filters.is_hidden,
    noShoot: filters.no_shoot,
    isDeleted: filters.is_deleted,
    rated: filters.rated,
    triage: filters.triage,
    search: filters.q,
    takenFrom: filters.taken_from,
    takenTo: filters.taken_to,
    cameraModels: filters.camera_models,
    lensModels: filters.lens_models,
    match: filters.match,
    expandStacks: filters.expand_stacks,
  };
}

export function withShownRendition<T extends UnresolvedSummary>(
  rows: T[],
  libraries: LibrariesRepository,
  settings: SettingsRepository,
): (T & Pick<PhotoSummary, 'shown_rendition' | 'has_embedded'>)[] {
  if (rows.length === 0) return [];
  const current = settings.get();
  const byLibrary = new Map(libraries.list().map((library) => [library.id, library]));
  return rows.map((row) => {
    const ctx = contextOf(
      row,
      byLibrary.get(row.library_id) ?? null,
      current,
      builtSetFromRow(row),
      false,
      row.composite_kind != null,
    );
    return { ...row, shown_rendition: resolveShownRendition(ctx), has_embedded: ctx.hasEmbedded };
  });
}

export class PhotoReadService {
  constructor(
    private readonly photoListing: PhotoListingRepository,
    private readonly photoNavigation: PhotoNavigationRepository,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoComposites: PhotoCompositesRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly libraries: LibrariesRepository,
    private readonly settings: SettingsRepository,
    private readonly processing: ProcessingService,
    private readonly renditions: PhotoRenditionService,
  ) {}

  get(photoId: string): PhotoDetail {
      const photo = this.photoListing.getById(photoId);
      if (!photo) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
      const library = this.libraries.getById(photo.library_id);
      if (library != null) this.repairGridTile(photo, library);
      // One stat, on a single-photo read only. The file is the cache, so asking
      // the filesystem beats a column that can disagree with what is on disk.
      const original = library == null ? null : originalPathOf(library, photo);
      const composed = isComposite(photo.recipe);
      const renditions = library == null ? null : this.renditionsOf(library, photo.id, original, photo.file_path, composed);
      // Exact: `renditionsOf` has just statted every one of them.
      const ctx = contextOf(photo, library, this.settings.get(), builtSetFrom(renditions), true, composed);
      const shown = resolveShownRendition(ctx);
      return {
        ...photo,
        original_path: original,
        has_original: original != null && existsSync(original),
        has_embedded: ctx.hasEmbedded,
        shown_rendition: shown,
        rendition_to_build: resolveRenditionToBuild(ctx),
        // Bytes handed over unchanged can never be stale; anything this row builds - the camera
        // view it composites included - is a file the develop settings can leave behind.
        rendition_stale:
          library != null && (shown !== 'embedded' || composed) && this.renditions.stale(photo.id, shown, library.rendition_hdr),
        renditions,
      };
    }
  private repairGridTile(photo: UnresolvedDetail, library: Library): void {
      if (this.repairing.has(photo.id)) return;
      if (existsSync(getRenditionPath(library, photo.id, 'grid', false))) return;
      // A synthesised row's tile is composed rather than rendered from a file, so the repair for
      // one is the queue's rebuild rather than this.
      const raw = originalPathOf(library, photo);
      if (raw == null || !existsSync(raw)) return; // nothing to render from; the photo reads as missing
  
      this.repairing.add(photo.id);
      void this.processing
        // Always the embedded JPEG, matching the import: the grid wants a small SDR
        // rendition from the fastest source there is, whatever the viewer is set to. A
        // photograph with none renders, which is what the import does for one too.
        .renderOne(raw, photo.id, library, 'grid', false, hasEmbeddedJpeg(photo.file_path) ? 'embedded' : 'render')
        .catch((err: unknown) => log.error('could not rebuild a grid tile', { photo: photo.id, err }))
        .finally(() => this.repairing.delete(photo.id));
    }
  editOrientation(photoId: string): number {
      return this.photoListing.editOrientation(photoId);
    }
  /** The library a stack belongs to, for the routes that serve a panorama's own files. */
    libraryOfStack(stackId: string): Library {
      const row = this.photoPaths.libraryOfStack(stackId);
      if (row == null) throw new AppError('NOT_FOUND', `stack not found: ${stackId}`);
      const library = this.libraries.getById(row);
      if (!library) throw new AppError('NOT_FOUND', `library not found: ${row}`);
      return library;
    }
  // Answered from disk rather than from a column, because settings are not
    // retroactive: a library switched to HDR after an import has SDR renditions,
    // and a client asking for a file that was never built would sit on a retrying
    // 404 rather than showing what is actually there.
    private renditionsOf(
      library: Library,
      photoId: string,
      raw: string | null,
      filePath: string | null,
      composesCameraView: boolean,
    ): PhotoDetail['renditions'] {
      const stored = (rendition: Rendition) => {
        // Never the cameras' own view, which is composed out of eight-bit JPEGs and has no
        // headroom to carry; `renditionVariant` files it under the plain name either way, so
        // saying otherwise here would report a range these bytes do not hold.
        const hdr = library.rendition_hdr && rendition !== 'embedded';
        const file = getRenditionPath(library, photoId, rendition, hdr);
        const still = statSync(file, { throwIfNoEntry: false });
        // A copy the develop settings have moved past is not one to open at. Said as "not
        // built" rather than as a flag of its own because that is the answer every reader
        // already acts on: `resolveShownRendition` stops choosing it, `resolveRenditionToBuild`
        // names it, and the client's own open then builds it - which is the only thing that
        // rebuilds a `max`, since no queue ever holds one.
        const current = !this.renditions.stale(photoId, rendition, hdr);
        return { path: file, built: still != null && current, bytes: still?.size ?? null, hdr };
      };
      // The cameras' own picture, however this row comes by one: composed out of its frames' and
      // filed like anything else, or - for a row that names one file - a format question rather
      // than a stat, since the bytes are inside that file and are there whenever it is. A PNG, a
      // HEIC or an AVIF has none, and saying so is what keeps the viewer from asking (§10.2).
      const lifted = raw != null && hasEmbeddedJpeg(filePath);
      return {
        embedded:
          composesCameraView ? stored('embedded')
          : { path: raw, built: lifted, bytes: raw != null && lifted ? this.embeddedBytes(raw) : null, hdr: false },
        full: stored('full'),
        max: stored('max'),
      };
    }
  // A RAW's camera JPEG has no file of its own to stat, so its weight is only
    // known by lifting it out - a header read and a copy, ~1ms, on a single-photo
    // read. Null for a RAW that has gone, which is also what keeps the native library out
    // of the tests: they name files that do not exist.
    //
    // A photograph that arrived *as* a JPEG has a file, and it is this one: a stat, rather than
    // reading a twenty-megabyte original into memory to measure it on every detail read.
    private embeddedBytes(raw: string): number | null {
      const still = statSync(raw, { throwIfNoEntry: false });
      if (still == null) return null;
      return isEmbeddedJpegItself(raw) ? still.size : (readEmbeddedJpeg(raw)?.length ?? null);
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
        this.photoListing.listByLibrary(libraryId, ordering, query.offset, query.limit, toFilters(query)),
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
        this.photoListing.listByShoot(shootId, ordering, query.offset, query.limit, toFilters(query)),
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
        this.photoListing.listByAlbum(albumId, ordering, query.offset, query.limit, toFilters(query)),
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
      if ('batch' in target) return this.photoPaths.idsDeletedInBatch(target.batch);
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
          return this.photoListing.idsInLibrary(scope.id, library.ordering, ranges, listFilters);
        }
        case 'shoot': {
          const shoot = this.shoots.getById(scope.id);
          if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
          return this.photoListing.idsInShoot(scope.id, shoot.ordering, ranges, listFilters);
        }
        case 'album': {
          const album = this.albums.getById(scope.id);
          if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
          return this.photoListing.idsInAlbum(scope.id, album.ordering, ranges, listFilters);
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
            return this.photoNavigation.positionsInLibrary(scope.id, library.ordering, keys, listFilters);
          }
          case 'shoot': {
            const shoot = this.shoots.getById(scope.id);
            if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
            return this.photoNavigation.positionsInShoot(scope.id, shoot.ordering, keys, listFilters);
          }
          case 'album': {
            const album = this.albums.getById(scope.id);
            if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
            return this.photoNavigation.positionsInAlbum(scope.id, album.ordering, keys, listFilters);
          }
        }
      })();
      return Object.fromEntries(found);
    }
  /** The bodies and lenses a collection was shot with, for the filter menu to offer. */
    modelsOf(request: PhotoModelsRequest): PhotoModelsResponse {
      const { scope, filters } = request;
      const listFilters = fromSelectionFilters(filters);
      switch (scope.kind) {
        case 'library':
          return this.photoListing.modelsInLibrary(scope.id, listFilters);
        case 'shoot':
          return this.photoListing.modelsInShoot(scope.id, listFilters);
        case 'album':
          return this.photoListing.modelsInAlbum(scope.id, listFilters);
      }
    }
  daysOf(request: PhotoDaysRequest): PhotoDaysResponse {
      const { scope, filters } = request;
      const listFilters = fromSelectionFilters(filters);
      switch (scope.kind) {
        case 'library':
          return this.photoListing.daysInLibrary(scope.id, listFilters);
        case 'shoot':
          return this.photoListing.daysInShoot(scope.id, listFilters);
        case 'album':
          return this.photoListing.daysInAlbum(scope.id, listFilters);
      }
    }
  /**
     * The frames a panorama was composed from, in the order its recipe names them (§19.4).
     *
     * What the badge on a composite's tile opens, and the only rows a client ever has for them: a
     * collapsed listing hides a frame behind the composite that stands for it, so these arrive
     * resolved for the same reason a stack's members do - unresolved, every one of them claims the
     * camera's JPEG and the client has nothing to correct it with (§18.5).
     */
    framesOf(photoId: string): PhotoSummary[] {
      const frames = this.photoComposites.framesOf(photoId).map((id) => this.photoListing.getById(id));
      return this.withShownRendition(frames.filter((frame) => frame != null));
    }
  /** The run of photographs around one, uncollapsed, for stepping the viewer (§19.5.3). */
    neighboursOf(request: PhotoNeighboursRequest): PhotoSummary[] {
      const { scope, filters, photo_id: photoId, limit } = request;
      const listFilters = fromSelectionFilters(filters);
      switch (scope.kind) {
        case 'library': {
          const library = this.libraries.getById(scope.id);
          if (!library) throw new AppError('NOT_FOUND', `library not found: ${scope.id}`);
          return this.withShownRendition(this.photoNavigation.neighboursInLibrary(scope.id, library.ordering, photoId, limit, listFilters));
        }
        case 'shoot': {
          const shoot = this.shoots.getById(scope.id);
          if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
          return this.withShownRendition(this.photoNavigation.neighboursInShoot(scope.id, shoot.ordering, photoId, limit, listFilters));
        }
        case 'album': {
          const album = this.albums.getById(scope.id);
          if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
          return this.withShownRendition(this.photoNavigation.neighboursInAlbum(scope.id, album.ordering, photoId, limit, listFilters));
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
          return this.withShownRendition(this.photoNavigation.rangeInLibrary(scope.id, library.ordering, bounds, listFilters));
        }
        case 'shoot': {
          const shoot = this.shoots.getById(scope.id);
          if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${scope.id}`);
          return this.withShownRendition(this.photoNavigation.rangeInShoot(scope.id, shoot.ordering, bounds, listFilters));
        }
        case 'album': {
          const album = this.albums.getById(scope.id);
          if (!album) throw new AppError('NOT_FOUND', `album not found: ${scope.id}`);
          return this.withShownRendition(this.photoNavigation.rangeInAlbum(scope.id, album.ordering, bounds, listFilters));
        }
      }
    }
  private respond(result: PhotoListResult, offset: number, limit: number, ordering: Ordering): PhotoListResponse {
      return {
        photos: this.withShownRendition(result.photos),
        total: result.total,
        photo_total: result.photoTotal,
        offset,
        limit,
        ordering,
      };
    }
  private withShownRendition<T extends UnresolvedSummary>(
      rows: T[],
    ): (T & Pick<PhotoSummary, 'shown_rendition' | 'has_embedded'>)[] {
      return withShownRendition(rows, this.libraries, this.settings);
    }
  // The grid tile is built at import, so a missing one means the file was cleared
    // under a photo that is still catalogued and the grid shows a hole nothing ever
    // fills: the queue only visits photos flagged for processing, and a reprocess
    // would take every other rendition with it (§10.3). Opening the photo is when a
    // person is looking, so that is when it is rebuilt - in the background, off the
    // read that reports it, and from the same source an import would have used.
    private readonly repairing = new Set<string>();
}
