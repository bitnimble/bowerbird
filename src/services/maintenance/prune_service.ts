import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getDataPath } from '../../utils/paths';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotosRepository } from '../photos/photos_repository';

// Directories of files named `<photoId>.<ext>`, relative to a library's data
// directory. Everything else under there (the Bin, the sync lock) is keyed by
// something other than a photo id and must not be touched.
const GENERATED_DIRS = ['thumbnails/small', 'thumbnails/full', 'lossless'];

export interface PruneResult {
  removed: number;
  bytes: number;
}

// Deletes generated files whose photo no longer exists. Nothing else in the
// system does: thumbnails are written by processing and rewritten in place, so
// the only way one is left behind is for its row to vanish underneath it, which
// happens when a catalogue is rebuilt (ids are minted per insert, so the same
// files come back with new ones).
export class PruneService {
  constructor(
    private readonly libraries: LibrariesRepository,
    private readonly photos: PhotosRepository,
  ) {}

  async prune(): Promise<PruneResult> {
    // One id set for every library: a file is named by photo id alone, and ids
    // are global, so a per-library set could delete a file that legitimately
    // belongs to another library sharing a data directory.
    const live = new Set(this.photos.allIds());
    let removed = 0;
    let bytes = 0;

    for (const library of this.libraries.list()) {
      for (const dir of GENERATED_DIRS) {
        const full = path.join(getDataPath(library), dir);
        let files: string[];
        try {
          files = await readdir(full);
        } catch {
          continue; // never created, or the whole data directory is gone
        }
        for (const file of files) {
          const id = file.replace(/\.[^.]+$/, '');
          if (live.has(id)) continue;
          const target = path.join(full, file);
          try {
            bytes += (await stat(target)).size;
            await unlink(target);
            removed++;
          } catch (err) {
            // A concurrent processing run may have just replaced it. Skip and
            // let the next sweep decide.
            console.error(`prune could not remove ${target}: ${(err as Error).message}`);
          }
        }
      }
    }

    return { removed, bytes };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Runs the sweep on a fixed interval. Not at startup: a restart is not evidence
// that anything was orphaned, and in development that would mean sweeping on
// every reload. Disabled when `everyDays` is 0.
export class ScheduledPrune {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prune: PruneService,
    private readonly everyDays: number,
  ) {}

  start(): void {
    if (!(this.everyDays > 0) || this.timer != null) return;
    this.timer = setInterval(() => void this.fire(), this.everyDays * DAY_MS);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async fire(): Promise<void> {
    if (this.running) return; // a sweep of a huge library could outlast the interval
    this.running = true;
    try {
      const { removed, bytes } = await this.prune.prune();
      if (removed > 0) console.log(`pruned ${removed} orphaned files (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.error(`prune failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
