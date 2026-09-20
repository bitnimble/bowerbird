import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { isUniqueViolation, withNewId } from '../../db/constraints';
import type { CreateShootRequest, Shoot, UpdateShootRequest } from '../../schemas/shoots';
import type { Library } from '../../schemas/libraries';
import { soleInputOf } from '../../schemas/recipes';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { containsPath, toLibraryRelative } from '../../utils/paths';
import { isDirInScope, libraryScope, type LibraryScope } from '../../utils/scope';
import { mostSpecificShoot } from '../../utils/shoots';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import { deleteGeneratedFilesFor } from '../maintenance/prune_service';
import { libraryMutex } from '../sync/coordination/library_mutex';
import type { PhotoStateRepository } from '../photos/mutations/photo_state_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../photos/paths/photo_paths_repository';
import type { FolderRulesRepository } from './folder_rules_repository';
import type { ShootsRepository } from './shoots_repository';

export class ShootsService {
  constructor(
    private readonly shoots: ShootsRepository,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoState: PhotoStateRepository,
    private readonly libraries: LibrariesRepository,
    private readonly folderRules: FolderRulesRepository,
  ) {}

  async create(request: CreateShootRequest): Promise<Shoot> {
    const library = this.requireLibrary(request.library_id);

    const parentPath = request.parent_path.replace(/^\/+|\/+$/g, '');
    const absFolder = path.join(library.root_path, parentPath, request.name);
    if (!containsPath(library.root_path, absFolder)) {
      throw new AppError('VALIDATION_ERROR', `shoot folder is outside the library: ${parentPath}/${request.name}`);
    }
    // Derived from the resolved path rather than pasted together from the
    // request, so `./Trip` and `Trip//` cannot store a folder_path that never
    // matches the folder actually created, leaving a shoot no photo can join.
    const folderPath = toLibraryRelative(library.root_path, absFolder);

    // A folder the scan will never look at cannot hold a shoot: the bin, a
    // dotfolder or one the user has excluded. Its photos would be moved in and
    // then never seen again.
    if (!isDirInScope(this.scopeFor(library), folderPath)) {
      throw new AppError('VALIDATION_ERROR', `folder is not part of this library: ${folderPath}`);
    }

    if (this.shoots.getByFolderPath(library.id, folderPath)) {
      throw new AppError('CONFLICT', `a shoot already covers this folder: ${folderPath}`);
    }

    // Read off the folder rather than taken from the request: the enclosing
    // shoot is a fact about where this one sits, and the same rule decides which
    // shoot a photo belongs to (§9.4), so the two cannot drift apart.
    const parent = mostSpecificShoot(folderPath, this.shoots.listByLibrary(library.id));

    // A shoot *is* a folder and membership is decided by the folder a file sits
    // in (§9.4), so a read-only library can only take the folders that are already
    // there. Mirroring already makes a shoot per folder holding photographs, so
    // most exist before anyone asks.
    const existed = existsSync(absFolder);
    if (!existed && library.read_only) {
      throw new AppError('READ_ONLY', `${library.name} is read-only; a shoot there has to be a folder that already exists`);
    }
    await ensureDir(absFolder);
    // From the moment the shoot exists rather than from its first scan, so a
    // rename before then is still followed (§9.4.1).
    const identity = statSync(absFolder, { throwIfNoEntry: false });

    let id: string;
    try {
      id = withNewId((candidate) =>
        this.shoots.insert({
          id: candidate,
          parent_id: parent?.id ?? null,
          library_id: library.id,
          folder_path: folderPath,
          name: request.name,
          description: request.description ?? null,
          ordering: request.ordering,
          folder_dev: identity?.dev ?? null,
          folder_ino: identity?.ino ?? null,
          folder_birthtime: identity?.birthtimeMs ?? null,
        }),
      );
    } catch (err) {
      // getByFolderPath above catches the common case; a concurrent create of the
      // same folder can still pass it before either commits and lose the race here.
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', `a shoot already covers this folder: ${folderPath}`);
      throw err;
    }

    // The user is answering the same question again, the other way: this folder
    // is a shoot after all, whether it was excluded or merely kept plain (§4.7).
    this.folderRules.clear(library.id, folderPath);

    if (existed) this.adoptExistingPhotos(library.id, id, folderPath);

    return this.get(id);
  }

