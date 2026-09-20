import type { Database } from '../../db/driver';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { PathSegment, route } from '../../schemas/route';
import { stampWithinSkew } from '../replication/stamps';
import { deleteGeneratedFile } from '../../utils/deletions';
import { getDataPath, getRenditionPath, originalPathOf } from '../../utils/paths';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../photos/renditions/photo_processing_repository';
import { renditionVariant, type Rendition } from '../processing/renditions/renditions';
import { pairedPeers } from '../replication/pairing';
import type { BlobLocations } from './blob_locations';
import { contentHash } from '../../utils/hash';
import { appendToStage } from './blob_store';
import { RenditionCache } from './rendition_cache';
import type { PeerTransport } from './peer';

// Renditions from a peer (docs/replication.md §7.9): a device holding the
// catalogue but not the original serves tiles and renditions anyway, by fetching
// a peer's built copy and caching it as an ordinary rendition file.

const log = new Logger('blobs');

/**
 * The pipeline's own staleness rule (`queueEditedSince`), as one predicate both
 * sides of a fetch apply: a render is current unless the photograph's develop
 * settings have moved since the ones it was built from.
 *
 * Stamps, not times. A build happens on whichever peer holds the original and an
 * edit on whichever peer made it, and those are routinely different machines - a
 * catalogue-only peer never builds anything at all - so a comparison of wall
 * clocks is a comparison of two machines' clocks. A minute out either way hides an
 * edit for good or refuses a correct render, both silently, and a minute is well
 * inside what the HLC deliberately absorbs (§2.2). A stamp has no clock in it and
 * is byte-comparable, so this is the same comparison over values that mean
 * something across the fleet.
 */
export function renditionCurrent(builtFrom: string | null, editedFrom: string | null): boolean {
  return editedFrom == null || (builtFrom != null && builtFrom >= editedFrom);
}

