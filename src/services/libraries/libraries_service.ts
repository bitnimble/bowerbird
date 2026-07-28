import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../errors';
import { isUniqueViolation } from '../../db/constraints';
import type { CreateLibraryRequest, Library, UpdateLibraryRequest } from '../../schemas/libraries';
import { deleteDataDirectory } from '../../utils/deletions';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { containsPath, dataPathFor, getBinPath, getDataPath } from '../../utils/paths';
import { findOriginalsAnywhere } from '../../utils/scan';
import type { LibrariesRepository } from './libraries_repository';

export interface LibraryLifecycleListener {
  onLibraryCreated(library: Library): void;
  onLibraryDeleted(libraryId: string): void;
}

// Removing a library takes its generated files with it: renditions are keyed by
// photo id, and ids are minted per insert, so re-adding the same folder can
// never reuse them. Left behind they are dead weight nothing will ever claim.
//
// Nothing under a data directory is supposed to be an original - the Bin lives
// at the library root for exactly this reason (§12.3). Before an older layout's
// `<data_path>/bin` (or a `data_path` aimed at the user's photographs) is swept
// away with the rest, anything that IS an original is carried out to the Bin,
// where the sweep cannot reach it. `deleteDataDirectory` refuses the removal if
// that rescue left anything behind, so an unreadable stray costs the renditions
// rather than the photograph.
async function removeDataDirectory(library: Library): Promise<void> {
  const dataPath = getDataPath(library);
  if (containsPath(dataPath, library.root_path)) {
    console.warn(`not removing data directory for ${library.id}: ${dataPath} contains the library root`);
    return;
  }
  try {
    const strays = await findOriginalsAnywhere(dataPath);
    if (strays.length > 0) {
      const bin = getBinPath(library);
      await ensureDir(bin);
      for (const stray of strays) await moveIntoDir(stray, bin, path.basename(stray));
      console.warn(`moved ${strays.length} original file(s) out of ${dataPath} into ${bin} before removing it`);
    }
    await deleteDataDirectory(dataPath);
  } catch (err) {
    console.error(`failed to remove data directory ${dataPath}: ${(err as Error).message}`);
  }
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
    this.assertNoDataDirectoryOverlap(request.root_path, request.data_path ?? null);

    const library: Library = {
      id: randomUUID(),
      root_path: request.root_path,
      data_path: request.data_path ?? null,
      ordering: request.ordering,
      // Matching the column defaults: the embedded JPEG needs no demosaic, and
      // HDR is opt-in because it only applies to a render.
      preview_source: 'embedded',
      preview_hdr: false,
      preview_hdr_video: false,
      last_synced_at: null,
      photo_count: 0,
    };

    await ensureDir(getDataPath(library));

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

  // A data directory is disposable by design: removing its library deletes the
  // whole tree. That is only safe while no library's photographs live inside
  // another's, so both directions are refused here - a root under someone's data
  // directory, and a data directory that would swallow someone's root.
  private assertNoDataDirectoryOverlap(rootPath: string, dataPath: string | null): void {
    const mine = dataPathFor(rootPath, dataPath);
    for (const other of this.repo.list()) {
      const theirs = getDataPath(other);
      if (containsPath(theirs, rootPath)) {
        throw new AppError('VALIDATION_ERROR', `root_path is inside the data directory of library ${other.id}: ${theirs}`);
      }
      if (containsPath(mine, other.root_path)) {
        throw new AppError('VALIDATION_ERROR', `data_path would contain the root of library ${other.id}: ${other.root_path}`);
      }
    }
  }

  get(libraryId: string): Library {
    const library = this.repo.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }

  list(): Library[] {
    return this.repo.list();
  }

  // A partial update: the settings UI changes one control at a time, and every
  // field left out keeps its stored value. Changing a preview setting does not
  // touch existing photos - it is the default for what gets built next, and for
  // an explicit rebuild (§10.2).
  update(libraryId: string, updates: UpdateLibraryRequest): Library {
    if (this.repo.getById(libraryId) == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    if (updates.ordering != null) this.repo.setOrdering(libraryId, updates.ordering);
    if (updates.preview_source != null) this.repo.setPreviewSource(libraryId, updates.preview_source);
    if (updates.preview_hdr != null) this.repo.setPreviewHdr(libraryId, updates.preview_hdr);
    if (updates.preview_hdr_video != null) this.repo.setPreviewHdrVideo(libraryId, updates.preview_hdr_video);
    return this.get(libraryId);
  }

  async delete(libraryId: string): Promise<void> {
    // Read before the row goes: the data directory's location lives on it.
    const library = this.repo.getById(libraryId);
    if (!this.repo.delete(libraryId)) {
      throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    }
    for (const listener of this.listeners) listener.onLibraryDeleted(libraryId);
    if (library != null) await removeDataDirectory(library);
  }
}
