import { action } from 'mobx';
import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import { describe } from '../../../errors';
import { STORED_LONG, storedLoop, storedSize, type Repair } from '../../../../../src/schemas/stored_grid';
import { readSetting, writeSetting } from '../../../app/local_setting';
import { RawEditPanelStrings } from '../raw_edit_panel.strings';
import type { LocalDecoder } from '../local_decode/local_decoder';
import type { EditGeometry, Region } from '../edits';
import type { EditStore } from '../edit/edit_store';
import type { KeystoneStore } from '../keystone/keystone_store';
import type { StageStore } from '../stage/stage_store';
import type { RepairStore, RepairThumbnail } from './repair_store';

const REPAIR_OUTLINES_KEY = 'bowerbird.edit.repairOutlines';

const REPAIR_GROWS_KEY = 'bowerbird.edit.repairGrows';

/** A repair thumbnail's least side in device pixels: twice the CSS box it is shown in. */
const REPAIR_THUMBNAIL_SIDE = 96;

/** And its most, past which a PNG is only bytes the row's box cannot show. */
const REPAIR_THUMBNAIL_MOST = 512;

/** How much wider than its seam a repair thumbnail is, so there is ground to know it by. */
const REPAIR_THUMBNAIL_MARGIN = 1.6;

/** A fill on offer's thumbnail, which the panel shows half its width across. */
const REPAIR_OPTION_THUMBNAIL_SIDE = 320;

export const MOVED_SOLVE_QUIET_MS = 80;

type Point = { x: number; y: number };

/** What the repair tool needs of the editor it works in. */
export interface RepairHost {
  local(): { decoder: LocalDecoder; onTheBackend: boolean } | null;
  closed(): boolean;
  /** The document patched and drawn. */
  preview(patch: Partial<EditDoc>): void;
  /** The document patched, without asking for the picture to be drawn again. */
  write(patch: Partial<EditDoc>): void;
  /** The document patched, drawn and saved as one step of the history. */
  settle(patch: Partial<EditDoc>): void;
  /** Whatever the controls last asked the frame for, run now. */
  flushReprepare(): void;
  /** Settles once the frame on the device is at what was last asked for. */
  swept(): Promise<void>;
  /** The picture prepared elsewhere fetched again for the window the stage now holds. */
  rewindow(): Promise<void>;
  closeCrop(): void;
  closeKeystone(): void;
  showGeometry(): void;
  fail(why: string): void;
}

/**
 * The repair tool: loops drawn around what to remove, the fills offered for each, a fill or its
 * source dragged by hand, and the thumbnails of what was removed.
 */
export class RepairPresenter {
  constructor(
    private readonly stage: StageStore,
    private readonly edit: EditStore,
    private readonly keystone: KeystoneStore,
    private readonly store: RepairStore,
    private readonly host: RepairHost,
  ) {
    // The habits the last session ended on, as `RawEditPresenter` reads its own.
    store.repairOutlinesShown = readSetting(REPAIR_OUTLINES_KEY) !== '0';
    store.repairGrows = readSetting(REPAIR_GROWS_KEY) !== '0';
  }

  /**
   * Opens and closes the repair tool.
   *
   * Closing with a loop's fills still on offer takes the one on show back off: choosing is what
   * Apply is for, and a tool left by another route has not chosen.
   */
  @action.bound
  setRepairing(open: boolean): void {
    if (this.store.repairing === open) return;
    this.store.repairing = open;
    this.store.repairRefusal = null;
    if (open) {
      this.host.closeCrop();
      this.host.closeKeystone();
    } else {
      this.cancel();
    }
    this.host.showGeometry();
    this.follow();
  }

  /** What `follow` last asked the module about, so an older answer landing late is dropped. */
  private outlinesOf: string | null = null;

