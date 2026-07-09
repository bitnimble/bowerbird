import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../errors';
import type { CreateShootRequest, Shoot, UpdateShootRequest } from '../../schemas/shoots';
import type { Library } from '../../schemas/libraries';
import { moveIntoDir } from '../../utils/files';
import { toLibraryRelative } from '../../utils/paths';
import { mostSpecificShoot } from '../../utils/shoots';
import type { LibrariesRepository } from '../libraries/libraries_repository';
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
    await this.ensureDir(absFolder);

    const id = randomUUID();
    this.shoots.insert({
      id,
      parent_id: request.parent_id ?? null,
      library_id: library.id,
      folder_path: folderPath,
      name: request.name,
      description: request.description ?? null,
      ordering: request.ordering,
    });

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
    await this.ensureDir(destDir);

    for (const photo of this.photos.getBasicByIds(photoIds)) {
      const from = path.join(library.root_path, photo.file_path);
      const naturalDest = path.join(destDir, path.basename(photo.file_path));
      // Already sitting in this folder: just set membership, never move (which
      // would collide the file with itself and grow a "_1" suffix each call).
      if (path.resolve(from) === path.resolve(naturalDest)) {
        if (photo.shoot_id !== shootId) this.photos.setShoot(photo.id, shootId);
        continue;
      }
      const dest = await this.moveInto(from, destDir, path.basename(photo.file_path));
      this.photos.setFilePathAndShoot(photo.id, toLibraryRelative(library.root_path, dest), shootId);
    }
  }

  async removePhotos(shootId: string, photoIds: string[]): Promise<void> {
    const shoot = this.get(shootId);
    const library = this.requireLibrary(shoot.library_id);

    for (const photo of this.photos.getBasicByIds(photoIds)) {
      if (photo.shoot_id !== shootId) continue;
      const from = path.join(library.root_path, photo.file_path);
      const dest = await this.moveInto(from, library.root_path, path.basename(photo.file_path));
      this.photos.setFilePathAndShoot(photo.id, toLibraryRelative(library.root_path, dest), null);
    }
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
    if ('banner_photo_id' in updates) this.shoots.setBanner(shootId, updates.banner_photo_id ?? null);

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
        for (const photo of this.photos.listUnderFolder(library.id, oldFolder)) {
          this.photos.setFilePath(photo.id, newFolder + photo.file_path.slice(oldFolder.length));
        }
      });
    } catch (err) {
      await rename(newAbs, oldAbs).catch(() => {});
      throw err;
    }
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

  private async moveInto(from: string, dir: string, filename: string): Promise<string> {
    try {
      return await moveIntoDir(from, dir, filename);
    } catch (err) {
      throw new AppError('IO_ERROR', `failed to move ${from} into ${dir}: ${(err as Error).message}`);
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      throw new AppError('IO_ERROR', `failed to create directory ${dir}: ${(err as Error).message}`);
    }
  }

  private requireLibrary(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }
}
