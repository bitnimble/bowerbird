import { action, comparer, reaction, runInAction } from 'mobx';
import { DEFAULT_FEATHER, type Seams } from '../../../../../src/schemas/assembly';
import { type AssemblyRecipe } from '../../../../../src/schemas/assembly';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { compositesApi } from '../../../api/composites';
import { photosApi } from '../../../api/photos';
import type { ToastsPresenter } from '../../toasts/toasts_presenter';
import type { DrawnLayer } from './merge_layers';
import { MergePageStrings } from './merge_page.strings';
import { MergePresenterStrings } from './merge_presenter.strings';
import { clearMergeSession, loadMergeSession, saveMergeSession, type StoredMergeSession } from './merge_storage';
import { boundsOf, seedAround, type Point } from './merge_rect';
import { seamsKey, takesOf, type MergeStore, type Solved } from './merge_store';
import { decodeFrame, keepOnly, releaseHolder } from '../viewer/stage_bitmaps';
import { featherWithin, pauseMergePoll, withSeed, withoutLastTile } from './merge_recipe';

const LAYER_HOLDER = 'merge';
/** The settled preview, held apart from the layers so that dropping it keeps none of them. */
export const PREVIEW_HOLDER = 'merge-preview';

/** Solves held for this visit, the oldest dropped past it. */
const KEPT_SOLVES = 64;

/**
 * What the presenter drives rather than draws through directly, so the picking logic below is
 * testable without a GPU: `merge_stage.ts` is the only real implementation, and every test hands
 * the presenter a recording fake instead.
 */
export interface Compositor {
  draw(base: number, layers: DrawnLayer[]): void;
  /** The server's render of the picks as they stand, over the masked draw of the same picks. */
  drawSettled(url: string): void;
}

/**
 * How long a drawing has to stand still before its render is asked for.
 *
 * A render is most of a second (§4.2), so every intermediate pick of a reader stepping through the
 * swatches would be one held behind the last - and the one they settle on is the only one anybody
 * waits to see.
 */
export const SETTLES_AFTER_MS = 400;

export class MergePresenter {
  private controller: AbortController | null = null;
  /** The analysis job or the reopened photograph, which is what the reader's picks are saved under. */
  private sessionKey = '';
  /** The analysis job this page shows, if it shows one. */
  private jobId: string | null = null;
  /** Whole `picks` arrays either side of where the reader is, newest last. */
  private readonly past: number[][] = [];
  private readonly future: number[][] = [];
  /** The seam solves in flight, by `seamsKey`. */
  private seaming: { keys: string[]; controller: AbortController } | null = null;
  /** The wait before the drawing on the canvas is asked for as a render, and that request. */
  private settling: ReturnType<typeof setTimeout> | null = null;
  private previewing: AbortController | null = null;
  /** The tile the last click seeded, dropped again if its popup closes with nothing picked. */
  private freshSeed: number | null = null;

  /**
   * Draws, solves and saves as the store moves, for as long as the store lives: `finish` runs on
   * every unmount, including the ones a remount of the same page follows.
   */
  constructor(
    private readonly store: MergeStore,
    private readonly toasts: ToastsPresenter,
    private readonly compositor: Compositor,
    private readonly previewAssembly: typeof compositesApi.previewAssembly = compositesApi.previewAssembly,
  ) {
    reaction(
      () => store.drawing,
      ({ base, layers }) => {
        compositor.draw(base, layers);
        this.settleLater();
      },
    );
    reaction(
      () => this.wantedKeys(),
      () => {
        store.unanswered.clear();
        this.solveWanted();
      },
      { equals: comparer.structural },
    );
    reaction(
      () => this.session(),
      (session) => this.persist(session),
      { equals: comparer.structural },
    );
  }

