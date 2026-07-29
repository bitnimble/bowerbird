import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../errors';
import { isUniqueViolation } from '../../db/constraints';
import type { CreateShootRequest, Shoot, UpdateShootRequest } from '../../schemas/shoots';
import type { Library } from '../../schemas/libraries';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { containsPath, getDataPath, toLibraryRelative } from '../../utils/paths';
import { mostSpecificShoot } from '../../utils/shoots';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import { libraryMutex } from '../sync/library_mutex';
import type { PhotosRepository } from '../photos/photos_repository';
import type { ShootsRepository } from './shoots_repository';

export class ShootsService {
  constructor(
    private readonly shoots: ShootsRepository,
    private readonly photos: PhotosRepository,
    private readonly libraries: LibrariesRepository,
  ) {}

  async create(request: CreateShootRequest): Promise<Shoot> {
    const library = this.requireLibrary(request.library_id);

    const parentPath = request.parent_path.replace(/^\/+|\/+$/g, '');
    const folderPath = parentPath === '' ? request.name : `${parentPath}/${request.name}`;
    const absFolder = path.join(library.root_path, folderPath);
    if (!containsPath(library.root_path, absFolder)) {
      throw new AppError('VALIDATION_ERROR', `shoot folder is outside the library: ${folderPath}`);
    }
    // Everything under the data directory is disposable and goes with the
    // library when it is removed (§6), so a shoot there would be photographs
    // queued for deletion.
    if (containsPath(getDataPath(library), absFolder)) {
      throw new AppError('VALIDATION_ERROR', `shoot folder is inside the library's data directory: ${folderPath}`);
    }

    if (this.shoots.getByName(library.id, request.name)) {
      throw new AppError('CONFLICT', `shoot name already used in library: ${request.name}`);
    }

    // Read off the folder rather than taken from the request: the enclosing
    // shoot is a fact about where this one sits, and the same rule decides which
    // shoot a photo belongs to (§9.4), so the two cannot drift apart.
    const parent = mostSpecificShoot(folderPath, this.shoots.listByLibrary(library.id));

    const existed = existsSync(absFolder);
    await ensureDir(absFolder);

    const id = randomUUID();
    try {
      this.shoots.insert({
        id,
        parent_id: parent?.id ?? null,
        library_id: library.id,
        folder_path: folderPath,
        name: request.name,
        description: request.description ?? null,
        ordering: request.ordering,
      });
    } catch (err) {
      // getByName above catches the common case; a concurrent create with the
      // same name can still pass it before either commits and lose the race here.
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', `shoot name already used in library: ${request.name}`);
      throw err;
    }

    if (existed) this.adoptExistingPhotos(library.id, id, folderPath);

    return this.get(id);
  }