  /**
   * The seams the overlay draws, onto the output the stage shows, while the tool is open.
   *
   * Asked of the module, which applies the geometry to every pixel it draws: a crop, a straighten
   * and a keystone between the picture a seam is on and the stage it is drawn over.
   */
  follow(): void {
    const doc = this.edit.doc;
    const local = this.host.local();
    if (!this.store.repairing || doc == null || local == null || this.stage.width === 0) return;
    const geometry = this.keystone.geometry;
    const seams = doc.repairs.map((repair) => repair.seam);
    const shown = this.store.repairShownAt == null ? null : doc.repairs[this.store.repairShownAt];
    const source =
      shown == null ? [] : shown.seam.map(([x, y]): [number, number] => [x + shown.donor[0], y + shown.donor[1]]);
    const asked = JSON.stringify([geometry, seams, source]);
    if (asked === this.outlinesOf) return;
    this.outlinesOf = asked;
    const grid = storedSize(this.stage.width, this.stage.height);
    const points = [...seams.flat(), ...source].map(([x, y]): [number, number] => [x / grid.width, y / grid.height]);
    local.decoder.outputOfPicture(geometry, points).then(
      action((mapped: [number, number][]) => {
        if (this.host.closed() || this.outlinesOf !== asked) return;
        let at = 0;
        const next = (): Point => {
          const [x = 0, y = 0] = mapped[at++] ?? [];
          return { x, y };
        };
        this.store.repairOutlines = seams.map((seam) => seam.map(next));
        this.store.repairSourceOutline = shown == null ? null : source.map(next);
        this.outlined = new Map(
          seams.map((seam, index) => [outlineKey(geometry, seam), this.store.repairOutlines[index] ?? []]),
        );
        void this.followThumbnails();
      }),
      (error: unknown) => {
        if (!this.host.closed()) this.host.fail(describe(error));
      },
    );
  }

  /**
   * The outlines last mapped, by the geometry and seam they were mapped from: by seam rather than by
   * repair, since a blend or a fill with the same seam is a new repair on the same outline, and
   * those are never mapped again.
   */
  private outlined = new Map<string, Point[]>();

  private thumbnailing = false;

  /** Thumbnails that could not be drawn, so the loop below does not ask for them forever. */
  private readonly thumbnailRefused = new Set<string>();

  /**
   * A thumbnail drawn for every repair the document holds and has none, one at a time, and those
   * of repairs it no longer holds let go: the photograph under each, drawn with every repair but
   * that one, so the thumbnail is what was removed.
   *
   * Not while fills are on offer: the frame is then showing a fill the reader has not kept.
   */
  private async followThumbnails(): Promise<void> {
    if (this.thumbnailing) return;
    this.thumbnailing = true;
    try {
      for (;;) {
        this.pruneThumbnails();
        const next = this.nextThumbnail();
        if (next == null || this.repairAt != null) return;
        // The frame has to be carrying the repair, which is what cut the patch the thumbnail is.
        await this.host.swept();
        const local = this.host.local();
        if (this.host.closed() || local == null) return;
        try {
          const png = await local.decoder.repairThumbnail(
            thumbnailSide(next.region),
            this.edit.exposureEv,
            next.region,
            next.repair,
          );
          if (this.host.closed()) return;
          this.keepThumbnail(next.key, { url: URL.createObjectURL(png), seam: next.seam });
        } catch {
          this.thumbnailRefused.add(next.key);
        }
      }
    } finally {
      this.thumbnailing = false;
    }
  }

  /** The first repair with no thumbnail, and the square of the output around its seam. */
  private nextThumbnail(): { key: string; repair: Repair; region: Region; seam: Point[] } | null {
    const output = this.keystone.output;
    const geometry = this.keystone.geometry;
    const repairs = this.edit.doc?.repairs ?? [];
    for (const [index, key] of this.store.repairKeys.entries()) {
      const repair = repairs[index];
      const outline = repair == null ? undefined : this.outlined.get(outlineKey(geometry, repair.seam));
      if (repair == null || outline == null || outline.length === 0) continue;
      if (this.store.repairThumbnails.has(key) || this.thumbnailRefused.has(key)) continue;
      const onOutput = outline.map(({ x, y }) => ({ x: x * output.width, y: y * output.height }));
      const region = squareAround(onOutput);
      return { key, repair, region, seam: onOutput.map((point) => withinRegion(point, region)) };
    }
    return null;
  }

  /** Counts offers, so a thumbnail drawn for fills no longer on offer is not kept. */
  private offers = 0;

