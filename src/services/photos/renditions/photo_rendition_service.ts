import { existsSync } from 'node:fs';
import { AppError } from '../../../errors';
import type { Library } from '../../../schemas/libraries';
import type { Job } from '../../../schemas/jobs';
import { deleteGeneratedFile } from '../../../utils/deletions';
import { getDataPath, getRenditionPath } from '../../../utils/paths';
import type { Originals } from '../../blobs/originals';
import { isComposite } from '../../../schemas/recipes';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import { renditionCurrent, type RenditionFetchService } from '../../blobs/rendition_fetch_service';
import { extractMetadata, type FileMetadata } from '../../processing/analysis/metadata';
import type { ProcessingService } from '../../processing/pipeline/processing_service';
import { renditionVariant, type Rendition } from '../../processing/renditions/renditions';
import type { PhotoListingRepository } from '../listing/photo_listing_repository';
import type { PhotoMetadataRepository } from '../metadata/photo_metadata_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../paths/photo_paths_repository';
import type { PhotoProcessingRepository } from './photo_processing_repository';
import { photoLog as log } from '../photo_service_log';

export class PhotoRenditionService {
  constructor(
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoListing: PhotoListingRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
    private readonly processing: ProcessingService,
    private readonly originals: Originals,
    private readonly extract: (filePath: string) => Promise<FileMetadata> = extractMetadata,
    private readonly fetchThrough: RenditionFetchService | null,
  ) {}

