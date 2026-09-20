import type { Database } from '../../db/driver';
import { statSync } from 'node:fs';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { deleteGeneratedFile } from '../../utils/deletions';
import { getDataPath, renditionPathFor } from '../../utils/paths';
import type { Rendition } from '../processing/renditions/renditions';

// What a device with no originals keeps of other people's renditions (§7.9).
//
// The pipeline's own renditions need no cap: they are rebuildable from the RAW
// sitting next to them, and the orphan sweep takes them when the photograph goes.
// These are neither - the device cannot rebuild one, and nothing but browsing
// decides how many there are - so they are a cache and want a cache's rules.

const log = new Logger('blobs');

/**
 * How much of one library's fetched renditions a device keeps.
 *
 * A grid tile is tens of kilobytes and a viewer rendition a few hundred, so this
 * is tens of thousands of tiles or a few thousand renditions: a long trip's
 * browsing, held, while a phone that has scrolled a decade of photographs gives
 * back the ones it scrolled past first.
 */
export const FETCHED_RENDITION_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

export class RenditionCache {
  constructor(
    private readonly db: Database,
    private readonly limitBytes: number = FETCHED_RENDITION_CACHE_BYTES,
    /**
     * A seam, because "least recently used" is only meaningful if two uses can be
     * told apart: real opens are seconds apart, and a test's are not.
     */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Records a fetched file, and gives back whatever the cap says can no longer stay. */
  async keep(library: Library, photoId: string, rendition: Rendition, hdr: boolean, path: string): Promise<void> {
    const bytes = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    this.db
      .query(
        `INSERT INTO fetched_renditions (library_id, photo_id, rendition, hdr, bytes, used_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (library_id, photo_id, rendition, hdr) DO UPDATE SET bytes = excluded.bytes, used_at = excluded.used_at`,
      )
      .run(library.id, photoId, rendition, hdr ? 1 : 0, bytes, this.now());
    await this.evictDownTo(library);
  }

  /**
   * Marks a cached rendition as wanted just now.
   *
   * One statement on a read, and only for the photographs whose originals are
   * elsewhere - the fetch path returns before this for anything this device could
   * build itself.
   */
  touch(libraryId: string, photoId: string, rendition: Rendition, hdr: boolean): void {
    this.db
      .query(
        'UPDATE fetched_renditions SET used_at = ? WHERE library_id = ? AND photo_id = ? AND rendition = ? AND hdr = ?',
      )
      .run(this.now(), libraryId, photoId, rendition, hdr ? 1 : 0);
  }

  /** Forgets a file that has gone, so the total stops counting it. */
  forget(libraryId: string, photoId: string, rendition: Rendition, hdr: boolean): void {
    this.db
      .query('DELETE FROM fetched_renditions WHERE library_id = ? AND photo_id = ? AND rendition = ? AND hdr = ?')
      .run(libraryId, photoId, rendition, hdr ? 1 : 0);
  }

  bytesHeld(libraryId: string): number {
    const row = this.db
      .query('SELECT COALESCE(SUM(bytes), 0) AS held FROM fetched_renditions WHERE library_id = ?')
      .get(libraryId) as { held: number };
    return row.held;
  }

  /**
   * Takes the least recently used until the library is back under the cap.
   *
   * Rows go with their files, and the row goes first: a file the delete failed on
   * is a wasted megabyte, while a row left behind is a megabyte the cap keeps
   * counting forever and eventually evicts the whole cache over.
   */
  private async evictDownTo(library: Library): Promise<void> {
    let held = this.bytesHeld(library.id);
    if (held <= this.limitBytes) return;

    const oldest = this.db.query(
      `SELECT photo_id, rendition, hdr, bytes FROM fetched_renditions
        WHERE library_id = ? ORDER BY used_at, photo_id LIMIT 32`,
    );
    const dataPath = getDataPath(library);
    let dropped = 0;
    while (held > this.limitBytes) {
      const batch = oldest.all(library.id) as {
        photo_id: string;
        rendition: Rendition;
        hdr: number;
        bytes: number;
      }[];
      if (batch.length === 0) return;
      for (const row of batch) {
        if (held <= this.limitBytes) break;
        this.forget(library.id, row.photo_id, row.rendition, row.hdr === 1);
        await deleteGeneratedFile(
          dataPath,
          renditionPathFor(dataPath, row.photo_id, row.rendition, row.hdr === 1),
        ).catch(() => {});
        held -= row.bytes;
        dropped += 1;
      }
    }
    log.info('gave back the least recently used fetched renditions', {
      library: library.id,
      dropped,
      heldBytes: held,
    });
  }
}
