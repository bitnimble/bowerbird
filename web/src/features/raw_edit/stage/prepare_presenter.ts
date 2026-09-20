import type { PrepareDevelop } from '../../../../../src/schemas/prepare_develop';
import { describe } from '../../../errors';
import type { LocalPrepare } from '../local_decode/local_open';
import {
  developOf,
  keepPhotoAnalysis,
  sameDevelop,
  samePrepare,
  type LocalSource,
} from '../local_decode/open_photo';
import type { LoupePresenter } from '../loupe/loupe_presenter';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { StageStore } from './stage_store';

/**
 * The rows one band of a re-prepare covers.
 *
 * A latency size rather than a throughput one: every band is grown by the halo of everything that
 * reads past it - the denoise's window, the demosaic's margin, the gather's reach and the
 * sharpen's - so a smaller band puts more area through the filters and takes longer overall. What
 * it buys is somewhere to draw from. `galosh::PROGRESS_TILE` measured the same trade on the
 * denoise alone and landed on 2048; this is the whole chain, so the strips are coarser.
 *
 * Even, which `HeldRaw::band_into` requires of every band but the last: an odd stride would put
 * half the bands of an odd-width frame on a half-word, where the copy cannot begin.
 */
const BAND_ROWS = 1024;

/**
 * How long a mosaic control may be still before the re-prepare runs.
 *
 * Long enough that a drag is a handful of renders rather than one per position, short enough
 * that a reader who pauses mid-drag sees the answer before they wonder whether it is coming.
 */
const REPREPARE_QUIET_MS = 120;

export class PreparePresenter {
  constructor(
    private readonly stageStore: StageStore,
    private readonly loupe: LoupePresenter,
    private readonly stage: RawEditPresenter,
  ) {}

  /**
   * Asks for a re-prepare, once the control has stopped moving.
   *
   * **The picture lags the slider here, on purpose.** The chain is the whole decode below the
   * mosaic and takes the detail blur with it, where every other control is a word in a uniform - so
   * running it per pointer position spends the whole frame budget on a picture that is replaced
   * before it is looked at, and the control itself goes sticky under the hand. A short quiet period
   * turns a drag into a handful of renders, and the release settles it.
   */
  want(next: LocalPrepare): void {
    // **Against where the frame is *heading*, not where it stands.** Every other slider settles
    // through the same `preview`, so an exposure must not re-prepare the photograph at the settings
    // it already has - but `mosaicAt` only moves when a sweep finishes, and a sweep is seconds. Ask
    // it alone and returning a control to the value the frame currently holds, while a sweep is
    // carrying it somewhere else, reads as "nothing to do" and schedules nothing: the sweep lands,
    // and the picture is left corrected with the switch that ordered it turned off.
    const heading = this.mosaicWanted ?? this.mosaicPending ?? this.mosaicRunning ?? this.mosaicAt;
    if (samePrepare(heading, next)) return;
    this.mosaicWanted = next;
    if (this.reprepareTimer != null) clearTimeout(this.reprepareTimer);
    this.reprepareTimer = setTimeout(() => this.flush(), REPREPARE_QUIET_MS);
  }

  /** The settings the frame on the GPU was prepared at, which the open sets and a re-prepare moves. */
  private mosaicAt: LocalPrepare | null = null;

  seed(mosaic: LocalPrepare): void {
    this.mosaicAt = mosaic;
  }

  /** What the sweep in flight is preparing, which is where the frame is going rather than where it is. */
  private mosaicRunning: LocalPrepare | null = null;

  /** Runs whatever the controls last asked for, now. */
  flush(): void {
    if (this.reprepareTimer != null) {
      clearTimeout(this.reprepareTimer);
      this.reprepareTimer = null;
    }
    const wanted = this.mosaicWanted;
    if (wanted == null) return;
    this.mosaicWanted = null;
    void this.reprepare(wanted);
  }

  /**
   * The photograph prepared again at these mosaic settings.
   *
   * **Off the mosaic the worker is holding, not off the frame on the GPU.** Both stages belong
   * above the demosaic - the denoise where the noise is still one photosite's own, the dust
   * correction where a shadow is still one number per photosite - so this re-runs the decode from
   * there and swaps the result in, rather than filtering a frame that has already been demosaiced,
   * coded, warped and sharpened. It is the same call a rendition makes, which is the point.
   *
   * Only one in flight: a drag that outruns the worker would otherwise queue a prepare per
   * position and land them out of order, so a newer request supersedes an unstarted one and the
   * last one wins.
   */
  private reprepare(mosaic: LocalPrepare): Promise<void> {
    const local = this.stage.localSource();
    if (local == null) return Promise.resolve();
    this.mosaicPending = mosaic;
    // The presenter's own latch, not the store's flag. A store is data the view reads; using its
    // observable to decide whether a sweep is already running would let anything that writes it -
    // a test, a future control - wedge the queue.
    if (this.repreparing) return this.sweep;
    this.sweep = this.sweepBands(local);
    return this.sweep;
  }

  /** The re-prepare in flight, which settles once the frame is at whatever was last asked for. */
  private sweep: Promise<void> = Promise.resolve();

  /** Whatever the controls last asked for, run now, and the frame once it is there. */
  swept(): Promise<void> {
    this.flush();
    return this.sweep;
  }