  /** Shows an analysis job: its progress while it runs, then its tiles. Reads the job, never starts one. */
  async openJob(jobId: string): Promise<void> {
    this.sessionKey = jobId;
    this.jobId = jobId;
    runInAction(() => (this.store.status = 'analysing'));
    const controller = new AbortController();
    this.controller = controller;
    let named = false;
    try {
      for (;;) {
        const job = await compositesApi.getAssemblyJob(jobId, controller.signal);
        controller.signal.throwIfAborted();
        if (!named) {
          named = true;
          // A name nothing answers for leaves the id, which is why nothing here can fail the page.
          void this.nameFrames(job.photoIds);
        }
        if (job.status === 'analysing') {
          runInAction(() => (this.store.progress = job.fraction));
          await pauseMergePoll(JOB_POLL_MS, controller.signal);
          controller.signal.throwIfAborted();
          continue;
        }
        if (job.carved == null) throw new Error(job.error ?? MergePresenterStrings.carveStopped());
        const unaligned = job.carved.analysed.unaligned;
        runInAction(() => (this.store.unaligned = unaligned));
        await this.settleRecipe(job.carved.analysed.recipe, job.carved.layers, loadMergeSession(jobId), controller.signal);
        return;
      }
    } catch {
      if (controller.signal.aborted) return;
      runInAction(() => {
        this.store.status = 'error';
        this.store.loadError = MergePageStrings.couldNotAnalyse();
      });
    }
  }

  private async nameFrames(frameIds: string[]): Promise<void> {
    const found = await Promise.all(frameIds.map((id) => photosApi.get(id).catch(() => null)));
    runInAction(() => {
      this.store.frames = new Map(found.flatMap((photo) => (photo == null ? [] : [[photo.id, photo] as const])));
    });
  }

  async openExisting(photoId: string): Promise<void> {
    this.sessionKey = photoId;
    runInAction(() => (this.store.status = 'analysing'));
    const controller = new AbortController();
    this.controller = controller;
    let analysis: Awaited<ReturnType<typeof compositesApi.getAssembly>>;
    let frames: PhotoSummary[];
    try {
      [analysis, frames] = await Promise.all([compositesApi.getAssembly(photoId), compositesApi.listFrames(photoId)]);
    } catch {
      if (controller.signal.aborted) return;
      runInAction(() => {
        this.store.status = 'error';
        this.store.loadError = MergePageStrings.couldNotOpen();
      });
      return;
    }
    if (controller.signal.aborted) return;
    runInAction(() => {
      this.store.frames = new Map(frames.map((frame) => [frame.id, frame]));
      this.store.readOnly = analysis.missingSources.length > 0;
      this.store.missingSources = analysis.missingSources;
    });
    // A finished assembly's picks and base are the recipe's own: reopening reads the recipe, it
    // does not resume a draft.
    await this.settleRecipe(analysis.recipe, analysis.layers, null, controller.signal);
  }

  private async settleRecipe(
    recipe: AssemblyRecipe,
    served: string[],
    restore: StoredMergeSession | null,
    signal: AbortSignal,
  ): Promise<void> {
    const layerUrls = served.map(compositesApi.layerUrl);
    keepOnly(LAYER_HOLDER, layerUrls);
    // A layer that will not decode costs that source its preview, not the page: the overlay, the
    // scores and the commit all read the recipe, and `MergeStage` skips a source it has no frame
    // for.
    const decoded = await Promise.allSettled(layerUrls.map((url) => decodeFrame(url)));
    // Left while decoding: `finish` already let the layers go, and holding them again would keep
    // them past the page.
    if (signal.aborted) return;
    const seeded = (restore?.seeds ?? []).reduce<AssemblyRecipe>(
      (held, rect, seed) => withSeed(held, rect, recipe.base, restore?.takes?.[seed] ?? 'subject'),
      { ...recipe, feather: featherWithin(restore?.feather ?? recipe.feather ?? DEFAULT_FEATHER) },
    );
    // Picks saved against a different tile set describe tiles that are not these.
    const picks = restore?.picks.length === seeded.tiles.length ? restore.picks : null;
    runInAction(() => {
      this.store.recipe = seeded;
      this.store.unseamed = recipe.seamVolume == null;
      this.store.balancedFeather = this.store.feather;
      const seams = recipe.seams;
      const geometry = this.store.geometry;
      // Balanced over the feather the recipe was committed with, which a restored session may not hold.
      const committed = recipe.feather ?? DEFAULT_FEATHER;
      this.store.solved = new Map(
        seams == null ? [] : [[seamsKey(geometry, committed, seams.base, seams.pick), { seams, geometry }]],
      );
      this.store.layerUrls = layerUrls;
      this.store.picks = picks ?? [...seeded.pick];
      this.store.base = picks == null ? recipe.base : (restore?.base ?? recipe.base);
      this.store.layers = new Map(
        decoded.flatMap((result, index) => (result.status === 'fulfilled' ? [[index, result.value] as const] : [])),
      );
      const first = this.store.layers.get(0) ?? [...this.store.layers.values()][0];
      this.store.layerSize = first == null ? null : { width: first.width, height: first.height };
      this.store.status = this.store.readOnly ? 'read-only' : 'ready';
      this.store.progress = 1;
    });
    // The reaction below only fires on a change, and what a page opens showing is a pick set like
    // any other - a reopened assembly's own, or a draft's restored picks.
    this.settleLater();
  }

