import type { Database } from '../../db/driver';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import { newId } from '../../schemas/id';
import type { LibraryConfiguration as Library } from '../../schemas/libraries';
import { PathSegment, route } from '../../schemas/route';
import { stampWithinSkew } from '../replication/stamps';
import { deleteGeneratedFile } from '../../utils/deletions';
import { getDataPath, getRenditionPath, originalPathOf } from '../../utils/paths';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../photos/renditions/photo_processing_repository';
import { renditionVariant, storedAsHdr, type Rendition } from '../processing/renditions/renditions';
import { pairedPeers, syncsOriginals } from '../replication/pairing';
import { replicates } from '../replication/tombstones';
import type { BlobLocations } from './blob_locations';
import { contentHash } from '../../utils/hash';
import { appendToStage, isOnDisk } from './blob_store';
import { RenditionCache } from './rendition_cache';
import type { PeerTransport } from './peer';
import type { RenditionWritten } from '../processing/workers/processing_types';
import { BlobRenditionStatusSchema } from '../../schemas/blobs';
import type { RenditionFetchPhase } from '../../schemas/events';
import { LibraryActivity } from '../activity/library_activity';

// Renditions from a peer (docs/replication.md §7.9): a device holding the
// catalogue but not the original serves tiles and renditions anyway, by fetching
// the copy a peer renders and caching it as an ordinary rendition file.

const log = new Logger('blobs');

// The holder renders before it answers, and a `max` on a software Vulkan driver takes minutes.
const RENDER_ON_PEER_MS = 10 * 60_000;

