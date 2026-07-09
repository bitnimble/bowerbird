import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import { getDataPath } from '../../utils/paths';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../libraries/libraries_service';
import type { SyncService } from './sync_service';

type Timer = ReturnType<typeof setTimeout>;

// Watches each library root and triggers a debounced sync when its files change
// on disk. Reactive counterpart to the on-demand POST /sync (DESIGN §9). Change
// detection stays with sync; the watcher only decides *when* to run it.
export class LibraryWatcher implements LibraryLifecycleListener {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, Timer>();
  private readonly syncing = new Set<string>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly libraries: LibrariesRepository,
    private readonly sync: SyncService,
    private readonly debounceMs: number,
  ) {}

  start(): void {
    for (const library of this.libraries.list()) this.watchLibrary(library);
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.timers.clear();
  }

  onLibraryCreated(library: Library): void {
    this.watchLibrary(library);
  }

  onLibraryDeleted(libraryId: string): void {
    this.watchers.get(libraryId)?.close();
    this.watchers.delete(libraryId);
    const timer = this.timers.get(libraryId);
    if (timer) clearTimeout(timer);
    this.timers.delete(libraryId);
  }

  private watchLibrary(library: Library): void {
    if (this.watchers.has(library.id)) return;
    const dataDir = path.resolve(getDataPath(library));
    try {
      const watcher = watch(library.root_path, { recursive: true }, (_event, filename) => {
        if (filename != null && this.isRelevant(library.root_path, dataDir, filename.toString())) {
          this.schedule(library.id);
        }
      });
      watcher.on('error', (err) => console.error(`watcher error for library ${library.id}: ${err.message}`));
      this.watchers.set(library.id, watcher);
    } catch (err) {
      console.error(`could not watch library ${library.id} (${library.root_path}): ${(err as Error).message}`);
    }
  }

  // Ignore the data dir (thumbnails/bin, where processing writes, so watching it
  // would loop), Bin folders, and hidden entries (incl. the sync lock file).
  private isRelevant(rootPath: string, dataDir: string, filename: string): boolean {
    const segments = filename.split(path.sep).join('/').split('/');
    if (segments.some((s) => s.startsWith('.') || s === 'Bin')) return false;
    const abs = path.resolve(rootPath, filename);
    return abs !== dataDir && !abs.startsWith(`${dataDir}${path.sep}`);
  }

  private schedule(libraryId: string): void {
    const existing = this.timers.get(libraryId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      libraryId,
      setTimeout(() => void this.run(libraryId), this.debounceMs),
    );
  }

  private async run(libraryId: string): Promise<void> {
    this.timers.delete(libraryId);
    if (this.syncing.has(libraryId)) {
      this.dirty.add(libraryId); // change arrived mid-sync: re-run afterwards
      return;
    }
    this.syncing.add(libraryId);
    try {
      await this.sync.syncLibrary(libraryId);
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'SYNC_IN_PROGRESS')) {
        console.error(`auto-sync failed for library ${libraryId}: ${(err as Error).message}`);
      }
    } finally {
      this.syncing.delete(libraryId);
      if (this.dirty.delete(libraryId)) this.schedule(libraryId);
    }
  }
}