  /** What a reload restores: the feather only once it is let go of. */
  private session(): StoredMergeSession {
    const recipe = this.store.recipe;
    return {
      picks: [...this.store.picks],
      base: this.store.base,
      seeds: recipe == null ? [] : recipe.tiles.map((loop) => boundsOf(loop.map((v) => recipe.vertices[v]!))),
      takes: recipe == null ? [] : recipe.tiles.map((_, tile) => takesOf(recipe, tile)),
      feather: this.store.balancedFeather,
    };
  }

  private persist(session: StoredMergeSession): void {
    if (this.store.readOnly) return;
    if (!saveMergeSession(this.sessionKey, session)) this.toasts.show(MergePresenterStrings.couldNotSaveProgress());
  }

  @action.bound
  openTile(tile: number | null): void {
    if (tile !== this.freshSeed) this.dropFreshSeed();
    this.store.openTile = tile;
    // `MergeStore.drawing` substitutes the hovered source for the open tile's pick, so a preview
    // carried over from the tile just left would draw this one from a frame nobody asked about.
    this.store.hoveredSwatch = null;
  }

  /** §2.8's `[` and `]`, wrapping, so every tile is reachable without finding its outline. */
  @action.bound
  stepTile(delta: number): void {
    const tiles = this.store.recipe?.tiles.length ?? 0;
    if (tiles === 0) return;
    const from = this.store.openTile;
    this.openTile(from == null ? (delta > 0 ? 0 : tiles - 1) : (from + delta + tiles) % tiles);
  }

  /** §2.8's arrows, from whatever the open tile is currently drawn with. */
  @action.bound
  stepSwatch(delta: number): void {
    const sources = this.store.recipe?.sources.length ?? 0;
    const tile = this.store.openTile;
    if (sources === 0 || tile == null) return;
    const from = this.store.hoveredSwatch ?? this.store.picks[tile] ?? this.store.base;
    this.hoverSwatch((from + delta + sources) % sources);
  }

  @action.bound
  hoverTile(tile: number | null): void {
    this.store.hoveredTile = tile;
  }

  @action.bound
  pick(tile: number, source: number): void {
    if (tile === this.freshSeed) this.freshSeed = null;
    this.remember();
    this.store.picks = this.store.picks.map((s, t) => (t === tile ? source : s));
  }

  @action.bound
  hoverSwatch(source: number | null): void {
    this.store.hoveredSwatch = source;
  }

  /** For a page that has just handed over a different compositor: the new canvas starts empty. */
  redraw(): void {
    const { base, layers } = this.store.drawing;
    this.compositor.draw(base, layers);
  }

  @action.bound
  undo(): void {
    const previous = this.past.pop();
    if (previous == null) return;
    this.future.push([...this.store.picks]);
    this.store.picks = this.fitted(previous);
    this.settleHistory();
  }

  @action.bound
  redo(): void {
    const next = this.future.pop();
    if (next == null) return;
    this.past.push([...this.store.picks]);
    this.store.picks = this.fitted(next);
    this.settleHistory();
  }

  /**
   * A history entry sized to today's tiles. Seeds are only ever appended, or the last one dropped
   * while still on the base, so a shorter entry's missing tiles took the base and a longer one's
   * extra tile no longer exists.
   */
  private fitted(picks: number[]): number[] {
    const tiles = this.store.recipe?.tiles.length ?? 0;
    return Array.from({ length: tiles }, (_, tile) => picks[tile] ?? this.store.base);
  }

  /**
   * A click on the picture: a tile seeded there, on the base until a frame is picked for it, and
   * its swatches opened so every frame's growth of it is solved while the reader looks.
   */
  @action.bound
  seed(point: Point): void {
    if (this.store.readOnly) return;
    this.openTile(null);
    const recipe = this.store.recipe;
    if (recipe == null) return;
    const [width, height] = recipe.canvas;
    // Written so a NaN, from a stage not yet laid out, fails it too.
    if (!(point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height)) return;
    const takes = this.store.removing ? 'ground' : 'subject';
    this.store.recipe = withSeed(recipe, seedAround(point, recipe.canvas), this.store.base, takes);
    this.store.picks = [...this.store.picks, this.store.base];
    this.freshSeed = recipe.tiles.length;
    this.openTile(this.freshSeed);
  }

