import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { deleteGeneratedFile } from '../../utils/deletions';
import { getDataPath } from '../../utils/paths';
import { renditionDirs } from '../processing/renditions';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotosRepository } from '../photos/photos_repository';

// The directories holding files named `<photoId>.<ext>`, each with the one
// extension it is supposed to contain. Both are taken from the same helpers that
// write the files, so changing an output format cannot leave the sweep looking
// in the wrong place or keeping the superseded files. Everything else under the
// data directory (the Bin, the sync lock) is keyed by something other than a
// photo id and must not be touched.
function generatedDirs(library: Library): Array<{ dir: string; ext: string }> {
  const renditions = renditionDirs().map(({ dir, extension }) => ({
    dir: path.join(getDataPath(library), 'renditions', dir),
    ext: extension,
  }));
  return renditions;
}

const log = new Logger('prune');

// The eager half of the sweep below, for photos whose rows are going right now
// rather than ones whose rows went at some point (§8.5). Same directories and the
// same rule about which files a photo id owns, so a change to either is made once.
export async function deleteGeneratedFilesFor(library: Library, photoIds: readonly string[]): Promise<void> {
  if (photoIds.length === 0) return;
  const dataPath = getDataPath(library);
  // Named rather than searched for. The sweep reads whole directories because it
  // is looking for files whose ids it does not know; here the ids are the input,
  // and those directories hold one entry per photo in the library - millions of
  // dirents read to delete a few hundred.
  for (const { dir, ext } of generatedDirs(library)) {
    for (const id of photoIds) {
      // A rendition that was never built is not an error (`rm` is forced), and
      // one that will not go now is not either: the sweep is the backstop.
      await deleteGeneratedFile(dataPath, path.join(dir, `${id}${ext}`)).catch((err: unknown) => {
        log.warn('could not remove a rendition; the sweep will', { id, dir, err });
      });
    }
  }
}

export interface PruneResult {
  removed: number;
  bytes: number;
}

// Deletes generated files whose photo no longer exists. Nothing else in the
// system does: renditions are written by processing and rewritten in place, so
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
      const dataPath = getDataPath(library);
      for (const { dir, ext } of generatedDirs(library)) {
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          continue; // never created, or the whole data directory is gone
        }
        for (const file of files) {
          const id = file.replace(/\.[^.]+$/, '');
          // A live photo still leaves a file behind when the output format
          // changes: the render is rewritten under the new extension and the
          // old one is never touched again.
          if (live.has(id) && path.extname(file) === ext) continue;
          const target = path.join(dir, file);
          try {
            bytes += (await stat(target)).size;
            await deleteGeneratedFile(dataPath, target);
            removed++;
          } catch (err) {
            // A concurrent processing run may have just replaced it. Skip and
            // let the next sweep decide.
            log.warn('could not remove an orphan; next sweep decides', { file: target, err });
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
    private everyDays = 0,
  ) {}

  start(): void {
    if (!(this.everyDays > 0) || this.timer != null) return;
    this.timer = setInterval(() => void this.fire(), this.everyDays * DAY_MS);
    log.info('orphaned-file sweep scheduled', { everyDays: this.everyDays });
  }

  /** Applies a changed setting (§15) without a restart. */
  configure(everyDays: number): void {
    if (everyDays === this.everyDays) return;
    this.stop();
    this.everyDays = everyDays;
    this.start();
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
    const startedAt = Date.now();
    try {
      const { removed, bytes } = await this.prune.prune();
      log.info('sweep done', { removed, mb: (bytes / 1024 / 1024).toFixed(1), ms: Date.now() - startedAt });
    } catch (err) {
      log.error('sweep failed', { err });
    } finally {
      this.running = false;
    }
  }
}
