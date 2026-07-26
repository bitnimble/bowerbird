import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../errors';
import { isUniqueViolation } from '../../db/constraints';
import type { CreateLibraryRequest, Library, UpdateLibraryRequest } from '../../schemas/libraries';
import { ensureDir } from '../../utils/files';
import { getDataPath } from '../../utils/paths';
import type { LibrariesRepository } from './libraries_repository';

export interface LibraryLifecycleListener {
  onLibraryCreated(library: Library): void;
  onLibraryDeleted(libraryId: string): void;
}

export class LibrariesService {
  private readonly listeners: LibraryLifecycleListener[] = [];

  constructor(private readonly repo: LibrariesRepository) {}

  addLifecycleListener(listener: LibraryLifecycleListener): void {
    this.listeners.push(listener);
  }

  async create(request: CreateLibraryRequest): Promise<Library> {
    if (!existsSync(request.root_path) || !statSync(request.root_path).isDirectory()) {
      throw new AppError('VALIDATION_ERROR', `root_path does not exist or is not a directory: ${request.root_path}`);
    }
    if (this.repo.getByRootPath(request.root_path)) {
      throw new AppError('CONFLICT', `library root already registered: ${request.root_path}`);
    }

    const library: Library = {
      id: randomUUID(),
      root_path: request.root_path,
      data_path: request.data_path ?? null,
      ordering: request.ordering,
      last_synced_at: null,
      photo_count: 0,
    };

    const dataPath = getDataPath(library);
    await ensureDir(path.join(dataPath, 'thumbnails', 'small'));
    await ensureDir(path.join(dataPath, 'thumbnails', 'full'));
    await ensureDir(path.join(dataPath, 'bin'));

    try {
      this.repo.insert(library);
    } catch (err) {
      // getByRootPath above catches the common case; a concurrent create with the
      // same root_path can still pass it before either commits and hit UNIQUE here.
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', `library root already registered: ${request.root_path}`);
      throw err;
    }
    for (const listener of this.listeners) listener.onLibraryCreated(library);
    return library;
  }

  get(libraryId: string): Library {
    const library = this.repo.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }

  list(): Library[] {
    return this.repo.list();
  }

  update(libraryId: string, updates: UpdateLibraryRequest): Library {
    if (!this.repo.setOrdering(libraryId, updates.ordering)) {
      throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    }
    return this.get(libraryId);
  }

  delete(libraryId: string): void {
    if (!this.repo.delete(libraryId)) {
      throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    }
    for (const listener of this.listeners) listener.onLibraryDeleted(libraryId);
  }
}