  /**
   * A thumbnail of every fill on offer, one at a time: the stage around the loop as it would be with
   * that fill chosen, all over one square so they compare. A fill whose thumbnail cannot be drawn
   * keeps its number.
   */
  private async followOptionThumbnails(at: RepairAt): Promise<void> {
    const offer = this.offers;
    const local = this.host.local();
    const options = this.store.repairOptions;
    if (local == null || options == null) return;
    const grid = storedSize(this.stage.width, this.stage.height);
    const loops = [at.drawn, ...options.map((option) => option.seam)];
    let mapped: [number, number][];
    try {
      mapped = await local.decoder.outputOfPicture(
        this.keystone.geometry,
        loops.flat().map(([x, y]): [number, number] => [x / grid.width, y / grid.height]),
      );
    } catch {
      return;
    }
    const output = this.keystone.output;
    const onOutput = mapped.map(([x, y]) => ({ x: x * output.width, y: y * output.height }));
    const region = squareAround(onOutput);
    let from = at.drawn.length;
    const seams = options.map((option) => {
      const seam = onOutput.slice(from, from + option.seam.length);
      from += option.seam.length;
      return seam.map((point) => withinRegion(point, region));
    });
    for (const [index, option] of options.entries()) {
      // The frame has to be carrying the fill on show, which is what the option is drawn in place of.
      await this.host.swept();
      if (this.host.closed() || this.offers !== offer) return;
      try {
        const png = await local.decoder.optionThumbnail(
          REPAIR_OPTION_THUMBNAIL_SIDE,
          this.edit.exposureEv,
          region,
          this.store.repairOptions?.[this.store.repairChoice] ?? null,
          option,
        );
        if (this.host.closed() || this.offers !== offer) return;
        this.keepOptionThumbnail(index, { url: URL.createObjectURL(png), seam: seams[index] ?? [] });
      } catch {
        // Its number stands in for it.
      }
    }
  }

  @action.bound
  private keepOptionThumbnail(index: number, thumbnail: RepairThumbnail): void {
    this.store.repairOptionThumbnails = new Map([...this.store.repairOptionThumbnails, [index, thumbnail]]);
  }

  @action.bound
  private dropOptionThumbnails(): void {
    this.offers += 1;
    for (const { url } of this.store.repairOptionThumbnails.values()) URL.revokeObjectURL(url);
    this.store.repairOptionThumbnails = new Map();
  }

  @action.bound
  private keepThumbnail(key: string, thumbnail: RepairThumbnail): void {
    this.store.repairThumbnails = new Map([...this.store.repairThumbnails, [key, thumbnail]]);
  }

  @action.bound
  private pruneThumbnails(): void {
    const current = new Set(this.store.repairKeys);
    const kept = [...this.store.repairThumbnails].filter(([key, { url }]) => {
      if (current.has(key)) return true;
      URL.revokeObjectURL(url);
      return false;
    });
    if (kept.length !== this.store.repairThumbnails.size) this.store.repairThumbnails = new Map(kept);
  }

  /** The loop whose fills are on offer, and where they would go. */
  private repairAt: RepairAt | null = null;

  /**
   * A loop the reader drew, as fractions of the output on the stage: taken onto the picture through
   * the geometry the stage is drawn with, then the places it could be filled from are asked for, and
   * the cheapest is shown.
   *
   * A loop drawn while another's fills are on offer replaces them, as a new lasso would.
   */
  @action.bound
  async draw(shown: readonly Point[]): Promise<void> {
    const local = this.host.local();
    if (local == null || this.edit.doc == null || this.store.repairSolving) return;
    this.cancel();
    const move = this.moves;
    const base = this.edit.doc.repairs;
    let onPicture: [number, number][];
    try {
      onPicture = await local.decoder.pictureOfOutput(
        this.keystone.geometry,
        shown.map(({ x, y }) => [x, y]),
      );
    } catch (error) {
      if (!this.host.closed()) this.refuse(describe(error), null);
      return;
    }
    if (this.host.closed() || this.moves !== move) return;
    const drawn = storedLoop(
      onPicture.map(([x, y]) => ({ x, y })),
      { width: this.stage.width, height: this.stage.height },
    );
    if (drawn == null) return;
    await this.solve({ drawn, index: base.length, base, replaced: null }, null, move);
  }

  /**
   * One of the photograph's repairs reopened: its fill on show and chosen, beside the other places
   * its loop could be filled from, which are solved again.
   *
   * **Off the picture without it**, while the stage goes on showing it: with the repair drawn on
   * what the search reads, the ground around the loop is the fill rather than the thing, and every
   * place looks like a match.
   */
  @action.bound
  async open(index: number): Promise<void> {
    if (this.store.repairSolving || this.repairAt?.index === index) return;
    this.cancel();
    const doc = this.edit.doc;
    const replaced = doc?.repairs[index];
    if (doc == null || replaced == null) return;
    const base = doc.repairs.filter((_, at) => at !== index);
    await this.solve({ drawn: replaced.drawn, index, base, replaced }, replaced, this.moves);
  }

