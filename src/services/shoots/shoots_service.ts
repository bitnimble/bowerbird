import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../errors';
import { isUniqueViolation } from '../../db/constraints';
import type { CreateShootRequest, Shoot, UpdateShootRequest } from '../../schemas/shoots';
import type { Library } from '../../schemas/libraries';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { toLibraryRelative } from '../../utils/paths';
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

    let folderPath = request.name;
    if (request.parent_id) {
      const parent = this.shoots.getById(request.parent_id);
      if (!parent || parent.library_id !== library.id) {
        throw new AppError('VALIDATION_ERROR', `parent shoot not found in library: ${request.parent_id}`);
      }
      folderPath = `${parent.folder_path}/${request.name}`;
    }

    if (this.shoots.getByName(library.id, request.name)) {
      throw new AppError('CONFLICT', `shoot name already used in library: ${request.name}`);
    }

    const absFolder = path.join(library.root_path, folderPath);
    const existed = existsSync(absFolder);
    await ensureDir(absFolder);

    const id = randomUUID();
    try {
      this.shoots.insert({
        id,
        parent_id: request.parent_id ?? null,
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

  async update(shootId: string, updates: UpdateShootRequest): Promise<Shoot> {
    const shoot = this.get(shootId);

    if (updates.name != null && updates.name !== shoot.name) {
      await this.rename(shoot, updates.name);
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

  private async rename(shoot: Shoot, newName: string): Promise<void> {
    const library = this.requireLibrary(shoot.library_id);
    if (this.shoots.getByName(library.id, newName)) {
      throw new AppError('CONFLICT', `shoot name already used in library: ${newName}`);
    }

    const oldFolder = shoot.folder_path;
    const slash = oldFolder.lastIndexOf('/');
    const newFolder = (slash >= 0 ? oldFolder.slice(0, slash + 1) : '') + newName;
    // Taken here, not in update(), so it isn't acquired twice (that would deadlock).
    return libraryMutex.run(shoot.library_id, async () => {

    const oldAbs = path.join(library.root_path, oldFolder);
    const newAbs = path.join(library.root_path, newFolder);
    await this.move(oldAbs, newAbs);

    // Rewrite this shoot, descendant shoots, and contained photos to the new
    // prefix atomically (§8.5): a partial rewrite would break folder membership.
    // The fs move already happened; if the DB transaction throws (e.g. a
    // concurrent rename hits UNIQUE(library_id, name)), roll the folder back so
    // disk and DB stay consistent instead of leaving a shoot that points at a
    // nonexistent folder.
    try {
      this.shoots.transaction(() => {
        this.shoots.updateFields(shoot.id, { name: newName, folder_path: newFolder });
        for (const descendant of this.shoots.listByLibrary(library.id)) {
          if (descendant.folder_path.startsWith(`${oldFolder}/`)) {
            this.shoots.updateFields(descendant.id, { folder_path: newFolder + descendant.folder_path.slice(oldFolder.length) });
          }
        }
        // includeDeleted: soft-deleted photos live in <folder>/Bin and physically
        // move with the folder, so their file_path must be rewritten too.
        for (const photo of this.photos.listUnderFolder(library.id, oldFolder, true)) {
          // rewriteFilePath, not setFilePath: preserve is_missing, a folder rename
          // doesn't recreate a file for a photo that was already missing.
          this.photos.rewriteFilePath(photo.id, newFolder + photo.file_path.slice(oldFolder.length));
        }
      });
    } catch (err) {
      await rename(newAbs, oldAbs).catch((rollbackErr) =>
        console.error(`shoot rename rollback failed (${newAbs} -> ${oldAbs}): ${(rollbackErr as Error).message}`),
      );
      // getByName above catches the common case; a concurrent rename to the same
      // name can still pass it before either commits and hit UNIQUE here.
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', `shoot name already used in library: ${newName}`);
      throw err;
    }
    });
  }

  private adoptExistingPhotos(libraryId: string, shootId: string, folderPath: string): void {
    const shoots = this.shoots.listByLibrary(libraryId);
    for (const photo of this.photos.listUnderFolder(libraryId, folderPath)) {
      if (mostSpecificShoot(photo.file_path, shoots)?.id === shootId) {
        this.photos.setShoot(photo.id, shootId);
      }
    }
  }

  private async move(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (err) {
      throw new AppError('IO_ERROR', `failed to move ${from} -> ${to}: ${(err as Error).message}`);
    }
  }

  private requireLibrary(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }
}
