import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { deleteDraft, deleteGeneratedDirectory, deleteGeneratedFile } from '../../utils/deletions';
import { getDataPath } from '../../utils/paths';
import { RENDITION_EXTENSION, renditionVariants, retiredRenditionDirs } from '../processing/renditions/renditions';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotoMetadataRepository } from '../photos/metadata/photo_metadata_repository';

// The directories holding files named `<photoId>.<ext>`. Taken from the same
// helper that writes the files, so changing an output format cannot leave the
// sweep looking in the wrong place. Anything else under the data directory - a
// stray the user left, a directory a later feature adds - is keyed by something
// other than a photo id and must not be touched.
function generatedDirs(library: Library): string[] {
  return renditionVariants().map((variant) => path.join(getDataPath(library), 'renditions', variant));
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
  for (const dir of generatedDirs(library)) {
    for (const id of photoIds) {
      // A rendition that was never built is not an error (`rm` is forced), and
      // one that will not go now is not either: the sweep is the backstop.
      await deleteGeneratedFile(dataPath, path.join(dir, `${id}${RENDITION_EXTENSION}`)).catch((err: unknown) => {
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
//
// A grid tile a scan built and no row ever claimed lands here too, and needs no rule of its
// own: it is written under a minted id in the directory it will be renamed into (§10.4), so one
// abandoned by a killed run is exactly what this already looks for - a name in `grid/` that is
// not a live photo.
export class PruneService {
  constructor(
    private readonly libraries: LibrariesRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
  ) {}

  async prune(): Promise<PruneResult> {
    // One id set for every library: a file is named by photo id alone, and ids
    // are global, so a per-library set could delete a file that legitimately
    // belongs to another library sharing a data directory.
    //
    // A panorama's copies are a photograph's like any other, keyed by its own id, so there is
    // nothing here to know about one.
    const live = new Set(this.photoMetadata.allIds());
    let removed = 0;
    let bytes = 0;

    for (const library of this.libraries.list()) {
      const dataPath = getDataPath(library);
      const renditions = path.join(dataPath, 'renditions');
      // A directory nothing writes to any more holds nothing but orphans, so
      // every file in one goes: the extension check below is what does it, none
      // of them being the extension a rendition has now.
      const retired = retiredRenditionDirs().map((dir) => path.join(renditions, dir));

      for (const dir of [...generatedDirs(library), ...retired]) {
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
          if (live.has(id) && path.extname(file) === RENDITION_EXTENSION) continue;
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

      // ENOTEMPTY is the expected outcome whenever a file above would not go, and
      // ENOENT whenever the directory was never there. Anything else is the path
      // guard refusing, which is a bug in `retiredRenditionDirs` and must be said.
      for (const dir of retired) {
        await deleteGeneratedDirectory(dataPath, dir).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOTEMPTY' || err.code === 'ENOENT') return;
          log.warn('could not remove a retired rendition directory', { dir, err });
        });
      }
    }

    return { removed, bytes };
  }

  /**
   * Reaps the analysis layers of a draft nobody came back to (§4.4).
   *
   * A sweep of its own rather than the orphan one above: a draft is keyed by the frames it was
   * carved from, so it is never a live photo id and "is this id still a photograph" answers nothing
   * about one. Age is the only thing that can decide.
   */
  async pruneDrafts(olderThanDays = 7): Promise<PruneResult> {
    const cutoff = Date.now() - olderThanDays * DAY_MS;
    let removed = 0;
    let bytes = 0;

    for (const library of this.libraries.list()) {
      const dataPath = getDataPath(library);
      const drafts = path.join(dataPath, 'drafts');
      let entries: string[];
      try {
        entries = await readdir(drafts);
      } catch {
        continue; // nothing has ever been carved in this library
      }
      for (const entry of entries) {
        const target = path.join(drafts, entry);
        const info = await stat(target).catch(() => null);
        if (info == null || info.mtimeMs > cutoff) continue;
        const size = await treeBytes(target);
        try {
          await deleteDraft(dataPath, target);
          removed++;
          bytes += size;
        } catch (err) {
          log.warn('could not remove a stale draft; next sweep decides', { target, err });
        }
      }
    }

    return { removed, bytes };
  }
}

/** What a file or directory holds, recursively, for the sweep to report what it freed. */
async function treeBytes(target: string): Promise<number> {
  const info = await stat(target).catch(() => null);
  if (info == null) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target).catch(() => [])) total += await treeBytes(path.join(target, entry));
  return total;
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
    if (everyDays === this.everyDays && this.timer != null) return;
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
      const swept = await this.prune.prune();
      const drafts = await this.prune.pruneDrafts();
      const removed = swept.removed + drafts.removed;
      const bytes = swept.bytes + drafts.bytes;
      log.info('sweep done', { removed, mb: (bytes / 1024 / 1024).toFixed(1), ms: Date.now() - startedAt });
    } catch (err) {
      log.error('sweep failed', { err });
    } finally {
      this.running = false;
    }
  }
}