  /** Whether the stage draws the repairs' seams: a habit, remembered as `setCropToFit` is. */
  @action.bound
  setOutlinesShown(shown: boolean): void {
    this.store.repairOutlinesShown = shown;
    writeSetting(REPAIR_OUTLINES_KEY, shown ? '1' : '0');
  }

  /**
   * Whether a seam may grow past the loop drawn to hide itself: a habit, remembered as
   * `setCropToFit` is. Fills on offer are searched again under the new setting, from the same loop.
   */
  @action.bound
  setGrows(grows: boolean): void {
    this.store.repairGrows = grows;
    writeSetting(REPAIR_GROWS_KEY, grows ? '1' : '0');
    const at = this.repairAt;
    if (at == null || this.store.repairSolving) return;
    void this.solve(at, this.store.repairOptions?.[this.store.repairChoice] ?? null, this.moves);
  }

  /** How far either side of the seam every fill on offer fades across, as a share of the long edge, while it moves. */
  @action.bound
  previewFeather(share: number): void {
    const options = this.store.repairOptions;
    const at = this.repairAt;
    if (options == null || at == null || this.store.repairSolving) return;
    const feather = Math.round(Math.min(Math.max(share, 0), 1) * STORED_LONG);
    this.store.repairOptions = options.map((option) => ({ ...option, feather }));
    const shown = this.store.repairOptions[this.store.repairChoice];
    if (shown != null) this.host.preview({ repairs: spliced(at.base, at.index, shown) });
  }

  @action.bound
  settleFeather(share: number): void {
    this.previewFeather(share);
    this.host.flushReprepare();
  }

  /** Which of the fills on offer the stage shows. */
  @action.bound
  choose(choice: number): void {
    const options = this.store.repairOptions;
    if (options?.[choice] == null || this.store.repairSolving) return;
    this.store.repairChoice = choice;
    this.show();
  }

  /** The fill on show, kept. */
  @action.bound
  apply(): void {
    if (this.repairAt == null || this.store.repairSolving) return;
    this.end();
    this.host.settle({});
  }

  /** The fills on offer put away, and the photograph's repairs as they were before the loop. */
  @action.bound
  cancel(): void {
    const at = this.repairAt;
    // Before a loop has anything on offer too, so a solve still out for it lands on nothing.
    this.moves += 1;
    if (at == null) return;
    this.end();
    this.host.preview({ repairs: unoffered(at) });
    this.host.flushReprepare();
  }

  /** One of the photograph's repairs, taken off. */
  @action.bound
  remove(index: number): void {
    const doc = this.edit.doc;
    if (doc == null || this.repairAt != null) return;
    this.host.settle({ repairs: doc.repairs.filter((_, at) => at !== index) });
  }

  /** The editor closing: a fill on offer was never kept, so the document left is the one without it. */
  close(): void {
    const offered = this.repairAt;
    if (offered != null) {
      this.end();
      this.host.write({ repairs: unoffered(offered) });
    }
    for (const { url } of this.store.repairThumbnails.values()) URL.revokeObjectURL(url);
    this.dropOptionThumbnails();
  }

  /** Counts moves of the fill on offer, so one solved for a place it has since left is dropped. */
  private moves = 0;

  /** The moves not yet applied, in order: each is a step from wherever the last left the fill. */
  private moving: Promise<void> = Promise.resolve();

  /** Moves waiting for the step before them, each taking in every move of its part after it. */
  private readonly queuedMoves: { part: 'fill' | 'source'; from: Point; to: Point }[] = [];