/** The devices a request for a rendition has passed through, comma-separated peer ids. */
export const VIA_HEADER = 'x-bowerbird-via';

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
    /** Told of a fetched copy that replaced one already served, so a client's URL for it moves. */
    private readonly announce: (photoId: string, written: RenditionWritten) => void = () => {},
    /** Told what a fetch is waiting on while it waits, and null once it has settled. */
    private readonly announcePhase: (photoId: string, rendition: Rendition, phase: RenditionFetchPhase | null) => void = () => {},
    private readonly cache: RenditionCache = new RenditionCache(db),
    private readonly activity = new LibraryActivity(),
  ) {}

  /**
   * The fall-back order, in one place (§7.9): a current local rendition is kept;
   * failing that, a peer's rendition is fetched and cached; fetching the
   * whole original to build locally is **never** done here - that is the
   * explicit §7.5 action, and walking a device into it over a missing tile is
   * exactly the accident the order exists to rule out. No peer able to answer is
   * a NOT_FOUND, unless a stale cached copy can stand in.
   *
   * `force` has the holder render its copy again and takes it whatever is cached here.
   */
  async ensureCurrent(photoId: string, rendition: Rendition, force = false): Promise<void> {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) return;
    const library = this.libraries.getConfiguration(photo.library_id);
    if (library == null) return;
    // The local pipeline owns every photo whose original is here: it builds on request, rebuilds
    // on edit and sweeps what it rebuilt. A fetched copy would fight it, and a locally built
    // rendition is preferred anyway.
    if (this.originalHere(library, photo)) return;
    // ponytail: a composed row on a library that keeps its originals is treated as the local
    // pipeline's whatever this device holds. It is right only while every source is here - the
    // check that says so wants the sources on the row, so it lands with them.
    if (originalPathOf(library, photo) == null && syncsOriginals(this.db, library.id)) return;

    const hdr = storedAsHdr(rendition, library.rendition_hdr);
    if (!replicates(this.db, library.id)) {
      if (!force && existsSync(getRenditionPath(library, photo.id, rendition, hdr))) return;
      throw new AppError(
        'NOT_FOUND',
        `This photo's original is missing. Restore it to "${originalPathOf(library, photo)}" and scan the library again.`,
      );
    }

    const key = `${photoId}:${rendition}:${force}`;
    const running = this.fetching.get(key);
    if (running != null) return running;
    let reported = false;
    // A grid scroll fetches tiles by the hundred, and nothing draws a tile's wait.
    const report =
      rendition === 'grid' ? undefined : (phase: RenditionFetchPhase): void => {
        reported = true;
        this.announcePhase(photoId, rendition, phase);
      };
    const run = this.fetchIfStale(photo, library, rendition, hdr, force, report).finally(() => {
      this.fetching.delete(key);
      if (reported) this.announcePhase(photoId, rendition, null);
    });
    this.fetching.set(key, run);
    return run;
  }

  /**
   * Passes on a peer's request for a copy this device cannot build, caching what comes back (§7.9).
   *
   * `via` is every device the request has already passed through, none of which is asked again,
   * so a chain ends at a device with the original or one with nobody left to ask. Never joined
   * onto another fetch: one of this device's own may be waiting on the device that is asking.
   * Settles either way, the caller serving what is cached if it is current, except where `force`
   * could not be passed on, which throws.
   */
  async relay(photoId: string, rendition: Rendition, hdr: boolean, via: readonly string[], force = false): Promise<void> {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) return;
    const library = this.libraries.getConfiguration(photo.library_id);
    if (library == null) return;
    const target = getRenditionPath(library, photo.id, rendition, hdr);
    const stamps = this.photoProcessing.renditionStamps(photo.id, renditionVariant(rendition, hdr));
    const editedFrom = stamps?.edited_from ?? null;
    if (!force && existsSync(target) && renditionCurrent(stamps?.built_from ?? null, editedFrom)) {
      this.cache.touch(library.id, photo.id, rendition, hdr);
      return;
    }
    try {
      await this.fetch(photo, library, rendition, hdr, target, editedFrom, force, via);
    } catch (error) {
      log.warn('could not pass a peer’s request on', { photo: photo.id, rendition, via, err: String(error) });
      if (force) throw error;
    }
  }

  /**
   * Whether this photo's pictures come from a peer however they are asked for (§7.10): on a
   * device set not to keep its originals, until one is fetched here by hand.
   */
  takesFromPeer(library: Library, photo: BasicPhoto): boolean {
    return !syncsOriginals(this.db, library.id) && !this.originalHere(library, photo);
  }

  private originalHere(library: Library, photo: BasicPhoto): boolean {
    const original = originalPathOf(library, photo);
    return original != null && isOnDisk(original);
  }

  private async fetchIfStale(
    photo: BasicPhoto,
    library: Library,
    rendition: Rendition,
    hdr: boolean,
    force: boolean,
    report?: (phase: RenditionFetchPhase) => void,
  ): Promise<void> {
    const target = getRenditionPath(library, photo.id, rendition, hdr);
    const stamps = this.photoProcessing.renditionStamps(photo.id, renditionVariant(rendition, hdr));
    const builtFrom = stamps?.built_from ?? null;
    const editedFrom = stamps?.edited_from ?? null;
    const cached = existsSync(target);
    if (!force && cached && renditionCurrent(builtFrom, editedFrom)) {
      // Served from the cache, which is what "recently used" means for one.
      this.cache.touch(library.id, photo.id, rendition, hdr);
      return;
    }

    try {
      await this.fetch(photo, library, rendition, hdr, target, editedFrom, force, [], report);
    } catch (error) {
      // Kept, the old copy would answer a rebuild the reader asked for as though it had happened.
      if (force) throw error;
      // On a device that cannot rebuild, the stale picture beats a hole; the
      // next request asks again. A peer's copy from before an edit that has not
      // reached it yet - which is every edit made here while the two cannot sync
      // (§8.5) - is that stale picture when nothing is cached, and is recorded at
      // what it was built from, so it still reads as owed.
      if (!cached) {
        await this.fetch(photo, library, rendition, hdr, target, null, force, [], report);
        return;
      }
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
    force: boolean,
    via: readonly string[] = [],
    report?: (phase: RenditionFetchPhase) => void,
  ): Promise<void> {
    const finish = this.activity.begin(library.id, 'fetching', photo.id);
    try {
      const passedThrough = [...via, this.locations.selfId()];
      const query = new URLSearchParams({ ...(hdr ? { hdr: '1' } : {}), ...(force ? { force: '1' } : {}) }).toString();
      for (const peer of this.candidates(library.id, photo.id, passedThrough)) {
        try {
          if (report != null) report(force ? 'rendering' : await this.phaseAt(peer, photo.id, rendition, hdr));
          const res = await this.transport.request(
            peer,
            `${route(photo.id, PathSegment.rendition(), rendition)}${query === '' ? '' : `?${query}`}`,
            { headers: { [VIA_HEADER]: passedThrough.join(',') } },
            RENDER_ON_PEER_MS,
          );
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
    } finally {
      finish();
    }
  }

  private async phaseAt(peer: string, photoId: string, rendition: Rendition, hdr: boolean): Promise<RenditionFetchPhase> {
    // The camera's JPEG is lifted out of the RAW as it is asked for, which is no render.
    if (rendition === 'embedded') return 'fetching';
    try {
      const res = await this.transport.request(
        peer,
        `${route(photoId, PathSegment.rendition(), rendition, PathSegment.status())}${hdr ? '?hdr=1' : ''}`,
      );
      if (!res.ok) return 'fetching';
      return BlobRenditionStatusSchema.parse(await res.json()).current ? 'fetching' : 'rendering';
    } catch {
      return 'fetching';
    }
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
    // One per fetch: a request passed on for a peer joins no other fetch, so two can land on one
    // target at once, and a shared staging file would interleave their bytes.
    const staging = `${target}.${newId()}.fetching`;
    // Never resumed: a rendition is small and the sender has to be asked again
    // anyway, so an interrupted attempt is started over rather than appended to.
    try {
      await appendToStage(staging, 0, res.body as ReadableStream<Uint8Array>);
      const computed = await contentHash(staging);
      if (computed !== expected) {
        throw new AppError('VALIDATION_ERROR', `discarded fetched ${rendition} of ${photo.id}: bytes hash ${computed}, expected ${expected}`);
      }
    } catch (error) {
      await deleteGeneratedFile(getDataPath(library), staging);
      throw error;
    }
    const replaced = existsSync(target);
    // Staged beside its target so this is one atomic replace: a reader mid-serve
    // keeps the old bytes, and a stale cached copy needs no separate delete.
    await rename(staging, target);
    const builtAt = this.record(photo.id, rendition, hdr, builtFrom);
    // A first copy is already on its way to whoever asked for it; announced, every tile scrolled
    // past would be fetched twice.
    if (replaced) this.announce(photo.id, { stage: rendition === 'grid' ? 'tile' : 'renditions', version: builtAt });
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
  private record(photoId: string, rendition: Rendition, hdr: boolean, builtFrom: string | null): string {
    const builtAt = new Date().toISOString();
    const variant = renditionVariant(rendition, hdr);
    // No source: a fetched copy is the sender's render of a file this device may not even hold,
    // and "unknown" is the truth. What reads it wants a picture it knows is the camera's own.
    if (rendition === 'grid') this.photoProcessing.markTileBuilt(photoId, builtAt, builtFrom, null);
    else if (rendition === 'full') this.photoProcessing.markRenditionsBuilt(photoId, builtAt, 'render', builtFrom, variant);
    else this.photoProcessing.markCopyBuilt(photoId, builtAt, builtFrom, variant);
    return builtAt;
  }

  // Holders of the original first: they are the peers the catalogue records as
  // able to build, so a build is likeliest to exist there. Any other paired peer
  // may still answer, from a copy it has or by passing the request on.
  private candidates(libraryId: string, photoId: string, passedThrough: readonly string[]): string[] {
    const holders = new Set(this.locations.holders(libraryId, photoId));
    return pairedPeers(this.db, libraryId)
      .map((peer) => peer.peer_id)
      .filter((peer) => !passedThrough.includes(peer) && this.transport.canReach(peer))
      .sort((a, b) => Number(holders.has(b)) - Number(holders.has(a)));
  }
}