  /** The fresh seed, if nothing was picked for it: a click that took nothing leaves nothing. */
  private dropFreshSeed(): void {
    const tile = this.freshSeed;
    this.freshSeed = null;
    const recipe = this.store.recipe;
    if (tile == null || recipe == null || tile !== recipe.tiles.length - 1) return;
    if (this.store.picks[tile] !== this.store.base) return;
    this.store.recipe = withoutLastTile(recipe);
    this.store.picks = this.store.picks.slice(0, tile);
  }

  private settleHistory(): void {
    this.store.canUndo = this.past.length > 0;
    this.store.canRedo = this.future.length > 0;
  }

  async commit(): Promise<{ photoId: string }> {
    const result = await compositesApi.commitAssembly(this.chosen());
    clearMergeSession(this.sessionKey);
    return result;
  }

  commitExisting(photoId: string): Promise<{ photoId: string }> {
    return compositesApi.updateAssembly(photoId, this.chosen());
  }

  discard(): void {
    clearMergeSession(this.sessionKey);
  }

  /** The recipe as the reader left it: `picks` and `base` are the page's, not the analysis's. */
  private chosen(): AssemblyRecipe {
    const recipe = this.store.recipe;
    if (recipe == null) throw new Error('nothing to commit');
    return { ...recipe, pick: [...this.store.picks], base: this.store.base };
  }

  /** Whether the next click seeds a tile that takes the ground in place of what is there. */
  @action.bound
  toggleRemoving(): void {
    this.store.removing = !this.store.removing;
  }

  /** `share` of the long edge, as `AssemblyRecipe.feather`: the preview's blend follows it at once. */
  @action.bound
  setFeather(share: number): void {
    const recipe = this.store.recipe;
    if (recipe == null || this.store.readOnly) return;
    this.store.recipe = { ...recipe, feather: featherWithin(share) };
  }

  /** `setFeather`, let go of: the seams are balanced over it again and it is kept. */
  @action.bound
  settleFeather(share: number): void {
    this.setFeather(share);
    this.store.balancedFeather = this.store.feather;
  }

  @action.bound
  toggleLines(): void {
    this.store.showingLines = !this.store.showingLines;
  }

  private remember(): void {
    this.past.push([...this.store.picks]);
    this.future.length = 0;
    this.store.canUndo = true;
    this.store.canRedo = false;
  }

  /**
   * Asks, in one request, for every pick set the page wants seams for and has none of. A request
   * still answering something wanted is waited for rather than dropped.
   */
  private solveWanted(): void {
    const recipe = this.store.recipe;
    if (recipe?.seamVolume == null || this.store.readOnly || this.store.unseamed) return;
    const { base, geometry } = this.store;
    const wanted = this.wantedPicks();
    const keys = wanted.map((picks) => this.store.keyOf(picks));
    if (this.seaming != null) {
      if (this.seaming.keys.some((key) => keys.includes(key))) return;
      this.stopSolving();
    }
    const asked = new Map<string, number[]>();
    const trivial: [string, Solved][] = [];
    keys.forEach((key, at) => {
      if (this.store.solved.has(key) || this.store.unsolvable.has(key) || this.store.unanswered.has(key)) return;
      const picks = wanted[at]!;
      if (!picks.every((source) => source === base)) {
        asked.set(key, picks);
        return;
      }
      const none = {
        pick: [...picks],
        takes: recipe.takes,
        base,
        vertices: [],
        tiles: [],
        source: [],
        zone: [],
        corridor: [],
        warp: [],
        exposure: [],
      };
      trivial.push([key, { seams: none, geometry }]);
    });
    if (trivial.length > 0) {
      this.keepSolved(trivial);
      return;
    }
    if (asked.size === 0) return;
    const batch = [...asked];
    const controller = new AbortController();
    this.seaming = { keys: batch.map(([key]) => key), controller };
    const request = {
      ...recipe,
      pick: [...this.store.picks],
      base,
      feather: this.store.balancedFeather,
      seams: undefined,
    };
    compositesApi
      .solveSeams(
        request,
        batch.map(([, picks]) => picks),
        controller.signal,
      )
      .then(
        action(({ seams }: { seams: (Seams | null)[] | null }) => {
          if (this.seaming?.controller !== controller) return;
          this.seaming = null;
          if (seams == null) {
            this.store.unseamed = true;
            return;
          }
          const kept: [string, Solved][] = [];
          batch.forEach(([key], at) => {
            const answered = seams[at];
            if (answered == null) this.store.unsolvable.add(key);
            else kept.push([key, { seams: answered, geometry }]);
          });
          this.keepSolved(kept);
        }),
        action(() => {
          if (this.seaming?.controller !== controller) return;
          this.seaming = null;
          for (const [key] of batch) this.store.unanswered.add(key);
          this.toasts.show(MergePresenterStrings.couldNotFindSeams());
          this.solveWanted();
        }),
      );
  }