  /**
   * The fill on offer, or where it is read from, dragged on the stage from `from` to `to`, in
   * fractions of the output: shown there at once, moved as it was, then solved again there once it
   * rests - the seam grown from the loop and the light matched for where it now reads from.
   *
   * **Moving the fill leaves where it is read from where it was**, as a clone stamp's source stays
   * put, and the other places on offer go with the place they were searched for until
   * {@link settleMove} searches its new one.
   */
  move(part: 'fill' | 'source', from: Point, to: Point): Promise<void> {
    this.dragging = true;
    const waiting = this.queuedMoves.at(-1);
    if (waiting?.part === part) {
      waiting.to = to;
      return this.moving;
    }
    this.queuedMoves.push({ part, from, to });
    this.moving = this.moving.then(() => {
      const next = this.queuedMoves.shift();
      return next == null ? undefined : this.step(next.part, next.from, next.to);
    });
    return this.moving;
  }

  /**
   * The drag let go: solved where it was left, and a fill moved is offered beside what the search
   * finds at its new place.
   */
  settleMove(): Promise<void> {
    this.moving = this.moving.then(() => {
      this.dragging = false;
      this.stopSolveTimer();
      if (this.fillMoved) {
        this.fillMoved = false;
        this.searchMoved = true;
      } else if (this.repairAt != null) {
        void this.followOptionThumbnails(this.repairAt);
      }
      return this.solveMoved();
    });
    return this.moving;
  }

  /** Whether the fill itself has moved since it was last searched around. */
  private fillMoved = false;

  /** Whether a drag is moving the fill or its source, whose every step would outdate a thumbnail. */
  private dragging = false;

  private solveTimer: ReturnType<typeof setTimeout> | null = null;

  private solveAtRest(): void {
    this.stopSolveTimer();
    this.solveTimer = setTimeout(() => {
      this.solveTimer = null;
      void this.solveMoved();
    }, MOVED_SOLVE_QUIET_MS);
  }

  private stopSolveTimer(): void {
    if (this.solveTimer != null) clearTimeout(this.solveTimer);
    this.solveTimer = null;
  }

  private async step(part: 'fill' | 'source', from: Point, to: Point): Promise<void> {
    const local = this.host.local();
    const at = this.repairAt;
    const shown = this.store.repairOptions?.[this.store.repairChoice];
    if (local == null || at == null || shown == null) return;
    let ends: [number, number][];
    try {
      ends = await local.decoder.pictureOfOutput(this.keystone.geometry, [
        [from.x, from.y],
        [to.x, to.y],
      ]);
    } catch (error) {
      if (!this.host.closed()) this.host.fail(describe(error));
      return;
    }
    if (this.host.closed() || this.repairAt !== at) return;
    this.moves += 1;
    const grid = storedSize(this.stage.width, this.stage.height);
    const [[fx, fy] = [0, 0], [tx, ty] = [0, 0]] = ends;
    const by: [number, number] = [Math.round((tx - fx) * grid.width), Math.round((ty - fy) * grid.height)];
    if (part === 'fill') {
      const fill = movedFill(shown, by, grid);
      this.fillMoved = true;
      this.place({ ...at, drawn: fill.drawn }, [fill], 0);
    } else {
      const choice = this.store.repairChoice;
      const source = movedSource(shown, by, grid);
      const options = this.store.repairOptions ?? [];
      this.place(at, options.map((option, index) => (index === choice ? source : option)), choice);
    }
    this.solveAtRest();
  }

  /** Whether a moved fill is being solved, whether it has moved again since, and whether a search waits. */
  private solvingMoved = false;
  private movedAgain = false;
  private searchMoved = false;
  /** The move the fill on show was last solved at, so a search asked for at rest does not repeat it. */
  private solvedMove = 0;

  /**
   * The fill on show solved where it now is: one solve at a time, the last place always solved, and
   * once it has come to rest where a search is wanted, searched around there too.
   */
  private async solveMoved(): Promise<void> {
    if (this.solvingMoved) {
      this.movedAgain = true;
      return;
    }
    this.solvingMoved = true;
    try {
      do {
        this.movedAgain = false;
        const at = this.repairAt;
        const moved = this.store.repairOptions?.[this.store.repairChoice];
        if (at == null || moved == null) return;
        if (this.solvedMove !== this.moves) {
          this.solvedMove = this.moves;
          await this.solve(at, moved, this.moves, { donor: moved.donor });
        }
        if (!this.searchMoved || this.movedAgain) continue;
        this.searchMoved = false;
        const rested = this.repairAt;
        const kept = this.store.repairOptions?.[this.store.repairChoice];
        if (rested == null || kept == null) return;
        await this.solve(rested, kept, this.moves, { donor: null, kept });
      } while (this.movedAgain && !this.host.closed());
    } finally {
      this.solvingMoved = false;
    }
  }