  get(shootId: string): Shoot {
    const shoot = this.shoots.getById(shootId);
    if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);
    return shoot;
  }

  list(libraryId: string): Shoot[] {
    return this.shoots.listByLibrary(libraryId);
  }

  async addPhotos(shootId: string, photoIds: string[]): Promise<void> {
    const shoot = this.get(shootId);
    const library = this.requireLibrary(shoot.library_id);
    const destDir = path.join(library.root_path, shoot.folder_path);
    const photos = this.photos.getBasicByIds(photoIds);
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
    await ensureDir(destDir);

    // Queue behind any in-flight sync of this library: these moves would otherwise
    // invalidate its mid-scan snapshot.
    await libraryMutex.run(shoot.library_id, async () => {
    for (const photo of photos) {
      const from = path.join(library.root_path, photo.file_path);
      const naturalDest = path.join(destDir, path.basename(photo.file_path));
      // Already sitting in this folder: just set membership, never move (which
      // would collide the file with itself and grow a "_1" suffix each call).
      if (path.resolve(from) === path.resolve(naturalDest)) {
        if (photo.shoot_id !== shootId) {
          this.requireShootExists(shootId); // no await before the FK write -> race-tight
          this.photos.setShoot(photo.id, shootId);
        }
        continue;
      }
      const dest = await moveIntoDir(from, destDir, path.basename(photo.file_path));
      const relDest = toLibraryRelative(library.root_path, dest);
      // The shoot can be deleted during the (awaited) move; writing shoot_id then
      // hits the FK (raw 500). Re-check with no await before the write. The file
      // already moved, so record its new path to keep the DB consistent with disk.
      if (!this.shoots.getById(shootId)) {
        this.photos.setFilePath(photo.id, relDest);
        throw new AppError('CONFLICT', `shoot was deleted during the operation: ${shootId}`);
      }
      this.photos.setFilePathAndShoot(photo.id, relDest, shootId);
    }
    });
  }

  private requireShootExists(shootId: string): void {
    if (!this.shoots.getById(shootId)) throw new AppError('CONFLICT', `shoot was deleted during the operation: ${shootId}`);
  }

  async removePhotos(shootId: string, photoIds: string[]): Promise<void> {
    const shoot = this.get(shootId);
    const library = this.requireLibrary(shoot.library_id);

    await libraryMutex.run(shoot.library_id, async () => {
    for (const photo of this.photos.getBasicByIds(photoIds)) {
      if (photo.shoot_id !== shootId || photo.library_id !== shoot.library_id) continue;
      const from = path.join(library.root_path, photo.file_path);
      const dest = await moveIntoDir(from, library.root_path, path.basename(photo.file_path));
      this.photos.setFilePathAndShoot(photo.id, toLibraryRelative(library.root_path, dest), null);
    }
    });
  }

  delete(shootId: string): void {
    if (!this.shoots.delete(shootId)) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);
  }

  // A shoot's name is a label, not its folder: renaming one touches nothing on
  // disk. The folder is chosen once, at create, and keeps whatever name it has; // which also means a shoot can be named freely without reshuffling a catalogue,
  // and that a folder renamed outside the app is a mismatch to repair rather than
  // a rename to mirror.
  async update(shootId: string, updates: UpdateShootRequest): Promise<Shoot> {
    const shoot = this.get(shootId);

    if (updates.name != null && updates.name !== shoot.name) {
      if (this.shoots.getByName(shoot.library_id, updates.name)) {
        throw new AppError('CONFLICT', `shoot name already used in library: ${updates.name}`);
      }
      try {
        this.shoots.updateFields(shootId, { name: updates.name });
      } catch (err) {
        // getByName above catches the common case; a concurrent rename to the same
        // name can still pass it before either commits and hit UNIQUE here.
        if (isUniqueViolation(err)) throw new AppError('CONFLICT', `shoot name already used in library: ${updates.name}`);
        throw err;
      }
    }
    this.shoots.updateFields(shootId, { description: updates.description, ordering: updates.ordering });
    if ('banner_photo_id' in updates) {
      const bannerId = updates.banner_photo_id ?? null;
      if (bannerId != null) {
        // Validate up front: the banner FK would otherwise surface as a raw 500.
        const [photo] = this.photos.getBasicByIds([bannerId]);
        if (!photo) throw new AppError('VALIDATION_ERROR', `banner photo not found: ${bannerId}`);
        if (photo.library_id !== shoot.library_id) {
          throw new AppError('VALIDATION_ERROR', `banner photo is not in this shoot's library: ${bannerId}`);
        }
      }
      this.shoots.setBanner(shootId, bannerId);
    }

    return this.get(shootId);
  }

  private adoptExistingPhotos(libraryId: string, shootId: string, folderPath: string): void {
    const shoots = this.shoots.listByLibrary(libraryId);
    for (const photo of this.photos.listUnderFolder(libraryId, folderPath)) {
      if (mostSpecificShoot(photo.file_path, shoots)?.id === shootId) {
        this.photos.setShoot(photo.id, shootId);
      }
    }
  }

  private requireLibrary(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }
}