  // The photo and its library, and nothing else. Everything that serves bytes or
    // builds a file wants these four columns; `get` above assembles the detail
    // view's payload - a second query for album membership, a stat per rendition,
    // a join for the ordering date - which a grid page of 100 tiles would pay for
    // 100 times over.
    locate(photoId: string): { photo: BasicPhoto; library: Library } {
      const photo = this.photoPaths.getBasicById(photoId);
      if (!photo) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
      const library = this.libraries.getById(photo.library_id);
      if (!library) throw new AppError('NOT_FOUND', `library not found: ${photo.library_id}`);
      return { photo, library };
    }
  // Re-reads the RAW header and updates the stored metadata. Sync only re-opens
    // a file whose stat changed, so photos catalogued before a metadata field
    // existed keep NULLs forever without this. Renditions are untouched: nothing
    // about the pixels changed.
    async refreshMetadata(photoIds: string[]): Promise<number> {
      let updated = 0;
      for (const photoId of photoIds) {
        const photo = this.photoListing.getById(photoId);
        if (!photo || photo.is_missing) continue;
        const library = this.libraries.getById(photo.library_id);
        if (!library) continue;
  
        // A synthesised row has no header to re-read: what a recipe composes takes its metadata
        // from the sources, so the way to refresh one is to compose it again.
        //
        // Whatever is here, and nothing fetched: this walks a selection, and a header re-read is
        // not worth pulling a library back off a drive one file at a time.
        const filePath = this.originals.here(library, photo);
        if (filePath == null) continue;
        try {
          const metadata = await this.extract(filePath);
          this.photoMetadata.updateMetadata(photoId, {
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
  async buildRendition(photoId: string, rendition: Rendition, force = false): Promise<void> {
      const key = `${photoId}:${rendition}:${force}`;
      const running = this.building.get(key);
      if (running != null) return running;
      const build = this.renderRendition(photoId, rendition, force).finally(() => this.building.delete(key));
      this.building.set(key, build);
      return build;
    }
  /**
     * What {@link buildRendition} would render, for a client that renders it itself and hands the
     * picture back to {@link keepRendition}.
     *
     * Null where there is nothing for a client to render - the copy on disk is current, the row is a
     * composite or the camera's own view, or this device has no original to send - and the caller
     * asks {@link buildRendition} instead, which answers each of those as it always has.
     */
    renditionJob(photoId: string, rendition: Rendition, force: boolean): { command: Job; builtFrom: string | null } | null {
      const { photo, library } = this.locate(photoId);
      if (rendition === 'embedded' || isComposite(photo.recipe)) return null;
      const hdr = library.rendition_hdr;
      if (!force && !this.stale(photo.id, rendition, hdr) && existsSync(getRenditionPath(library, photo.id, rendition, hdr))) {
        return null;
      }
      // Here only: the answer is whether *this* device can hand a client a job to render, and a
      // fetch started under it would leave the browser waiting on a drive with nothing said.
      // `buildRendition`, which the caller falls back to, is where an offloaded original comes
      // back.
      if (this.originals.here(library, photo) == null) return null;
      return this.processing.renditionCommand(photo.id, library, rendition, hdr, force);
    }
  /** Encodes and files the picture a client rendered of {@link renditionJob}'s job. */
    async keepRendition(photoId: string, rendition: Rendition, builtFrom: string | null, rendered: Uint8Array<ArrayBuffer>): Promise<void> {
      const { photo, library } = this.locate(photoId);
      if (rendition === 'embedded' || isComposite(photo.recipe)) {
        throw new AppError('VALIDATION_ERROR', `${rendition} of ${photoId} is not a rendition a client renders`);
      }
      const hdr = library.rendition_hdr;
      const startedAt = Date.now();
      await this.processing.keepRendered(photo.id, library, rendition, hdr, builtFrom, rendered);
      log.info('rendition rendered by a client', { photo: photo.id, rendition, hdr, ms: Date.now() - startedAt });
    }
  private async renderRendition(photoId: string, rendition: Rendition, force: boolean): Promise<void> {
      const { photo, library } = this.locate(photoId);
  
      // Both renditions follow the library's HDR setting: they are the same render
      // from the same RAW, and dropping one to SDR would make it the odd one out.
      //
      // "Both" being `full` and `max`. The grid tile is never HDR and `target` throws
      // rather than coercing, so this line would reject one - it is the route that
      // keeps it from having to, refusing `grid` before this is reached. Widen that
      // route and this needs `&& rendition !== 'grid'` in the same commit.
      //
      // `embedded` is reachable and is the same refusal: it is composed out of eight-bit
      // camera JPEGs, so there is no headroom for an HDR encode to carry.
      const hdr = library.rendition_hdr && rendition !== 'embedded';
      const output = getRenditionPath(library, photo.id, rendition, hdr);
      // Existing is not enough; it has to be of the settings the photograph holds now.
      // Nothing queues a `max`, so a rendition asked for by name is the one path where a
      // stale one is noticed at all.
      const rebuild = force || this.stale(photo.id, rendition, hdr);
      if (!rebuild && existsSync(output)) return;
  
      // The arm of the camera view that passes through: the bytes are inside the file this row
      // names and nothing builds them (§10.2), so "make sure it is there" is answered by the file
      // being there. Built instead it would be a render of the RAW filed under the one name that
      // promises it is not one.
      if (rendition === 'embedded' && !isComposite(photo.recipe)) {
        if ((await this.originals.open(library, photo)) == null) {
          throw new AppError('NOT_FOUND', `nothing on this device can build ${photo.id}`);
        }
        return;
      }
  
      // A photo whose file is gone has nothing to render from, and a decoder's refusal
      // surfaces as a 500 that says nothing useful. A row that never had one of its own takes the
      // same branch: what composes it is the queue's job, and a peer's copy is still worth asking
      // for while it has not run.
      // A composite has no file of its own, so it would take the branch below and be refused - but
      // its frames are right there and `max`, the one a reader zooms for, is never queued.
      //
      // The rebuild's delete is in here rather than shared with the file path below, which must not
      // reach one until after the peer fall-back has had its go.
      if (isComposite(photo.recipe)) {
        // Every frame back on this disk before the merge is asked for: the renderer takes paths,
        // and one frame offloaded would otherwise be a decode failure rather than a picture.
        await this.originals.openAll(library, photo);
        if (rebuild) await deleteGeneratedFile(getDataPath(library), output);
        const startedAt = Date.now();
        // False where a frame has gone: the recipe is still true and the picture may be makeable
        // again after the next sync, so this is the same "not here yet" the queue reports, not a
        // photograph that failed.
        if (!(await this.processing.buildComposite(photo.id, library, rendition, hdr))) {
          throw new AppError('NOT_FOUND', `nothing on this device can compose ${photo.id}`);
        }
        log.info('composite rendition built on demand', { photo: photo.id, rendition, hdr, ms: Date.now() - startedAt });
        return;
      }
  
      // Fetched back from the backup if this device has given its copy up (§14.4), which is what
      // makes an offloaded photograph open at all - slowly, once, and then as any other does.
      const raw = await this.originals.open(library, photo);
      if (raw == null) {
        // No original to build from: a peer's built copy is the §7.9 fall-back, cached at
        // exactly the path this build would have written. Reached before any delete, so a
        // device that cannot rebuild still holds what it had: deleting first and asking a
        // peer second is how the one stale-but-real copy became a hole when no peer answered.
        if (this.fetchThrough != null) {
          await this.fetchThrough.ensureCurrent(photo.id, rendition);
          if (existsSync(output)) return;
        }
        throw new AppError('NOT_FOUND', `nothing on this device can build ${photo.id}`);
      }
      // The file *is* the cache, so rebuilding means removing it: the builder returns early
      // on a file that already exists, and would otherwise hand back the copy being rejected.
      if (rebuild) await deleteGeneratedFile(getDataPath(library), output);
      const startedAt = Date.now();
      // The analysis lives outside the rendition cache, so without this a forced build is
      // re-encoded from the measurements the pipeline change under test was meant to move.
      await this.processing.renderOne(raw, photo.id, library, rendition, hdr, 'render', force);
      log.info('rendition built on demand', { photo: photo.id, rendition, hdr, forced: force, ms: Date.now() - startedAt });
    }
  /**
     * Queues the rebuild an editor that never said it had closed would have asked for.
     *
     * The editor asks on close, and a crashed tab, a closed browser and a killed process
     * never get to; nothing else revisits the question until the sweep at the next start,
     * which on a server that stays up is never. So the read asks it instead. The bytes on
     * disk are still served: this photograph one edit behind beats a hole in the grid, and
     * the rebuild moves the URL version when it lands, which is what repaints it.
     *
     * The gate is only that the photograph has been edited at all, not which variant is
     * stale. `queueEditedSince` owns that rule and asks it per variant in SQL; a second
     * copy of it here would be free to disagree - and did, refusing to queue a stale `full`
     * because the `grid` being asked for was current. What the cheap read buys is that an
     * unedited photograph, which is nearly all of them, costs one indexed lookup.
     *
     * A photograph whose render has already failed is left alone. `built_from` is only
     * written by a build that succeeded, so a photo the decoder refuses stays stale for
     * good - and `queueEditedSince` clears `processing_error` as it queues, so asking on
     * every request would spawn a worker per grid tile forever and erase the recorded
     * failure that the view exists to show.
     */
    rebuildIfStale(photoId: string): void {
      const stamps = this.photoProcessing.renditionStamps(photoId, 'grid');
      if (stamps?.edited_from == null || stamps.failed) return;
      this.processing.rebuildEdited([photoId]);
    }
  /** Whether the copy on disk was built from develop settings the photograph has moved past. */
    stale(photoId: string, rendition: Rendition, hdr: boolean): boolean {
      const stamps = this.photoProcessing.renditionStamps(photoId, renditionVariant(rendition, hdr));
      return !renditionCurrent(stamps?.built_from ?? null, stamps?.edited_from ?? null);
    }
  // One rendition of one photo, cached on disk: the file is the cache, and
    // processing clears it when the RAW changes, so switching renditions in the
    // detail view costs one build each and nothing after that. The full-resolution
    // one is seconds of work and tens of megabytes, which is why none of this
    // happens at import.
    //
    // The cached file only appears at the *end* of a render, so the check below
    // cannot dedupe concurrent requests - they all see nothing on disk and all
    // render. The viewer alone asks twice: the open builds the rendition it is about
    // to show, and the `<img>` already pointed at that URL 404s and asks for what is
    // missing.
    private readonly building = new Map<string, Promise<void>>();
}
