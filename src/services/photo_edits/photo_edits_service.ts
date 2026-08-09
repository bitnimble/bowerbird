import { AppError } from '../../errors';
import type { EditDoc, EditState } from '../../schemas/photo_edits';
import type { PhotosRepository } from '../photos/photos_repository';
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
    private readonly edits: PhotoEditsRepository,
    private readonly photos: PhotosRepository,
    /**
     * Queue both derived stages of these photos and start a drain.
     *
     * A seam rather than the processing service itself, defaulted so a test about the
     * edits is not also a test about the render queue - the same shape
     * `ProcessingService.editsFor` uses in the other direction. Nothing awaits it: a
     * rebuild is seconds of GPU work and this is called from a slider release.
     */
    private readonly rebuild: (photoIds: string[]) => void = () => {},
  ) {}

  get(photoId: string): EditState {
    this.require(photoId);
    return this.edits.get(photoId);
  }

  save(photoId: string, doc: EditDoc, rev: number): EditState {
    this.require(photoId);
    return this.edits.save(photoId, doc, rev);
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
   */
  finish(photoId: string): void {
    this.require(photoId);
    this.rebuild([photoId]);
  }

  private require(photoId: string): void {
    if (this.photos.getById(photoId) == null) {
      throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    }
  }
}
