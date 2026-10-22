import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { newId } from '../../schemas/id';
import type { PastedEdits } from '../../schemas/photos';
import {
  EditDocSchema,
  diffEdits,
  neutralEdits,
  pastableEdits,
  type CameraTone,
  type Denoiser,
  type EditCheckpoint,
  type EditConflict,
  type EditDoc,
  type EditOpening,
  type EditState,
} from '../../schemas/photo_edits';
import type { PhotoListingRepository } from '../photos/listing/photo_listing_repository';
import { listConflicts, resolveConflict } from './conflicts';
import type { PhotoEditsRepository } from './photo_edits_repository';

/**
 * Reading and writing one photo's develop settings.
 *
 * Thin over the repository, which owns the undo arithmetic and the transaction:
 * what this adds is that the photo has to exist. Without the check a request
 * naming a photo that never did would create edits attached to nothing, and the
 * foreign key would only say so on the way in - as a 500 for what is a 404.
 *
 * **Writing is not rendering.** A save happens on every slider release, and one of
 * those says nothing about whether the reader is finished: rebuilding then spends
 * seconds of GPU on a frame they are about to change again, throws it away, and does
 * it once more on the next release. So nothing here renders. `finish` does, and the
 * editor calls it when it closes - the one moment the reader has said they are done.
 *
 * A tab closed, a crash, a navigation the client did not get to handle: none of those
 * reach `finish`, which is why the rebuild is queued off a *state* rather than an
 * event. "The edits are newer than the render" is true however the photo got that
 * way, so the sweep at startup catches every one that never got to say so.
 */
export class PhotoEditsService {
  constructor(
    private readonly db: Database,
    private readonly edits: PhotoEditsRepository,
    private readonly photoListing: PhotoListingRepository,
    /**
     * Queue both derived stages of these photos and start a drain.
     *
     * A seam rather than the processing service itself, defaulted so a test about the
     * edits is not also a test about the render queue - the same shape
     * `ProcessingService.editsFor` uses in the other direction. Nothing awaits it: a
     * rebuild is seconds of GPU work and this is called from a slider release.
     */
    private readonly rebuild: (photoIds: string[]) => void = () => {},
    /**
     * That this library's divergences are not what a page last read.
     *
     * Nothing on this device asks again on its own, so a window other than the
     * one that chose would go on offering a decision that has already been made.
     */
    private readonly changed: (libraryId: string) => void = () => {},
    /** Vouch for the copies built from this photo's document as it stood at `stamp`. */
    private readonly vouch: (photoId: string, stamp: string | null) => void = () => {},
    private readonly denoiserOf: (libraryId: string) => Denoiser = () => 'galosh',
    private readonly upscalable: (photoId: string) => boolean = () => true,
    /** `rebuild` for a paste: grid tiles, and the viewer's copy of `shown` alone. */
    private readonly rebuildPasted: (photoIds: string[], shown?: string) => void = () => {},
  ) {}

  get(photoId: string): EditState {
    this.require(photoId);
    return this.edits.get(photoId);
  }

  checkpoint(photoId: string): EditOpening {
    const photo = this.require(photoId);
    return {
      ...this.edits.checkpoint(photoId),
      library_denoiser: this.denoiserOf(photo.library_id),
      upscalable: this.upscalable(photoId),
    };
  }

  restore(
    photoId: string,
    rev: number,
    checkpoint: Pick<EditCheckpoint, 'doc' | 'cursor' | 'history'>,
    session: string,
  ): EditState {
    this.require(photoId);
    return this.edits.restore(photoId, rev, checkpoint, session);
  }

  save(photoId: string, doc: EditDoc, rev: number, session?: string): EditState {
    this.require(photoId);
    return this.edits.save(photoId, doc, rev, session);
  }

  /**
   * Fills the camera match into a photo with no document, or one a merge wrote that awaits it.
   *
   * Answers the checkpoint after it, which an editor open on the photo takes as what it opened on.
   */
  applyCameraMatch(photoId: string, tone: CameraTone): EditOpening {
    this.require(photoId);
    const applied = this.edits.applyCameraMatch(photoId, tone);
    if (applied != null) this.vouch(photoId, applied.from);
    return this.checkpoint(photoId);
  }

  undo(photoId: string, rev: number): EditState {
    this.require(photoId);
    return this.edits.undo(photoId, rev);
  }

  redo(photoId: string, rev: number): EditState {
    this.require(photoId);
    return this.edits.redo(photoId, rev);
  }

  /**
   * The editor has closed: build what the reader ended up with.
   *
   * Idempotent and cheap when there is nothing to do. The queue is keyed on the edits
   * being newer than the render, so a reader who opened the editor and changed
   * nothing, or who closes it twice, queues nothing - and a photo already rebuilt
   * since its last edit stops matching on its own.
   *
   * `opened` is what the editor opened on. Where the document has come back to it, the
   * copies built from it are vouched for first, so the queue finds nothing to rebuild.
   */
  finish(photoId: string, opened?: { doc: EditDoc; stamp: string | null }): void {
    this.require(photoId);
    if (opened != null && diffEdits(opened.doc, this.edits.get(photoId).doc) == null) {
      this.vouch(photoId, opened.stamp);
    }
    this.rebuild([photoId]);
  }

  /**
   * Lays the pastable fields of `edits` over each photo's own document, as one session.
   *
   * `editing` is skipped: its editor holds a revision this would move under it, so the editor
   * pastes into itself.
   */
  paste(
    photoIds: readonly string[],
    edits: Record<string, unknown>,
    open: { shown?: string; editing?: string } = {},
  ): PastedEdits {
    const patch = pastableEdits(EditDocSchema.parse({ ...neutralEdits(), ...edits }));
    const session = newId();
    const named = [...new Set(photoIds)];
    const pasted = named.filter((photoId) => photoId !== open.editing);
    this.db.transaction(() => {
      for (const photoId of pasted) {
        const current = this.get(photoId);
        this.edits.save(photoId, { ...current.doc, ...patch }, current.rev, session);
      }
    })();
    this.rebuildPasted(pasted, open.shown);
    return { pasted: pasted.length, editing_skipped: pasted.length < named.length };
  }

  conflicts(libraryId?: string): EditConflict[] {
    return listConflicts(this.db, libraryId);
  }

  /**
   * Takes one parked candidate, and rebuilds: unlike a slider release, this is a
   * decision, and the reader is looking at the grid rather than the editor.
   */
  resolve(photoId: string, sessionId: string): void {
    this.require(photoId);
    this.changed(resolveConflict(this.db, this.edits, photoId, sessionId, newId()));
    this.rebuild([photoId]);
  }

  private require(photoId: string): { library_id: string } {
    const photo = this.photoListing.getById(photoId);
    if (photo == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    return photo;
  }
}
