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
 * **Every write requeues both derived stages.** The grid tile and the viewer's
 * renditions are separate artefacts of the same pixels, so an edit invalidates
 * both, and requeuing only the renditions leaves the gallery showing the frame as
 * it was. Undo and redo requeue for the same reason: stepping back changes the
 * picture as surely as stepping forward did.
 *
 * Only when something actually moved. Every one of these answers with the state
 * whether or not it changed anything - a no-op save, an undo at the start of the
 * history - and requeuing on those would rebuild a frame that is already correct.
 * The revision is what says: it moves if and only if the document did.
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
    return this.rebuilt(photoId, rev, this.edits.save(photoId, doc, rev));
  }

  undo(photoId: string, rev: number): EditState {
    this.require(photoId);
    return this.rebuilt(photoId, rev, this.edits.undo(photoId, rev));
  }

  redo(photoId: string, rev: number): EditState {
    this.require(photoId);
    return this.rebuilt(photoId, rev, this.edits.redo(photoId, rev));
  }

  // The picture changed exactly when the revision did, so that is what this asks
  // rather than diffing two documents a second time.
  private rebuilt(photoId: string, was: number, state: EditState): EditState {
    if (state.rev !== was) this.rebuild([photoId]);
    return state;
  }

  private require(photoId: string): void {
    if (this.photos.getById(photoId) == null) {
      throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    }
  }
}