  /** `options` on offer for `at`, `choice` of them on show, their thumbnails drawn again. */
  @action.bound
  private place(at: RepairAt, options: Repair[], choice: number): void {
    this.repairAt = at;
    this.dropOptionThumbnails();
    this.store.repairOptions = options;
    this.store.repairChoice = choice;
    this.show();
    if (!this.dragging) void this.followOptionThumbnails(at);
  }

  /**
   * `showing` is the fill the stage is showing at the loop - a repair reopened, or one on offer
   * searched again - which the search reads from under while the stage goes on showing it.
   *
   * `placed` is where the reader moved it, which is solved there alone and replaces it - or, with
   * no donor, searched around and offered beside what is `kept`; nothing about it is refused, since
   * the stage is already showing it moved.
   *
   * The answer is dropped where anything has moved the tool on since `move`.
   */
  private async solve(
    at: RepairAt,
    showing: Repair | null,
    move: number,
    placed: { donor: [number, number] | null; kept?: Repair } | null = null,
  ): Promise<void> {
    const { drawn } = at;
    const local = this.host.local();
    if (local == null) return;
    const donor = placed?.donor ?? null;
    this.setSolving(true);
    try {
      // The search reads the frame on the device, which a fill just put away may still be drawn on.
      await this.host.swept();
      if (this.host.closed()) return;
      // A picture prepared elsewhere is held as the tiles the stage needed, which a search three
      // loops wide reaches past: it is held as far as the search reads for as long as it runs.
      if (local.onTheBackend) {
        const { missing } = await local.decoder.setSearched(drawn, donor);
        if (this.host.closed()) return;
        if (missing != null) await this.host.rewindow();
      }
      const offered = await local.decoder.solveRepair(drawn, at.base, this.store.repairGrows, showing, donor);
      if (local.onTheBackend) await local.decoder.setSearched(null, null);
      if (this.host.closed() || this.moves !== move) return;
      if (placed == null) this.offer(offered, at);
      else if (placed.kept == null) this.settleMoved(offered[0]);
      else this.offer(offered, at, placed.kept);
    } catch (error) {
      if (!this.host.closed() && this.moves === move && placed == null) this.refuse(describe(error), at);
    } finally {
      this.setSolving(false);
    }
  }

  /** A fill moved and solved where it was put, in place of the one moved there, at its blend. */
  @action.bound
  private settleMoved(solved: Repair | undefined): void {
    const at = this.repairAt;
    const options = this.store.repairOptions;
    const moved = options?.[this.store.repairChoice];
    if (solved == null || at == null || options == null || moved == null) return;
    const choice = this.store.repairChoice;
    const settled = { ...solved, feather: moved.feather };
    this.place(at, options.map((option, index) => (index === choice ? settled : option)), choice);
  }

  /** Solves out, which can overlap: a loop's, and a moved fill's still landing. */
  private solves = 0;

  @action.bound
  private setSolving(solving: boolean): void {
    this.solves += solving ? 1 : -1;
    this.store.repairSolving = this.solves > 0;
    if (solving) this.store.repairRefusal = null;
  }

  /** Nothing to offer, said, and the repairs put back as they were before the loop. */
  @action.bound
  private refuse(why: string, at: RepairAt | null): void {
    this.store.repairRefusal = why;
    if (at == null) return;
    if (this.repairAt === at) this.end();
    this.host.preview({ repairs: unoffered(at) });
  }

  @action.bound
  private offer(solved: Repair[], at: RepairAt, kept: Repair | null = at.replaced): void {
    // A repair reopened or moved is offered as it was first, at its own blend, and the rest beside it.
    const options =
      kept == null
        ? solved
        : [
            kept,
            ...solved
              .filter((option) => !sameFill(option, kept))
              .map((option) => (kept.feather == null ? option : { ...option, feather: kept.feather })),
          ];
    if (options.length === 0) {
      this.refuse(RawEditPanelStrings.nothingToFillFrom(), at);
      return;
    }
    this.moves += 1;
    this.store.repairShownAt = at.index;
    this.place(at, options, 0);
  }