  /**
   * The rows a sweep was abandoned part-way across, which hold some bands at one setting and some
   * at another until a sweep reaches all of them.
   */
  private mixedRows: [number, number] | null = null;

  private async sweepBands(local: LocalSource): Promise<void> {
    this.repreparing = true;
    this.stage.setRepreparing(true);
    try {
      while (this.mosaicPending != null) {
        const next = this.mosaicPending;
        this.mosaicPending = null;
        this.mosaicRunning = next;
        // **Where the picture was prepared elsewhere, the rest ran there**: its repairs are drawn
        // here over the tiles and only need telling, but a Detail or dust setting ran before the
        // samples crossed - so the tiles at the old ones go, and what is on screen is asked for
        // again at these. The frame drawn stays until the new one is assembled.
        if (local.onTheBackend) {
          const { missing } = await local.decoder.setRepairs(next.repairs);
          if (this.stage.isClosed()) return;
          if (!sameDevelop(this.mosaicAt, next)) {
            this.developing = developOf(next);
            await local.decoder.dropTiles();
            this.stage.clearLevel();
            await this.stage.rewindow();
          } else if (missing != null) {
            await this.stage.rewindow();
          }
          if (this.mosaicPending == null) this.mosaicAt = next;
          this.stage.draw();
          continue;
        }
        const frame = { width: this.stageStore.width, height: this.stageStore.height };
        if (frame.width === 0 || frame.height === 0) return;
        // **Repairs alone are redrawn over the frame, not prepared again.** Moving a fill or
        // choosing another is what a reader does several times a minute with this tool, and the
        // frame keeps what was under every repair, so none of it needs the RAW chain.
        const repairsOnly = sameDevelop(this.mosaicAt, next);
        if (repairsOnly) {
          await local.decoder.redrawRepairs(next.repairs);
          if (this.stage.isClosed()) return;
          this.stage.draw();
        }
        const rows: [number, number] | null = repairsOnly ? this.mixedRows : [0, frame.height];
        // **A band at a time, drawn as each lands.** The whole re-prepare is seconds on a large
        // photograph and the reader is looking at the picture throughout, so the strips arrive
        // and the frame fills in. Abandoned the moment another position is asked for: the bands
        // below the one in flight would be the old settings, and a frame half at each is worse
        // than one still at the last.
        //
        // On the same even stride from the frame's top whatever rows are wanted, which is what
        // `HeldRaw::band_into` needs of every band but the last.
        const first = rows == null ? frame.height : Math.floor(rows[0] / BAND_ROWS) * BAND_ROWS;
        const end = rows == null ? frame.height : rows[1];
        for (let top = first; top < end; top += BAND_ROWS) {
          const count = Math.min(BAND_ROWS, frame.height - top);
          await local.decoder.bandInto(next, top, count, [frame.width, frame.height]);
          if (this.stage.isClosed()) return;
          if (this.mosaicPending != null) {
            this.mixedRows = rows;
            break;
          }
          this.stage.draw();
        }
        if (this.mosaicPending == null) {
          this.mixedRows = null;
          this.mosaicAt = next;
          // **What the sweep had to measure, which only the worker knows.** A reader who switches
          // dust on after the open makes the first band detect this photograph's particles, and a
          // band carries no header to say so - so without this the loupe would go on asking for
          // tiles built from an analysis with no particles in it, and magnify a spot the stage
          // underneath had already removed.
          //
          // Kept only where it *gained* something, or every release of a Detail slider would write
          // the same sidecar to the server again. Longer, not merely different: the blob shrinks
          // whenever a build that cannot read one of its sections re-encodes it, and this write is
          // a whole-file replace, so taking a shorter one would let an older reader truncate what a
          // newer one had stored.
          const measured = await local.decoder.analysis();
          if (this.stage.isClosed()) return;
          const held = local.photoAnalysis?.length ?? 0;
          const photoId = this.stage.openedPhotoId();
          if (measured != null && measured.length > held && photoId != null) {
            local.photoAnalysis = measured;
            keepPhotoAnalysis(photoId, measured);
            // The loupe's tiles were built from the analysis that did not have these particles in
            // it, and the cache key cannot see that it moved.
            this.loupe.clearTiles();
          }
          // Once, on the whole frame: the blur is a whole-frame reduction and one built against a
          // half-replaced frame would be fitted to two denoise strengths at once.
          await local.decoder.refreshDetail();
          this.stage.draw();
        }
      }
    } catch (error) {
      if (!this.stage.isClosed()) this.stage.failPrepare(describe(error));
    } finally {
      this.repreparing = false;
      this.mosaicRunning = null;
      this.stage.setRepreparing(false);
    }
  }

  /** Whether a sweep is running. The store's flag mirrors this for the view; this one decides. */
  private repreparing = false;

  private mosaicPending: LocalPrepare | null = null;

  private mosaicWanted: LocalPrepare | null = null;
  private reprepareTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The Detail and dust settings every prepare asks the server for, once the reader has moved one
   * from what the open was prepared at: the stored document is only the last save, and a tile at
   * the saved settings beside one at these would be two pictures in one frame.
   */
  developing: PrepareDevelop | undefined = undefined;

  close(): void {
    if (this.reprepareTimer != null) clearTimeout(this.reprepareTimer);
    this.reprepareTimer = null;
    this.mosaicWanted = null;
  }
}
