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
 * **Nothing here requeues a rendition yet.** An edit that has been saved should
 * rebuild the grid tile and the viewer's renditions, and it deliberately does not
 * until the render pipeline's own rework lands - that work changes where an edit
 * would be applied, and wiring a requeue to the current shape would be building
 * against a path that is being replaced. The persistence is useful without it:
 * the editor reloads to what was saved.
 */
export class PhotoEditsService {
  constructor(
    private readonly edits: PhotoEditsRepository,
    private readonly photos: PhotosRepository,
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

  private require(photoId: string): void {
    if (this.photos.getById(photoId) == null) {
      throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    }
  }
}
