import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../errors';
import type { CreateLibraryRequest, Library } from '../../schemas/libraries';
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
    };

    const dataPath = getDataPath(library);
    try {
      await mkdir(path.join(dataPath, 'thumbnails', 'small'), { recursive: true });
      await mkdir(path.join(dataPath, 'thumbnails', 'full'), { recursive: true });
      await mkdir(path.join(dataPath, 'bin'), { recursive: true });
    } catch (err) {
      throw new AppError('IO_ERROR', `failed to create data directory at ${dataPath}: ${(err as Error).message}`);
    }

    this.repo.insert(library);
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

  delete(libraryId: string): void {
    if (!this.repo.delete(libraryId)) {
      throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    }
    for (const listener of this.listeners) listener.onLibraryDeleted(libraryId);
  }
}
