import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../errors';
import { isUniqueViolation } from '../../db/constraints';
import { Logger } from '../../logger';
import type { CreateLibraryRequest, Library, UpdateLibraryRequest } from '../../schemas/libraries';
import { deleteDataDirectory } from '../../utils/deletions';
import { ensureDir, moveIntoDir } from '../../utils/files';
import { containsPath, dataPathFor, getBinPath, getDataPath } from '../../utils/paths';
import { findOriginalsAnywhere } from '../../utils/scan';
import type { LibrariesRepository } from './libraries_repository';

const log = new Logger('libraries');

export interface LibraryLifecycleListener {
  onLibraryCreated(library: Library): void;
  onLibraryDeleted(libraryId: string): void;
  /** For listeners holding something derived from the library's settings. */
  onLibraryUpdated?(library: Library): void;
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
    log.warn('keeping the data directory: it contains the library root', { library: library.id, dataPath });
    return;
  }
  try {
    const strays = await findOriginalsAnywhere(dataPath);
    if (strays.length > 0) {
      const bin = getBinPath(library);
      await ensureDir(bin);
      for (const stray of strays) await moveIntoDir(stray, bin, path.basename(stray));
      log.warn('rescued originals from the data directory before removing it', { originals: strays.length, dataPath, bin });
    }
    await deleteDataDirectory(dataPath);
  } catch (err) {
    log.error('could not remove the data directory', { dataPath, err });
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
      name: request.name == null || request.name === '' ? null : request.name,
      ordering: request.ordering,
      // Matching the column defaults: the embedded JPEG needs no demosaic, and
      // HDR is opt-in because it only applies to a render.
      rendition_source: 'embedded',
      rendition_hdr: false,
      rendition_hdr_video: false,
      include_subfolders: request.include_subfolders,
      // A shoot is a subfolder, so mirroring folders the scan will never reach
      // would only ever produce nothing (§4.1).
      mirror_shoots: request.include_subfolders && request.mirror_shoots,
      // Matching the column defaults again (§19.2): stacking is on, at the
      // threshold and window the labelled folder settled on.
      auto_stack: true,
      auto_stack_similarity: 0.78,
      auto_stack_window_seconds: 60,
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
    log.info('library created', { library: library.id, root: library.root_path, data: getDataPath(library) });
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
  // field left out keeps its stored value. Changing a rendition setting does not
  // touch existing photos - it is the default for what gets built next, and for
  // an explicit rebuild (§10.2).
  update(libraryId: string, updates: UpdateLibraryRequest): Library {
    const current = this.repo.getById(libraryId);
    if (current == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    if (updates.name != null) this.repo.setName(libraryId, updates.name === '' ? null : updates.name);
    if (updates.ordering != null) this.repo.setOrdering(libraryId, updates.ordering);
    if (updates.rendition_source != null) this.repo.setRenditionSource(libraryId, updates.rendition_source);
    if (updates.rendition_hdr != null) this.repo.setRenditionHdr(libraryId, updates.rendition_hdr);
    if (updates.rendition_hdr_video != null) this.repo.setRenditionHdrVideo(libraryId, updates.rendition_hdr_video);
    if (updates.include_subfolders != null) this.repo.setIncludeSubfolders(libraryId, updates.include_subfolders);
    // Mirroring folders the scan will never reach produces nothing, so the two
    // settings cannot be left disagreeing - whichever of them this request moved.
    const includeSubfolders = updates.include_subfolders ?? current.include_subfolders;
    const mirror = updates.mirror_shoots ?? current.mirror_shoots;
    if (mirror !== current.mirror_shoots || !includeSubfolders) {
      this.repo.setMirrorShoots(libraryId, includeSubfolders && mirror);
    }
    if (updates.auto_stack != null) this.repo.setAutoStack(libraryId, updates.auto_stack);
    if (updates.auto_stack_similarity != null) this.repo.setAutoStackSimilarity(libraryId, updates.auto_stack_similarity);
    if (updates.auto_stack_window_seconds != null) this.repo.setAutoStackWindow(libraryId, updates.auto_stack_window_seconds);
    const updated = this.get(libraryId);
    // The watcher holds a scope built from these, so an excluded folder would
    // otherwise keep waking syncs until a restart.
    for (const listener of this.listeners) listener.onLibraryUpdated?.(updated);
    return updated;
  }

  async delete(libraryId: string): Promise<void> {
    // Read before the row goes: the data directory's location lives on it.
    const library = this.repo.getById(libraryId);
    if (!this.repo.delete(libraryId)) {
      throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    }
    log.info('library deleted', { library: libraryId, root: library?.root_path });
    for (const listener of this.listeners) listener.onLibraryDeleted(libraryId);
    if (library != null) await removeDataDirectory(library);
  }
}