  /**
   * What the canvas shows, the page's own picks, and - while a tile is open - every frame that tile
   * could take, which the server solves side by side so the swatches arrive together.
   */
  private wantedPicks(): number[][] {
    const { picks, openTile, recipe } = this.store;
    const wanted = [this.store.shownPicks, picks];
    if (openTile == null) return wanted;
    for (let source = 0; source < (recipe?.sources.length ?? 0); source++) {
      wanted.push(picks.map((held, tile) => (tile === openTile ? source : held)));
    }
    return wanted;
  }

  private wantedKeys(): string[] {
    return this.wantedPicks().map((picks) => this.store.keyOf(picks));
  }

  /** Keeps solves, and asks for the next. */
  private keepSolved(kept: [string, Solved][]): void {
    const solved = this.store.solved;
    for (const [key, held] of kept) {
      solved.set(key, held);
      if (solved.size > KEPT_SOLVES) solved.delete(solved.keys().next().value!);
    }
    this.solveWanted();
  }

  private stopSolving(): void {
    this.seaming?.controller.abort();
    this.seaming = null;
  }

  /**
   * §4.2's settled preview, once the drawing has stood still: the masked draw is what the reader
   * sees until it arrives, and the render replaces it in place.
   */
  private settleLater(): void {
    this.stopSettling();
    if (this.store.recipe == null || this.store.unseamed) return;
    this.settling = setTimeout(() => void this.settle(), SETTLES_AFTER_MS);
  }

  private async settle(): Promise<void> {
    const wanted = this.settled();
    if (wanted == null) return;
    const controller = new AbortController();
    this.previewing = controller;
    try {
      const { url } = await this.previewAssembly(wanted, controller.signal);
      if (this.previewing !== controller) return;
      this.compositor.drawSettled(compositesApi.layerUrl(url));
    } catch {
      // A render nobody could build leaves the masked draw, which is a picture rather than an
      // error: the reader is choosing frames, not waiting on this.
    } finally {
      if (this.previewing === controller) this.previewing = null;
    }
  }

  /** The recipe to render, carrying the seams the page has already solved for these picks. */
  private settled(): AssemblyRecipe | null {
    const recipe = this.store.recipe;
    if (recipe == null) return null;
    const held = this.store.drawnSeams;
    const picks = this.store.shownPicks;
    const own =
      held?.geometry === this.store.geometry &&
      held.seams.base === this.store.base &&
      held.seams.pick.every((source, tile) => source === picks[tile]);
    return {
      ...recipe,
      pick: [...picks],
      base: this.store.base,
      feather: this.store.balancedFeather,
      seams: own ? held.seams : undefined,
    };
  }

  private stopSettling(): void {
    if (this.settling != null) clearTimeout(this.settling);
    this.settling = null;
    this.previewing?.abort();
    this.previewing = null;
  }

  /** §3.9's cancel: the carve lets go of the device at its next boundary, and the page stops waiting. */
  @action.bound
  cancel(): void {
    if (this.store.status !== 'analysing') return;
    this.controller?.abort();
    this.store.status = 'error';
    this.store.loadError = null;
    if (this.jobId != null) void compositesApi.cancelAssembly(this.jobId).catch(() => undefined);
  }

  /** Leaving the page, which stops watching the job but leaves it to finish. */
  @action.bound
  finish(): void {
    this.controller?.abort();
    this.stopSolving();
    this.stopSettling();
    releaseHolder(LAYER_HOLDER);
  }
}

/** How often an analysing job is read for its progress. */
export const JOB_POLL_MS = 250;