  /** The fill the reader is looking at, in the document where it would go. */
  private show(): void {
    const at = this.repairAt;
    const shown = this.store.repairOptions?.[this.store.repairChoice];
    if (at == null || shown == null) return;
    this.host.preview({ repairs: spliced(at.base, at.index, shown) });
    this.host.flushReprepare();
  }

  @action.bound
  private end(): void {
    this.repairAt = null;
    this.moves += 1;
    this.fillMoved = false;
    this.searchMoved = false;
    this.dragging = false;
    this.stopSolveTimer();
    this.dropOptionThumbnails();
    this.store.repairOptions = null;
    this.store.repairChoice = 0;
    this.store.repairShownAt = null;
    this.store.repairSourceOutline = null;
    void this.followThumbnails();
  }
}

/**
 * A loop being solved or whose fills are on offer: the loop on the grid, where its fill sits in
 * the document's repairs, the repairs either side of it, and the repair it stands in for where the
 * reader has reopened one.
 */
type RepairAt = { drawn: [number, number][]; index: number; base: Repair[]; replaced: Repair | null };

/** The repairs as they were before `at`'s loop: with the repair it reopened, where it did. */
function unoffered(at: RepairAt): Repair[] {
  return at.replaced == null ? at.base : spliced(at.base, at.index, at.replaced);
}

/** `repairs` with `repair` put back at `index`. */
function spliced(repairs: readonly Repair[], index: number, repair: Repair): Repair[] {
  return [...repairs.slice(0, index), repair, ...repairs.slice(index)];
}

/** How far `points` may move along one axis of a grid `extent` steps long and all stay on it. */
function withinGrid(points: readonly (readonly [number, number])[], axis: 0 | 1, by: number, extent: number): number {
  const at = points.map((point) => point[axis]);
  return Math.min(Math.max(by, -Math.min(...at)), extent - Math.max(...at));
}

/** `repair`'s donor moved `by` steps, as far as keeps where it reads from on the picture. */
function movedSource(repair: Repair, by: [number, number], grid: { width: number; height: number }): Repair {
  const read = repair.seam.map(([x, y]): [number, number] => [x + repair.donor[0], y + repair.donor[1]]);
  return {
    ...repair,
    donor: [
      repair.donor[0] + withinGrid(read, 0, by[0], grid.width),
      repair.donor[1] + withinGrid(read, 1, by[1], grid.height),
    ],
  };
}

/**
 * `repair` moved `by` steps, as far as keeps it on the picture, still reading its fill from where
 * it did - and so its donor moved back by as much.
 */
function movedFill(repair: Repair, by: [number, number], grid: { width: number; height: number }): Repair {
  const all = [...repair.drawn, ...repair.seam];
  const [dx, dy] = [withinGrid(all, 0, by[0], grid.width), withinGrid(all, 1, by[1], grid.height)];
  const moved = (points: Repair['seam']): Repair['seam'] => points.map(([x, y]) => [x + dx, y + dy]);
  return {
    ...repair,
    drawn: moved(repair.drawn),
    seam: moved(repair.seam),
    donor: [repair.donor[0] - dx, repair.donor[1] - dy],
  };
}

/** A square of the output around `points`, in its pixels, with room around them to see them in. */
function squareAround(points: readonly Point[]): Region {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const side = Math.max(right - left, bottom - top, 1) * REPAIR_THUMBNAIL_MARGIN;
  return { x: (left + right) / 2 - side / 2, y: (top + bottom) / 2 - side / 2, width: side, height: side };
}

/** `point` of the output as fractions of `region`. */
function withinRegion(point: Point, region: Region): Point {
  return { x: (point.x - region.x) / region.width, y: (point.y - region.y) / region.height };
}

/**
 * A thumbnail's canvas, about as large as its region, so the browser's own downscale to the box it
 * is shown in does the averaging: the part it is drawn from has no levels to average with.
 */
function thumbnailSide(region: Region): number {
  return Math.min(Math.max(Math.ceil(region.width), REPAIR_THUMBNAIL_SIDE), REPAIR_THUMBNAIL_MOST);
}

function outlineKey(geometry: EditGeometry, seam: Repair['seam']): string {
  return JSON.stringify([geometry, seam]);
}

/** Whether two repairs fill the same seam from the same place, whatever their blends. */
function sameFill(a: Repair, b: Repair): boolean {
  return JSON.stringify([a.seam, a.donor, a.gain]) === JSON.stringify([b.seam, b.donor, b.gain]);
}