export class RenditionFetchService {
  private readonly fetching = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoProcessing: PhotoProcessingRepository,
    private readonly libraries: LibrariesRepository,
    private readonly locations: BlobLocations,
    private readonly transport: PeerTransport,
    private readonly cache: RenditionCache = new RenditionCache(db),
  ) {}

  /**
   * The fall-back order, in one place (§7.9): a current local rendition is kept;
   * failing that, a peer's built rendition is fetched and cached; fetching the
   * whole original to build locally is **never** done here - that is the
   * explicit §7.5 action, and walking a device into it over a missing tile is
   * exactly the accident the order exists to rule out. No peer able to answer is
   * a NOT_FOUND, unless a stale cached copy can stand in.
   */
  async ensureCurrent(photoId: string, rendition: Rendition): Promise<void> {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) return;
    const library = this.libraries.getById(photo.library_id);
    if (library == null) return;
    // The local pipeline owns every photo whose original is here: it builds on
    // request, rebuilds on edit and sweeps what it rebuilt. A fetched copy would
    // fight it, and a locally built rendition is preferred anyway.
    const original = originalPathOf(library, photo);
    // ponytail: a composed row is treated as the local pipeline's whatever this device holds,
    // which is what a panorama gets today. It is right only while every source is here - the
    // check that says so wants the sources on the row, so it lands with them.
    if (original == null || existsSync(original)) return;

    const key = `${photoId}:${rendition}`;
    const running = this.fetching.get(key);
    if (running != null) return running;
    const run = this.fetchIfStale(photo, library, rendition).finally(() => this.fetching.delete(key));
    this.fetching.set(key, run);
    return run;
  }

  private async fetchIfStale(photo: BasicPhoto, library: Library, rendition: Rendition): Promise<void> {
    // The dynamic range this device's library builds (§3.2, per-peer): a holder
    // that built only the other range does not have the file, which is a miss.
    const hdr = rendition !== 'grid' && library.rendition_hdr;
    const target = getRenditionPath(library, photo.id, rendition, hdr);
    const stamps = this.photoProcessing.renditionStamps(photo.id, renditionVariant(rendition, hdr));
    const builtFrom = stamps?.built_from ?? null;
    const editedFrom = stamps?.edited_from ?? null;
    const cached = existsSync(target);
    if (cached && renditionCurrent(builtFrom, editedFrom)) {
      // Served from the cache, which is what "recently used" means for one.
      this.cache.touch(library.id, photo.id, rendition, hdr);
      return;
    }

    try {
      await this.fetch(photo, library, rendition, hdr, target, editedFrom);
    } catch (error) {
      // On a device that cannot rebuild, the stale picture beats a hole; the
      // next request asks again.
      if (!cached) throw error;
      log.warn('kept a stale fetched rendition; no peer holds a current one', {
        photo: photo.id,
        rendition,
        err: String(error),
      });
    }
  }

  private async fetch(
    photo: BasicPhoto,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    target: string,
    editedFrom: string | null,
  ): Promise<void> {
    for (const peer of this.candidates(library.id, photo.id)) {
      try {
        const res = await this.transport.request(peer, `${route(photo.id, PathSegment.rendition(), rendition)}${hdr ? '?hdr=1' : ''}`);
        if (!res.ok || res.body == null) continue;
        // Bounded, not merely well shaped: it is written to a column that decides
        // staleness from here on, so a peer reporting a stamp dated centuries ahead
        // - which is a perfectly valid one - would leave this device holding a
        // rendition no edit can ever sort above, and re-advertising that stamp to
        // the next peer (§11.2). The same hour the clock allows a replicated write.
        // Anything outside it is read as no answer, which refuses the copy rather
        // than trusting it.
        const reported = res.headers.get('x-rendition-built-from');
        const senderBuiltFrom = reported != null && stampWithinSkew(this.db, reported) ? reported : null;
        if (reported != null && senderBuiltFrom == null) {
          log.warn('a peer reported a rendition built from a stamp this clock will not take', {
            photo: photo.id,
            rendition,
            peer,
            reported,
          });
        }
        // The sender refuses copies stale against the edits *it* holds; this side
        // can know an edit the sender has not replicated yet, so what it was built
        // from is checked against the local edit stamp too.
        if (!renditionCurrent(senderBuiltFrom, editedFrom)) continue;
        const expected = res.headers.get('x-content-hash');
        if (expected == null) continue;
        await this.accept(photo, library, rendition, hdr, target, res, senderBuiltFrom, expected);
        return;
      } catch (error) {
        log.warn('could not fetch a rendition from a peer', { photo: photo.id, rendition, peer, err: String(error) });
      }
    }
    throw new AppError(
      'NOT_FOUND',
      `no peer holds a current ${rendition} of ${photo.id} and there is no local original to build from`,
    );
  }

  private async accept(
    photo: BasicPhoto,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    target: string,
    res: Response,
    builtFrom: string | null,
    expected: string,
  ): Promise<void> {
    const staging = `${target}.fetching`;
    // Never resumed: a rendition is small and the sender has to be asked again
    // anyway, so an interrupted attempt is started over rather than appended to.
    await deleteGeneratedFile(getDataPath(library), staging);
    await appendToStage(staging, 0, res.body as ReadableStream<Uint8Array>);
    const computed = await contentHash(staging);
    if (computed !== expected) {
      await deleteGeneratedFile(getDataPath(library), staging);
      throw new AppError('VALIDATION_ERROR', `discarded fetched ${rendition} of ${photo.id}: bytes hash ${computed}, expected ${expected}`);
    }
    // Staged beside its target so this is one atomic replace: a reader mid-serve
    // keeps the old bytes, and a stale cached copy needs no separate delete.
    await rename(staging, target);
    this.record(photo.id, rendition, hdr, builtFrom);
    // Counted against the cap only once it is a file: this device cannot rebuild
    // any of these, so nothing but a cap decides how many it keeps (§7.9).
    await this.cache.keep(library, photo.id, rendition, hdr, target);
  }

  // The freshness stamps the pipeline itself writes, so everything downstream -
  // staleness, URL versioning, the startup sweep - reads a fetched copy exactly
  // as it reads a built one. What it was built *from* is the sender's answer,
  // which is a stamp and so means the same thing here; when it was written is
  // this device's own, which is all the URL version is for.
  //
  // Only the variant fetched is stamped, and the siblings on disk are left where
  // they are: each carries its own answer, so a stale one says so when it is asked
  // for rather than needing to have been deleted while this one landed.
  private record(photoId: string, rendition: Rendition, hdr: boolean, builtFrom: string | null): void {
    const builtAt = new Date().toISOString();
    const variant = renditionVariant(rendition, hdr);
    // No source: a fetched copy is the sender's render of a file this device may not even hold,
    // and "unknown" is the truth. What reads it wants a picture it knows is the camera's own.
    if (rendition === 'grid') this.photoProcessing.markTileBuilt(photoId, builtAt, builtFrom, null);
    else if (rendition === 'full') this.photoProcessing.markRenditionsBuilt(photoId, builtAt, 'render', builtFrom, variant);
    else this.photoProcessing.markCopyBuilt(photoId, builtAt, builtFrom, variant);
  }

  // Holders of the original first: they are the peers the catalogue records as
  // able to build, so a build is likeliest to exist there. Any other paired peer
  // may still answer from a copy it fetched through itself.
  private candidates(libraryId: string, photoId: string): string[] {
    const self = this.locations.selfId();
    const holders = new Set(this.locations.holders(libraryId, photoId));
    return pairedPeers(this.db, libraryId)
      .map((peer) => peer.peer_id)
      .filter((peer) => peer !== self)
      .sort((a, b) => Number(holders.has(b)) - Number(holders.has(a)));
  }
}