  get(shootId: string): Shoot {
    const shoot = this.shoots.getById(shootId);
    if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);
    return shoot;
  }

  // The shoots put away are left out unless they are asked for (§12.4), so nothing downstream has to
  // remember to filter them: a sidebar, a "move to shoot" menu and a tree all get the shoots a reader
  // is working with, and only the page that offers to show the hidden ones ever asks. Resolving one
  // *by id* is a different question and is always answered - `get` knows nothing about hiding.
  list(libraryId: string, includeHidden = false): Shoot[] {
    return this.shoots.listByLibrary(libraryId, includeHidden);
  }

  /** The folders of the shoots put away, for the folder tree to drop along with them. */
  hiddenFolders(libraryId: string): string[] {
    return this.shoots.hiddenFolders(libraryId);
  }

  async addPhotos(shootId: string, photoIds: string[]): Promise<void> {
    const shoot = this.get(shootId);
    const library = this.requireLibrary(shoot.library_id);
    const destDir = path.join(library.root_path, shoot.folder_path);
    const photos = this.photoPaths.getBasicByIds(photoIds);
    // Validate up front so a cross-library or unknown id can't leave a
    // partially-applied batch (each move commits before the next runs). Reject
    // unknown/soft-deleted ids rather than silently dropping them (matches albums).
    const found = new Set(photos.map((p) => p.id));
    const missing = photoIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new AppError('VALIDATION_ERROR', `photos not found: ${missing.join(', ')}`);
    for (const photo of photos) {
      if (photo.library_id !== shoot.library_id) {
        throw new AppError('VALIDATION_ERROR', `photo ${photo.id} is not in this shoot's library`);
      }
    }
    // "Add these photographs to that shoot" *is* a file move (§8.5), so it is not
    // something a read-only library can do. Albums are the grouping that needs no
    // write. Before `ensureDir`, which runs outside the mutex.
    if (library.read_only) {
      throw new AppError('READ_ONLY', `${library.name} is read-only; use an album to group photographs instead`);
    }
    await ensureDir(destDir);

    // Queue behind any in-flight sync of this library: these moves would otherwise
    // invalidate its mid-scan snapshot.
    await libraryMutex.run(shoot.library_id, async () => {
    for (const photo of photos) {
      const was = soleInputOf(photo.recipe);
      // A shoot is a folder, and a row with no file of its own is in no folder: it joins by
      // membership alone, which is the same branch a photograph already sitting here takes.
      if (was == null) {
        this.joinShoot(photo, shootId);
        continue;
      }
      const from = path.join(library.root_path, was);
      const naturalDest = path.join(destDir, path.basename(was));
      // Already sitting in this folder: just set membership, never move (which
      // would collide the file with itself and grow a "_1" suffix each call).
      if (path.resolve(from) === path.resolve(naturalDest)) {
        this.joinShoot(photo, shootId);
        continue;
      }
      const dest = await moveIntoDir(from, destDir, path.basename(was));
      const relDest = toLibraryRelative(library.root_path, dest);
      // The shoot can be deleted during the (awaited) move; writing shoot_id then
      // hits the FK (raw 500). Re-check with no await before the write. The file
      // already moved, so record its new path to keep the DB consistent with disk.
      if (!this.shoots.getById(shootId)) {
        this.photoPaths.setFilePath(photo.id, relDest);
        throw new AppError('CONFLICT', `shoot was deleted during the operation: ${shootId}`);
      }
      this.photoPaths.setFilePathAndShoot(photo.id, relDest, shootId);
    }
    });
  }

  // Membership without a move: a row already in the folder, or one with no file to move at all.
  private joinShoot(photo: BasicPhoto, shootId: string): void {
    if (photo.shoot_id === shootId) return;
    this.requireShootExists(shootId); // no await before the FK write -> race-tight
    this.photoPaths.setShoot(photo.id, shootId);
  }

  private requireShootExists(shootId: string): void {
    if (!this.shoots.getById(shootId)) throw new AppError('CONFLICT', `shoot was deleted during the operation: ${shootId}`);
  }

  async removePhotos(shootId: string, photoIds: string[]): Promise<void> {
    const shoot = this.get(shootId);
    const library = this.requireLibrary(shoot.library_id);
    if (library.read_only) {
      throw new AppError('READ_ONLY', `${library.name} is read-only; use an album to group photographs instead`);
    }

    await libraryMutex.run(shoot.library_id, async () => {
    for (const photo of this.photoPaths.getBasicByIds(photoIds)) {
      if (photo.shoot_id !== shootId || photo.library_id !== shoot.library_id) continue;
      const was = soleInputOf(photo.recipe);
      // Nothing to move back to the root, so leaving the shoot is the membership alone.
      if (was == null) {
        this.photoPaths.setShoot(photo.id, null);
        continue;
      }
      const from = path.join(library.root_path, was);
      const dest = await moveIntoDir(from, library.root_path, path.basename(was));
      this.photoPaths.setFilePathAndShoot(photo.id, toLibraryRelative(library.root_path, dest), null);
    }
    });
  }

  // What becomes of the photographs is asked rather than assumed, because one
  // answer is reversible and the other is not. Neither touches a file on disk.
  //
  // Both write a folder rule (§4.7), and they have to: without one, mirroring
  // recreates the shoot on the next sync and the delete reads as broken.
  // What deleting this shoot with `photos: 'remove'` would take, answered with
  // the same query the delete runs so the dialog cannot promise a smaller number
  // than the one about to be true.
  removalCount(shootId: string): number {
    const shoot = this.get(shootId);
    return this.photoPaths.listUnderFolder(shoot.library_id, shoot.folder_path, true).length;
  }

  // Queued behind any in-flight sync (§9.9), which read the folder rules before it
  // started scanning: a delete landing mid-scan would be invisible to it, and it
  // would mirror the folder straight back into a shoot moments after the delete
  // returned. The `remove` half needs the same fence for a harder reason - that
  // sync can insert a photo pointing at the shoot this is about to delete.
  async delete(shootId: string, photos: 'keep' | 'remove'): Promise<void> {
    const shoot = this.shoots.getById(shootId);
    if (shoot == null) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);
    const library = this.requireLibrary(shoot.library_id);

    await libraryMutex.run(library.id, async () => {
      // Re-read inside the fence: the shoot may have gone while this queued.
      if (!this.shoots.getById(shootId)) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);

      if (photos === 'keep') {
        this.shoots.transaction(() => {
          this.folderRules.set(library.id, shoot.folder_path, 'plain');
          // Descendants are re-parented out of the way first: parent_id carries
          // ON DELETE CASCADE, so they would otherwise go with this shoot - and
          // then come back on the next sync as fresh mirrored shoots with default
          // names and no description, banner or ordering. This delete is about one
          // folder, and it says so on the dialog.
          this.shoots.reparentChildren(shootId);
          this.shoots.delete(shootId); // shoot_id clears via ON DELETE SET NULL
        });
        return;
      }

      // Soft-deleted rows go too: what leaves is the catalogue's record of the
      // folder, and a binned photo is one of that folder's records. Their files
      // stay in the bin exactly as the live ones stay where they are - this
      // removes rows, never files (§4.7) - and the rule written beside them is what
      // keeps the next scan from importing those files back: the bin is walked
      // without the exclusions, so it is the *restore* path that is tested.
      const doomed = this.photoPaths.listUnderFolder(library.id, shoot.folder_path, true);
      this.shoots.transaction(() => {
        this.folderRules.set(library.id, shoot.folder_path, 'excluded');
        this.photoPaths.deleteByIds(doomed.map((p) => p.id));
        this.shoots.delete(shootId);
      });
      // After the rows, so a failure here leaves files the sweep still reaps
      // rather than renditions whose photos are alive.
      await deleteGeneratedFilesFor(library, doomed.map((p) => p.id));
    });
  }

  // A shoot's name is a label, not its folder: renaming one touches nothing on
  // disk, and cannot collide, since a shoot is identified by its folder (§4.3).
  // A folder renamed outside the app is the other direction, and is followed
  // rather than repaired (§9.4.1).
  async update(shootId: string, updates: UpdateShootRequest): Promise<Shoot> {
    const shoot = this.get(shootId);

    this.shoots.updateFields(shootId, {
      name: updates.name,
      description: updates.description,
      ordering: updates.ordering,
    });
    if ('banner_photo_id' in updates) {
      const bannerId = updates.banner_photo_id ?? null;
      if (bannerId != null) {
        // Validate up front: the banner FK would otherwise surface as a raw 500.
        const [photo] = this.photoPaths.getBasicByIds([bannerId]);
        if (!photo) throw new AppError('VALIDATION_ERROR', `banner photo not found: ${bannerId}`);
        if (photo.library_id !== shoot.library_id) {
          throw new AppError('VALIDATION_ERROR', `banner photo is not in this shoot's library: ${bannerId}`);
        }
      }
      this.shoots.setBanner(shootId, bannerId);
    }
    if (updates.is_hidden != null) {
      this.shoots.setHidden(shootId, updates.is_hidden);
      // The photographs under it did not move, so the stacks among them are still flagged on members
      // that just left every listing - or rejoined one (§12.4).
      this.photoState.refreshStacksUnderShoot(shootId);
    }

    return this.get(shootId);
  }

  private adoptExistingPhotos(libraryId: string, shootId: string, folderPath: string): void {
    const shoots = this.shoots.listByLibrary(libraryId);
    for (const photo of this.photoPaths.listUnderFolder(libraryId, folderPath)) {
      const was = soleInputOf(photo.recipe);
      // `listUnderFolder` answers for rows whose every input is under the folder, so only a row
      // that is one file can be claimed by the folder its file is in.
      if (was != null && mostSpecificShoot(was, shoots)?.id === shootId) {
        this.photoPaths.setShoot(photo.id, shootId);
      }
    }
  }

  private scopeFor(library: Library): LibraryScope {
    return libraryScope(library, this.folderRules.pathsWithRule(library.id, 'excluded'));
  }

  private requireLibrary(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }
}
