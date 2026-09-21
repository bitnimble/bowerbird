import { existsSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '../../../logger';
import type { Library } from '../../../schemas/libraries';
import { isComposite } from '../../../schemas/recipes';
import { deleteGeneratedFile } from '../../../utils/deletions';
import {
  dataPathForLibraryId,
  renditionPathFor,
} from '../../../utils/paths';
import type { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PendingPhoto, PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import type { SettingsRepository } from '../../settings/settings_repository';
import type {
  CompositeJobSource,
  ProcessingResult,
  RenditionJob,
  RenditionSource,
} from '../workers/processing_types';
import type { ProcessingStage } from '../../../schemas/common';
import type { Made } from '../renditions/renditions_repository';
import {
  owedOf,
  RENDITION_EXTENSION,
  renditionVariant,
  renditionVariants,
  sourceFor,
} from '../renditions/renditions';
import { readStages, withStagesOff } from '../renditions/render_stages';
import { runProcessingPool } from '../workers/processing_pool';
import { developed } from './developed';
import { RenderService } from './render_service';

const log = new Logger('processing');

// Orchestrates rendition generation across a pool of Bun workers (DESIGN §10.2).
// Workers decode + encode; the main thread owns all DB writes so the catalogue is
// only ever touched from one thread.
/** One photo's import, as the two passes a batch runs it in. */
interface StagedPhoto {
  photoId: string;
  rawFilePath: string;
  dataPath: string;
  /** The grid tile, from the fastest source there is. Null once it has been built. */
  tile: RenditionJob | null;
  /** The photo viewer's renditions. Null when the library serves the camera's JPEG. */
  renditions: RenditionJob | null;
  /**
   * Whether the viewer's side of this photo is this run's business at all. False
   * for a tile rebuild asked for on its own, which must neither stamp
   * `rendition_source` nor sweep the renditions it was never going to write.
   */
  owesRenditions: boolean;
  /** The develop settings these jobs render, as the stamp to record them under. */
  builtFrom: string | null;
}

/** Which photos a batch is for: a whole library, a named set, or everything. */
export interface ProcessingScope {
  libraryId?: string;
  /** Only these, rather than everything the library still owes work on. */
  photoIds?: readonly string[];
}

export class ProcessingService extends RenderService {
  // Per-key in-flight batch. A concurrent call returns the SAME promise (so an
  // awaiter genuinely waits for completion) and widens `queued` so work asked for
  // during the batch is drained before the promise resolves.
  private readonly inFlight = new Map<string, Promise<void>>();
  // What the next pass of each key's batch covers: a set of photo ids, or null
  // for everything pending. Absent means nothing more to do, which is how the
  // drain loop knows to stop.
  private readonly queued = new Map<string, Set<string> | null>();

  constructor(
    photoProcessing: PhotoProcessingRepository,
    photoPaths: PhotoPathsRepository,
    photoListing: PhotoListingRepository,
    settings: SettingsRepository,
    /**
     * One photo's stored develop settings as JSON, and the stamp saying which
     * settings those are; null where it has none.
     *
     * A function rather than the repository, and defaulted rather than required, matching the
     * seam `PhotoRenditionService.extract` uses: the batch path reads these off the pending query's
     * own join, so this exists only for the one-off renditions a viewer asks for. A test that
     * is not about edits gets the default and renders the photo as the camera metered it,
     * which is what every one of them was already asserting.
     */
    editsFor: (photoId: string) => { doc: string; stamp: string | null } | null = () => null,
    /**
     * What the queue needs to compose a panorama: the library it is in, and the recipe with its
     * frames resolved to files.
     *
     * Functions rather than the repositories, for `editsFor`'s reason and one of its own: the
     * service that answers the second is `CompositesService`, which is built on this one, so
     * holding it here would be a cycle. Defaulted, so a test that is not about composites gets a
     * queue that finds none.
     */
    libraryOf: (libraryId: string) => Library | null = () => null,
    compositeOf: (
      photoId: string,
    ) => { kind: 'panorama' | 'assembly'; recipe: unknown; sources: CompositeJobSource[] } | null = () => null,
  ) {
    super(photoProcessing, photoPaths, photoListing, settings, editsFor, libraryOf, compositeOf);
  }

  // Rebuilds the grid tile of specific photos, from the camera's JPEG an import
  // builds it from. Returns how many were queued; ids that are missing or binned
  // have no file to read.
  async rebuildTiles(photoIds: string[]): Promise<number> {
    const queued = this.photoProcessing.queueTileRebuild(photoIds);
    // Scoped to what was asked for: the caller is awaiting this, and a library
    // with a backlog would otherwise make a three-photo rebuild wait it out.
    if (queued > 0) await this.processUnprocessed({ photoIds });
    return queued;
  }

  /**
   * Both derived stages of photos whose develop settings are newer than their renders,
   * and a drain to follow. Every photo that qualifies where `photoIds` is omitted.
   *
   * **Called when an editor closes, not when it saves.** A save happens on every slider
   * release, and there is no way to know from one whether the reader is finished or two
   * seconds into an hour: rendering then spends ~1.7s of GPU at 61MP on a frame they are
   * about to change again, over and over, and throws all of it away. Nothing about the
   * intermediate states is worth building.
   *
   * Not awaited: a 61MP render is seconds of work and the caller is a page navigation.
   * What makes that correct rather than fire-and-hope is that the flags are on the row
   * first, so a drain that never ran - or a process that died mid-render - leaves the
   * work queued for the next one. And the predicate is a *state*, not an event, so the
   * sweep at startup finds anything whose editor never got to say it had closed.
   */
  rebuildEdited(photoIds?: readonly string[]): number {
    const queued = this.photoProcessing.queueEditedSince(photoIds);
    // Reported rather than thrown past: nothing is awaiting this, so an unhandled
    // rejection is all a failure would otherwise produce.
    if (queued > 0) {
      void this.processUnprocessed({ photoIds: photoIds == null ? undefined : [...photoIds] }).catch(
        (err: unknown) => log.warn('could not rebuild after an edit', { photos: queued, err }),
      );
    }
    return queued;
  }

  // `stopped` ends the batch between jobs (a sync the user stopped, §9.10). What is
  // already on disk stays - a tile is valid whether or not the rest of the run
  // finished - and everything unreached keeps its flags for the next sync.
  //
  // A predicate rather than an `AbortSignal`, because a batch outlives the sync
  // that started it: a later sync of the same library coalesces into this one and
  // its signal is dropped on the floor by the dedup below, so a stop aimed at that
  // newer run would never reach the batch actually doing its work. Asked each time
  // instead, the caller answers for whichever run is current.
  processUnprocessed(scope: ProcessingScope = {}, stopped?: () => boolean): Promise<void> {
    const key = scope.libraryId ?? '*';
    this.widen(key, scope.photoIds);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    return this.start(scope.libraryId, key, stopped);
  }

  // `drain` is async, so its return resolves a promise and the cleanup below runs
  // a microtask later. A call landing in that gap finds this key still in flight,
  // is handed a batch that has already settled, and leaves what it asked for in
  // `queued` with nothing running to take it. So the same check that ends a batch
  // is made again after it is out of the map, and starts the next one.
  private start(libraryId: string | undefined, key: string, stopped?: () => boolean): Promise<void> {
    const run = this.drain(libraryId, key, stopped).finally(() => {
      this.inFlight.delete(key);
      // Not while stopped: `drain` returns without consuming `queued` in that
      // case, so relaunching on it would spin.
      if (stopped?.() !== true && this.queued.has(key)) void this.start(libraryId, key, stopped);
    });
    // Before any `.finally` callback can run, since those are microtasks and this
    // is not - so the key is never deleted before it is set.
    this.inFlight.set(key, run);
    return run;
  }

  // Absorbing, so a request that covers more than the running batch always wins:
  // a full sync joining a batch a scoped one started must not come away having
  // processed only that scoped run's handful of files.
  private widen(key: string, photoIds?: readonly string[]): void {
    if (photoIds == null) {
      this.queued.set(key, null);
      return;
    }
    const current = this.queued.get(key);
    if (current === null) return; // already everything
    const set = current ?? new Set<string>();
    for (const id of photoIds) set.add(id);
    this.queued.set(key, set);
  }

  private async drain(libraryId: string | undefined, key: string, stopped?: () => boolean): Promise<void> {
    for (;;) {
      if (stopped?.() === true) return;
      const scope = this.queued.get(key);
      this.queued.delete(key);
      if (scope === undefined) return; // nothing asked for since the last pass
      const pending = this.photoProcessing.listPendingProcessing(libraryId, scope == null ? undefined : [...scope]);
      // Composites are composed rather than decoded, one at a time and on a worker of their own:
      // a panorama holds the device for the whole of a canvas, so putting one in the pool beside
      // the tiles would stall every other photograph behind it.
      await this.composePending(
        pending.filter((row) => isComposite(row.recipe)),
        stopped,
      );
      const staged = pending.map((p) => this.toStages(p)).filter((p) => p != null);
      if (staged.length === 0) continue;
      const startedAt = Date.now();
      log.info('batch start', {
        library: libraryId,
        photos: staged.length,
        tiles: staged.filter((p) => p.tile != null).length,
        renditions: staged.filter((p) => p.renditions != null).length,
        workers: Math.min(this.settings.get().processing_concurrency, staged.length),
      });
      await this.runStaged(staged, stopped);
      log.info('batch done', {
        library: libraryId,
        photos: staged.length,
        stopped: stopped?.() === true,
        ms: Date.now() - startedAt,
      });
    }
  }

  /**
   * The composites a batch found owed, built one at a time.
   *
   * **This is what makes a panorama an ordinary photograph.** It is queued by the same trigger,
   * found by the same pending query and rebuilt by the same rules as anything else - a settings
   * change, an HDR toggle, a missing file, a whole-library rebuild - where before it was built
   * once at the merge and nothing could ever rebuild it.
   *
   * A frame that has gone leaves the row owing its copies rather than failing it: the recipe is
   * still true, the picture simply cannot be made here and now, and the alternative is a
   * photograph marked failed for something that may come back on the next sync.
   */
  private async composePending(pending: readonly PendingPhoto[], stopped?: () => boolean): Promise<void> {
    for (const row of pending) {
      if (stopped?.() === true) return;
      const library = this.libraryOf(row.library_id);
      const composite = this.compositeOf(row.photo_id);
      if (library == null || composite == null) {
        log.debug('a composite is owed copies nothing here can make yet', { photo: row.photo_id });
        continue;
      }
      // What any row owes and what each copy is built from, decided by the rule every recipe
      // shares (`renditions::owedOf`) rather than here: a composite is a photograph, and which
      // picture its tile comes from is not a question a panorama answers for itself.
      const wants = { grid: row.needs_tile === 1, full: row.needs_renditions === 1 };
      const owed = owedOf({
        recipe: row.recipe,
        inputs: composite.sources.map((source) => source.rawFilePath),
        // The frames' documents alone: this row's own is the framing the merge wrote (and
        // whatever the reader has done since), and that reaches the picture whichever base it was
        // composited from - so it is not what decides between the cameras' JPEGs and the RAWs.
        edited: row.inputs_edited === 1,
        photoSource: row.rendition_source,
        librarySource: row.library_rendition_source,
        hdr: row.rendition_hdr === 1,
      })
        // Only the passes this row still owes: a run interrupted between them comes back needing
        // the one it did not reach.
        .filter((want) => wants[want.rendition === 'grid' ? 'grid' : 'full']);
      const builtFrom = row.built_from;
      // A library serving the cameras' pictures owes the viewer nothing here: the canvas is
      // composited when a reader opens it. The row still has to stop asking, or every batch for
      // the life of the library picks it up to build a copy it does not owe.
      if (wants.full && !owed.some((want) => want.rendition === 'full')) {
        this.photoProcessing.markRenditionsUnowed(row.photo_id, renditionVariant('full', row.rendition_hdr === 1));
      }
      if (owed.length === 0) continue;
      const on = this.openComposite();
      try {
        for (const want of owed) {
          await this.buildCompositeRendition(
            row.photo_id,
            composite.sources,
            composite.recipe,
            composite.kind,
            library,
            want.rendition,
            want.hdr,
            want.from,
            on,
          );
          const at = new Date().toISOString();
          // A composite is never anybody's plane, so the geometry beside it is nothing's question.
          const made = { from: want.from, matched: false };
          if (want.rendition === 'grid') this.photoProcessing.markTileBuilt(row.photo_id, at, builtFrom, made);
          else {
            this.photoProcessing.markRenditionsBuilt(
              row.photo_id,
              at,
              want.from,
              builtFrom,
              renditionVariant('full', want.hdr),
            );
          }
        }
      } catch (err) {
        log.error('could not compose a panorama; it stays owed', { photo: row.photo_id, err });
      } finally {
        on.close();
      }
    }
  }

  // Every grid tile first, then every rendition.
  //
  // Both passes cover the same photos, so this is purely an ordering choice, and it
  // is the whole point of splitting them: a tile is ~18ms against ~1.5s for a
  // render, so a shoot's grid is browsable in seconds instead of after the
  // renders finish. Each pass clears its own flag as it lands, so a run interrupted
  // between them resumes at the second rather than repeating the first.
  private async runStaged(staged: StagedPhoto[], stopped?: () => boolean): Promise<void> {
    const byId = new Map(staged.map((photo) => [photo.photoId, photo]));
    // A photo whose tile failed is not carried into the second pass: the failure is
    // the file, not the stage, so a render would fail the same way.
    const failed = new Set<string>();

    // **Owes the viewer nothing and has no tile to build either, so no pass will ever post a
    // job for it and nothing would clear the flag.** A library serving the camera's JPEG has no
    // renditions to build, and the tile that would otherwise have settled the row was adopted
    // from the scan (§10.4) - which leaves `needs_renditions` set on a photo with all its files
    // already on disk, re-queried by every batch for the life of the library.
    for (const photo of staged) {
      if (photo.tile == null && photo.renditions == null && photo.owesRenditions) {
        this.stageDone(photo, photo.photoId, 'renditions');
      }
    }

    await runProcessingPool(
      staged.flatMap((photo) => (photo.tile == null ? [] : [photo.tile])),
      this.settings.get().processing_concurrency,
      (result, job) => {
        const photo = byId.get(result.photoId) ?? null;
        if (!result.success) {
          failed.add(result.photoId);
          this.recordFailure(result, job, photo);
          return;
        }
        // Its own stage, said as soon as it lands: the render behind it is still
        // ~1.5s away, and a grid already on screen should fill at the tile's pace
        // rather than wait for both.
        this.stageDone(photo, result.photoId, 'tile', result.descriptor);
      },
      stopped,
    );

    const pending = staged.filter((photo) => photo.renditions != null && !failed.has(photo.photoId));
    if (pending.length === 0 || stopped?.() === true) return;

    await runProcessingPool(
      pending.map((photo) => photo.renditions as RenditionJob),
      this.settings.get().processing_concurrency,
      (result, job) => {
        const photo = byId.get(result.photoId) ?? null;
        if (!result.success) {
          this.recordFailure(result, job, photo);
          return;
        }
        this.stageDone(photo, result.photoId, 'renditions');
        // And the tile, where this job rewrote it from the render. Asked of the targets
        // rather than assumed from the pool, for the reason `runOneOff` gives: a job that
        // wrote a grid file and stamped only the renditions leaves `tile_built_at` where
        // it was, so the better tile lands on disk and no client ever asks for it.
        if (job.targets.some((target) => target.rendition === 'grid')) {
          this.stageDone(photo, result.photoId, 'tile', result.descriptor, {
            from: 'render',
            matched: job.cameraMatch !== 'none',
          });
        }
      },
      stopped,
    );
  }

  // One stage of one photo has landed: clear its flag, stamp when it was written,
  // and say so. The stamp and the announcement carry the same value, because a
  // client builds its image URLs out of that column (DESIGN 13.5) - told a version
  // the row does not have, it would be walked back by the next list read.
  //
  // Per stage rather than per photo because the two files move at different times:
  // sharing one stamp re-fetched every grid tile on the page whenever any photo's
  // renditions were rebuilt, for bytes that had not changed.
  protected stageDone(
    photo: StagedPhoto | null,
    photoId: string,
    stage: ProcessingStage,
    descriptor?: Uint8Array,
    /**
     * What the tile that just landed actually is. Stated by the caller rather than inferred,
     * because the same file is written twice by two passes: the import's tile pass takes the
     * camera's JPEG at ~18ms, and the renditions pass rewrites it from the render. Ignored for the
     * renditions stage, which does not touch the tile's row.
     */
    tile: Made = { from: 'embedded', matched: false },
  ): void {
    // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
    // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
    // batch forever. On a DB write failure, log and leave the flag set.
    try {
      const version = new Date().toISOString();
      if (stage === 'tile') {
        this.photoProcessing.markTileBuilt(photoId, version, photo?.builtFrom ?? null, tile);
        // Nothing more to build: this library serves the camera's JPEG in the
        // viewer, so the tile was the whole import. A tile rebuilt on its own owes
        // no renditions either, but there the viewer's side is already settled and
        // settling it again would sweep the copies it holds.
        if (photo != null && photo.renditions == null && photo.owesRenditions) this.finishRenditions(photo, photoId, version);
      } else {
        this.finishRenditions(photo, photoId, version);
      }
      // After the writes, so a client told the file is ready cannot ask for it
      // before the row says so.
      this.announce(photoId, { stage, version });
      // Handed over as it arrives, still inside the try above: a descriptor that
      // fails to store is a photo that will not stack, which is not worth losing
      // the rendition over.
      if (descriptor != null) for (const listener of this.described) listener(photoId, descriptor);
      log.debug('stage done', { photo: photoId, stage });
    } catch (err) {
      log.error('could not record a finished stage', { photo: photoId, stage, err });
    }
  }

  // The viewer's side is settled - either its renditions were built, or this
  // library has none to build - so the column recording what the viewer gets can
  // be written, and the renditions this import did not rewrite swept.
  private finishRenditions(photo: StagedPhoto | null, photoId: string, version: string): void {
    // What the photo viewer will be served, which is the only thing this column is
    // read back for. Not the tile's own source: the tile is always the embedded
    // JPEG whatever the library says, so recording that would tell the next import
    // there are no renditions to build - and `dropStaleRenditions` would then
    // delete the ones there are, with nothing to ever rebuild them.
    const source: RenditionSource = photo == null || photo.renditions != null ? 'render' : 'embedded';
    // Which range this job's `full` was written in, and so which variant is vouched
    // for. A library serving the camera's JPEG builds no `full` at all and records the
    // SDR key against a null stamp, which reads exactly as the absent key it is.
    const full = photo?.renditions?.targets.find((target) => target.rendition === 'full');
    // The caller's version, which is the one it announces: a stamp minted here lands
    // milliseconds later than the announced one, and a client that built its URL off
    // the push refetches the same bytes at the next list read.
    this.photoProcessing.markRenditionsBuilt(
      photoId,
      version,
      source,
      photo?.builtFrom ?? null,
      renditionVariant('full', full?.hdr ?? false),
    );
    if (photo != null) this.dropStaleRenditions(photo);
  }


  // A photo is only reprocessed because its pixels changed: the sync saw a new
  // stat, or the user asked for a rebuild. Every derived copy is then of the old
  // file, and the ones this job does not itself rewrite - the other dynamic
  // range, the max-resolution export - would be served forever with nothing to
  // notice. Cheaper to clear the lot and let them be rebuilt on request.
  private dropStaleRenditions(photo: StagedPhoto): void {
    // Both stages' outputs, not one stage's: sweeping after the tile alone would
    // delete the very renditions the second stage is about to write.
    const targets = [...(photo.tile?.targets ?? []), ...(photo.renditions?.targets ?? [])];
    this.sweepRenditions(
      photo,
      new Set([
        // The grid tile always survives, even when this run is not writing one. A
        // run resumed at its second pass owes the renditions alone, and the tile
        // its first pass wrote is of the same file: sweeping it leaves the grid
        // blank with `needs_tile` already clear, so nothing ever rebuilds it.
        renditionPathFor(photo.dataPath, photo.photoId, 'grid', false),
        ...targets.map((t) => t.outputPath),
      ]),
    );
  }

  /** Deletes every rendition of `photo` except the ones named in `keep`. */
  private sweepRenditions(photo: StagedPhoto, keep: Set<string>): void {
    for (const variant of renditionVariants()) {
      const file = path.join(photo.dataPath, 'renditions', variant, `${photo.photoId}${RENDITION_EXTENSION}`);
      if (keep.has(file)) continue;
      void deleteGeneratedFile(photo.dataPath, file).catch(() => {});
    }
  }

  // One photo's import, split into the two stages it is worth running separately.
  //
  // The grid tile is always the camera's embedded JPEG, which is what makes the
  // split pay: it is ~18ms where a render is ~1.5s, so doing every tile first
  // fills the whole grid of a 2000-frame shoot in about ten seconds rather than the
  // eleven minutes the renders take. A body that embeds no JPEG falls back to a render
  // inside the worker, so this is "the fastest source there is" rather than
  // "always the JPEG".
  //
  // The renditions are the photo viewer's, and only exist when the library renders
  // for it: a library set to the camera's JPEG serves that JPEG directly, so there
  // is nothing to build (§10.2).
  private toStages(pending: PendingPhoto): StagedPhoto | null {
    // Everything below decodes one file. A row composed out of others is owed its copies just
    // the same and stays flagged for them, but what builds one is the composite's own job rather
    // than a decode of a path this row does not have.
    if (pending.recipe.kind !== 'file') {
      log.debug('the queue cannot compose this row yet; left pending', {
        photo: pending.photo_id,
        recipe: pending.recipe.kind,
      });
      return null;
    }
    const dataPath = dataPathForLibraryId(pending.library_id);
    // The same rule a composite's copies are decided by, over this row's one input: which picture
    // a rendition is built from is a question about a recipe, and `renditions::sourceFor` is where
    // it is answered. Only the photos actually edited render, so a library of ten thousand keeps
    // its 18ms tiles and the handful someone worked on cost ~1.7s each.
    const source = sourceFor({
      recipe: pending.recipe,
      inputs: [pending.recipe.path],
      edited: pending.edits != null,
      photoSource: pending.rendition_source,
      librarySource: pending.library_rendition_source,
      hdr: pending.rendition_hdr === 1,
    });
    const photoId = pending.photo_id;
    const rawFilePath = path.join(pending.root_path, pending.recipe.path);
    // The `full` skips, for both jobs below: the grid tile the renditions pass writes is a downscale
    // of that job's own frame, so it is built with whatever the frame was, and the tile pass that
    // precedes it lifts the camera's own JPEG and runs no stage this could turn off.
    const common = withStagesOff(
      {
        kind: 'rendition' as const,
        photoId,
        rawFilePath,
        dataPath,
        grade: this.targets.grade(),
        cameraMatch: this.settings.get().match_embedded_jpeg ? 'lensAndColour' : 'none',
        ...developed(pending.edits),
        ...this.targets.render(),
      },
      readStages(pending.render_skip_full),
    );

    // Only the passes this photo still owes. A run interrupted between them - a
    // crash, a restart, a library that went away and came back - resumes at the
    // one it did not reach rather than redoing a tile already on disk.
    const owesRenditions = pending.needs_renditions === 1;
    const tile: RenditionJob | null =
      pending.needs_tile === 1
        ? { ...common, targets: [this.targets.target(dataPath, photoId, 'grid', false, 'embedded')] }
        : null;
    // The renditions job writes the grid tile a second time, from the render.
    //
    // The first pass takes the tile off the camera's embedded JPEG because that is
    // ~18ms against ~1.5s, and it is what fills a 2000-frame shoot's grid in ten seconds
    // rather than eleven minutes. But a library set to `render` then showed a gallery of the
    // camera's rendering beside a viewer showing ours, and once a photo can be *edited*
    // the two disagree about the picture itself rather than only its treatment.
    //
    // Free, within noise: the base is decoded, fitted, filtered and cut once for the
    // whole job, so the tile is a downscale of pixels already in hand and an 800px
    // encode - measured at 3940ms for grid+full against 4139ms for the full alone on a
    // 61MP body. The grid upgrades in place as the queue reaches each photo, and
    // `tile_built_at` moving is what makes a client re-fetch it.
    const renditions: RenditionJob | null =
      source === 'render' && owesRenditions
        ? {
            ...common,
            targets: [
              this.targets.target(dataPath, photoId, 'full', pending.rendition_hdr === 1, 'render'),
              this.targets.target(dataPath, photoId, 'grid', false, 'render'),
            ],
          }
        : null;

    return { photoId, rawFilePath, dataPath, tile, renditions, owesRenditions, builtFrom: pending.edits_stamp };
  }

  private recordFailure(
    result: Extract<ProcessingResult, { success: false }>,
    job: RenditionJob,
    photo: StagedPhoto | null,
  ): void {
    // Never throw: this runs inside a worker's onmessage/onerror, and a throw here
    // would skip the pool's assignNext/terminate/live-- bookkeeping and hang the
    // batch forever. On a DB write failure, log and leave the flags set.
    try {
      // If the source file moved/was deleted since the job was queued (a move that
      // landed before the worker ran), don't burn it as a terminal failure: leave
      // its flags set so a later sync reprocesses it at its current path.
      if (!existsSync(job.rawFilePath)) {
        log.debug('job source vanished, left pending', { photo: result.photoId, file: job.rawFilePath });
        return;
      }
      log.warn('photo failed', { photo: result.photoId, file: job.rawFilePath, err: result.error });
      this.photoProcessing.markProcessingFailed(result.photoId, result.error);
      // Every derivative, not just the stage that failed. A photo is being
      // reprocessed because its pixels changed, so the ones this run did not reach -
      // the renditions, when it was the tile that crashed - are of the old file and
      // would be served forever with nothing to notice. Except when the run owed
      // the tile alone: nothing said the pixels changed, so the viewer's copies are
      // still of the file it has.
      if (photo != null && photo.owesRenditions) this.sweepRenditions(photo, new Set());
    } catch (err) {
      log.error('could not record a failure', { photo: result.photoId, err });
    }
  }

}
