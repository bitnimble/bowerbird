import { action } from 'mobx';
import { type EditCheckpoint, type EditDoc, type EditState } from '../../../../../src/schemas/photo_edits';
import { photoEditsApi } from '../../../api/photo_edits';
import { ApiError } from '../../../api/request';
import { newId } from '../../../../../src/schemas/id';
import { type ColourProfile, type Denoiser } from '../../../../../src/schemas/photo_edits';
import type { AsShot } from '../../../../../src/schemas/prepared';
import type { RepairPresenter } from '../repair/repair_presenter';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { EditStore, SaveStatus } from './edit_store';

/**
 * Whether the server refused a write because these edits moved under it.
 *
 * Asked of the status rather than of the message. `describe` returns the server's
 * prose, which says what happened and never says `409`, so matching on the text was
 * reporting every conflict as a generic failure - and telling the reader to retry
 * the one thing that cannot work.
 */
function conflicted(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export class EditPresenter {
  /** Which photo's edits are being written, kept because `open` is the only caller told. */
  private photoId: string | null = null;
  private session = newId();
  private writing: Promise<void> | null = null;
  /** A settle that arrived while a save was in flight. Only the latest is ever kept. */
  private pendingSave = false;
  /**
   * Whether the document moved locally since the save in flight was sent.
   *
   * Set by `preview`, so a drag counts and not only a release: without it the
   * server's answer to the *previous* value would overwrite what the reader is
   * currently looking at, and the picture would jump backwards mid-gesture.
   */
  private locallyEdited = false;
  /** What this open started from, which `cancel` puts back. */
  private openedAt: EditCheckpoint | null = null;
  /** Whether the server has stored anything since the open, which `close` asks after it has gone. */
  private written = false;

  constructor(
    private readonly store: EditStore,
    private readonly stage: RawEditPresenter,
    private readonly repair: RepairPresenter,
  ) {}

  @action.bound
  begin(photoId: string): void {
    this.photoId = photoId;
    // Every save from this open carries it, and a merge takes the session whole
    // (docs/replication.md §5.3).
    this.session = newId();
    // The exposure is derived from the document now, so clearing it is clearing
    // that: a stale one would draw the previous photo's grade over this one's
    // frame for as long as the read takes.
    this.store.doc = null;
    this.store.rev = 0;
    this.store.canUndo = false;
    this.store.canRedo = false;
    this.store.saveStatus = 'clean';
    this.store.asShot = null;
    this.openedAt = null;
    this.written = false;
  }

  opened(checkpoint: EditCheckpoint | null): void {
    this.openedAt = checkpoint;
  }

  @action.bound
  setAsShot(asShot: AsShot | null): void {
    this.store.asShot = asShot;
  }

  /**
   * The exposure the slider is at, while it moves.
   *
   * Local only. A pointer emits far more positions than anything should be asked to
   * store, and the undo stack would be four hundred entries for one drag.
   */
  @action.bound
  previewExposure(ev: number): void {
    this.preview({ exposure: ev });
  }

  /** Any parameter, while its control moves. The exposure is the one with a shader behind it today. */
  @action.bound
  preview(patch: Partial<EditDoc>): void {
    const next = this.write(patch);
    if (next != null) this.stage.drawEdit(next);
  }

  /** The document patched, without asking for the picture to be drawn again. */
  @action.bound
  write(patch: Partial<EditDoc>): EditDoc | null {
    const doc = this.store.doc;
    if (doc == null) return null;
    const next = { ...doc, ...patch };
    this.store.doc = next;
    this.locallyEdited = true;
    // The geometry before the grade, because it decides what the draw is even reading. The
    // store works out whether the crop tool wants it whole (`store.geometry`).
    this.stage.followGeometry();
    this.repair.follow();
    return next;
  }

  /**
   * The white balance pair, which moves as a pair whichever slider the reader has hold of.
   *
   * Both halves are written even when one moved, and that is the point. The document stores
   * null for "as shot" and the shader reads a missing half as the frame's own - so a
   * temperature written beside a null tint would say "this Kelvin, and whatever tint the
   * camera chose", which is not a rebalance anyone asked for and would drift again on the next
   * photo the settings were pasted onto.
   */
  @action.bound
  previewBalance(patch: { temperature?: number; tint?: number }): void {
    const balance = this.store.balance;
    if (balance == null) return;
    const temperature = Math.round(patch.temperature ?? balance.temperature);
    const tint = Math.round(patch.tint ?? balance.tint);
    // **Back at the camera's own pair is back to "As Shot", not a custom balance that happens to
    // agree with it.** The two are different documents - null means *that* photograph's neutral,
    // and a stored pair means these numbers wherever the settings are pasted - so a drag that
    // returns to the snap has to give the null back, or the panel reads "Custom" over a picture
    // nobody has balanced and a paste carries this frame's illuminant onto the next one.
    const neutral = this.store.asShotBalance;
    if (neutral != null && temperature === neutral.temperature && tint === neutral.tint) {
      this.preview({ whiteBalanceMode: 'As Shot', temperature: null, tint: null });
      return;
    }
    this.preview({
      // Camera Raw's own name for a pair somebody moved, and the document's rather than the
      // panel's to hold: an XMP written from this later has to say what the mode *is*, and a
      // mode derived at the point of display would not be in it.
      whiteBalanceMode: 'Custom',
      temperature,
      tint,
    });
  }

  @action.bound
  settleBalance(patch: { temperature?: number; tint?: number }): void {
    this.previewBalance(patch);
    void this.commit();
  }

  /**
   * The control was released: the frame that gets judged, and the one worth storing.
   *
   * This is the commit seam. A drag is one history entry because only this end of it
   * reaches the server.
   */
  @action.bound
  settleExposure(ev: number): void {
    this.preview({ exposure: ev });
    void this.commit();
  }

  /** As above, for a control that is not the exposure slider. */
  @action.bound
  settle(patch: Partial<EditDoc>): void {
    this.preview(patch);
    // The drag is over, so whatever the re-prepare still owes is owed now rather than in a tenth
    // of a second: a reader who has let go is looking at the picture.
    this.stage.flushReprepare();
    void this.commit();
  }

  @action.bound
  setColourProfile(colourProfile: ColourProfile): void {
    this.settle({ colourProfile });
  }

  @action.bound
  setDenoiser(denoiser: Denoiser): void {
    this.settle({ denoiser });
  }

  /**
   * Sends the document, one save at a time, coalescing whatever arrived meanwhile.
   *
   * Serialised rather than fired per settle, because two saves in flight can land
   * out of order: the server diffs against whatever arrived last, so the stored
   * document would be the *earlier* value and the history would record a step in
   * the wrong direction. Same shape as `request`'s frame coalescing, and for the
   * same reason - only the latest is ever outstanding.
   */
  async commit(): Promise<void> {
    if (this.writing != null) {
      this.pendingSave = true;
      return;
    }
    const photoId = this.photoId;
    const doc = this.store.doc;
    if (photoId == null || doc == null) return;

    this.locallyEdited = false;
    this.saveStatus('saving');
    await this.exclusively(async () => {
      try {
        const state = await photoEditsApi.save(photoId, doc, this.store.rev, this.session);
        // The bookkeeping always, the document only if nothing moved while this was
        // in flight. Taking it unconditionally would overwrite a slider the reader
        // moved during the round trip with the value that round trip was about.
        this.stored(state, this.locallyEdited);
      } catch (error) {
        // A refused revision is not a failure to retry as-is: something else moved
        // these edits, so the client has to take what is there now. Reported rather
        // than resolved - silently reloading would discard what the reader just did.
        this.saveStatus(conflicted(error) ? 'conflict' : 'failed');
      }
    });
  }

  /**
   * Puts the edits and their undo history back to where this open found them.
   *
   * False where that could not be done, and the edits made since are still stored.
   */
  async cancel(): Promise<boolean> {
    this.pendingSave = false;
    while (this.writing != null) await this.writing;
    const photoId = this.photoId;
    const openedAt = this.openedAt;
    if (photoId == null || openedAt == null || this.store.rev === openedAt.rev) return true;

    let restored = false;
    await this.exclusively(async () => {
      try {
        this.stored(await photoEditsApi.restore(photoId, this.store.rev, openedAt, this.session));
        restored = true;
      } catch (error) {
        this.saveStatus(conflicted(error) ? 'conflict' : 'failed');
      }
    });
    return restored;
  }

  @action.bound
  async undo(): Promise<void> {
    await this.step((photoId, rev) => photoEditsApi.undo(photoId, rev), this.store.canUndo);
  }

  @action.bound
  async redo(): Promise<void> {
    await this.step((photoId, rev) => photoEditsApi.redo(photoId, rev), this.store.canRedo);
  }

  private async step(
    call: (photoId: string, rev: number) => Promise<EditState>,
    allowed: boolean,
  ): Promise<void> {
    const photoId = this.photoId;
    // Waiting rather than racing: a step taken while a save is in flight would be
    // built on a revision the save is about to move.
    if (!allowed || photoId == null || this.writing != null) return;
    await this.exclusively(async () => {
      try {
        // A step replaces the document by definition, so it takes the whole answer.
        this.stored(await call(photoId, this.store.rev));
        this.locallyEdited = false;
        this.stage.draw();
      } catch (error) {
        this.saveStatus(conflicted(error) ? 'conflict' : 'failed');
      }
    });
  }

  private async exclusively(write: () => Promise<void>): Promise<void> {
    const writing = write().finally(() => {
      this.writing = null;
      // A settle that arrived mid-write took `commit`'s "already writing" arm and left this set,
      // and only `commit` drains it.
      if (this.pendingSave && !this.stage.isClosed()) {
        this.pendingSave = false;
        void this.commit();
      }
    });
    this.writing = writing;
    await writing;
  }

  /**
   * The server's answer, which is authoritative for the revision and both flags.
   *
   * `keepDoc` leaves the document alone, for the one case where the server's copy
   * is already out of date on arrival: a save that the reader edited on top of
   * while it was in flight.
   */
  @action.bound
  applyState(state: EditState, keepDoc = false): void {
    if (this.stage.isClosed()) return;
    if (!keepDoc) {
      this.store.doc = state.doc;
      // An undo can move the crop, and the draw has to follow it rather than keep showing
      // the shape the reader has just stepped away from - region and all, or the frame after
      // the step is a window measured against the picture before it.
      this.stage.followGeometry();
      this.repair.follow();
      // And it can move a mosaic control, which no tick can answer: stepping over a dust switch
      // or a Detail slider has to re-run the decode below the mosaic, exactly as moving it did.
      // Without this an undo clears the checkbox and leaves the picture corrected, and - because
      // the frame and the document now disagree - re-ticking it is refused as "no change".
      this.stage.prepareEdit(state.doc);
    }
    this.store.rev = state.rev;
    this.store.canUndo = state.canUndo;
    this.store.canRedo = state.canRedo;
    this.store.saveStatus = 'clean';
  }

  @action.bound
  private saveStatus(status: SaveStatus): void {
    if (!this.stage.isClosed()) this.store.saveStatus = status;
  }

  close(): void {
    // Only where something was actually stored: this is what asks the server to build the
    // picture the reader ended up with. No write above rebuilds anything, because a slider
    // release says nothing about whether they are finished - so leaving without this is
    // leaving the rendition at the last render.
    //
    // After the write in flight, or a save released on the way out is never rebuilt, and a
    // cancel followed at once by Done has the server compare against the cancelled edits.
    //
    // Sent even where the document came home - a slider dragged back, a cancel - because
    // every write moved the stamp a rendition is judged stale by. Handed what this open
    // started from, so the server can vouch for the copies already on disk instead of
    // rebuilding them byte for byte.
    //
    // Fire-and-forget, and the server does not depend on it arriving: the rebuild is
    // queued off the edits being newer than the render, so a tab closed before this
    // lands is caught by the sweep at startup instead.
    const photoId = this.photoId;
    const openedAt = this.openedAt;
    if (photoId == null) return;
    void (async () => {
      while (this.writing != null) await this.writing;
      if (this.written) await photoEditsApi.finish(photoId, openedAt ?? undefined);
    })().catch(() => {});
  }

  /** A write's answer, recorded even once the editor has closed. */
  private stored(state: EditState, keepDoc = false): void {
    if (state.rev !== (this.openedAt?.rev ?? 0)) this.written = true;
    this.applyState(state, keepDoc);
  }
}
