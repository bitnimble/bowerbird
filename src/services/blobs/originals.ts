import { existsSync } from 'node:fs';
import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { isComposite, sourcesOf } from '../../schemas/recipes';
import { originalPathOf } from '../../utils/paths';
import type { BackupLocations } from '../backup/backup_locations';
import { mirrorReady } from '../backup/backup_root';
import { passivePeerOf } from '../backup/passive_peers';
import type { BasicPhoto, PhotoPathsRepository } from '../photos/paths/photo_paths_repository';
import type { TransferService } from './transfer_service';

const log = new Logger('blobs');

/**
 * The one way to a photograph's bytes (docs/replication.md §14.4).
 *
 * A library's originals are not all on its own disk any more: the cull gives the oldest of them
 * back to a backup folder, and what is left behind is a catalogue row, its renditions, and a copy
 * on a drive. So everything that decodes, exports, measures or hands over a RAW asks here and gets
 * a path it can open - fetched back first where it has to be - and nothing downstream carries a
 * second opinion about where the file is.
 *
 * That is the whole point of the class: the decoders, the render pipeline and the image routes
 * were all written against a path, and they still are.
 */
export class Originals {
  constructor(
    private readonly db: Database,
    /** How a composite's frames are found, which is the only row kind that is not one file. */
    private readonly photoPaths: Pick<PhotoPathsRepository, 'getBasicById'>,
    /**
     * The two things fetching an original needs of the queue: ask for it, and wait for that one
     * entry. Narrow on purpose - `TransferService` satisfies it, and a test of anything that reads
     * a RAW does not have to build a transfer queue to say "the file is here".
     */
    private readonly transfers: Pick<TransferService, 'fetchOriginal' | 'settled'>,
    private readonly backups: BackupLocations,
  ) {}

  /**
   * Where the file is, without going to get it: null for a row that is not one file, and for one
   * whose file is not on this disk at the moment.
   *
   * For the callers that would rather do without than wait - a grid tile repairing itself, a
   * metadata refresh over a selection, the detail view's "is it here". Fetching a RAW back over a
   * network for any of those would turn a stat into a minute.
   */
  here(library: Library, photo: BasicPhoto): string | null {
    const abs = originalPathOf(library, photo);
    return abs != null && existsSync(abs) ? abs : null;
  }

  /**
   * A path to the bytes, fetching them back from the backup where this device has given its copy
   * up.
   *
   * Null where nothing can produce them: a composed row, or a photograph whose original is on no
   * device and no drive this one knows of. A backup that holds the file but is not plugged in is
   * the third case and the only one that throws, because it is the one that is somebody's to fix.
   */
  async open(library: Library, photo: BasicPhoto): Promise<string | null> {
    const abs = originalPathOf(library, photo);
    if (abs == null) return null;
    if (existsSync(abs)) {
      this.touch(photo.id);
      return abs;
    }
    if (!(await this.fetchFromBackup(library, photo))) return null;
    // The path is the row's, and a fetch lands the file at the row's *current* path - so a photo
    // binned while its original was in flight is read from the bin, not from where it used to be.
    const landed = originalPathOf(library, photo);
    if (landed == null || !existsSync(landed)) return null;
    this.touch(photo.id);
    return landed;
  }

  /**
   * Every file this row is made of, on this disk: its own where it is a photograph, and its
   * frames' where it composes other rows.
   *
   * What a merge needs before it can be drawn at all. False where any one of them could not be
   * had, which is the same answer a frame that has gone has always given - the recipe is still
   * true and the picture may be makeable after the next sync.
   */
  async openAll(library: Library, photo: BasicPhoto): Promise<boolean> {
    if (!isComposite(photo.recipe)) return (await this.open(library, photo)) != null;
    for (const frameId of sourcesOf(photo.recipe)) {
      const frame = this.photoPaths.getBasicById(frameId);
      if (frame == null || !(await this.openAll(library, frame))) return false;
    }
    return true;
  }

  /**
   * Notes that something wanted this photograph, which is the order the cull gives copies back in
   * (§14.5).
   *
   * Written on every open rather than sampled: a decode is milliseconds of work at the least and
   * this is one indexed update, and the alternative - a photograph whose accesses were coalesced
   * away - is one culled while somebody was working on it.
   */
  touch(photoId: string): void {
    this.db.query('UPDATE photos SET last_accessed_at = ? WHERE id = ?').run(new Date().toISOString(), photoId);
  }

  /**
   * Brings the bytes back from a backup folder, and only from one.
   *
   * A device that also holds this original is deliberately not asked. Fetching a whole original
   * over the network to satisfy a rendition is the accident §7.9 exists to rule out - what a peer
   * answers for is its *built* renditions - and a fetch from a device is something the person asks
   * for by name (§7.5). A backup is the opposite case: this device put the copy there, it is on a
   * mount rather than a network, and nothing else is going to bring it back.
   *
   * False where there is no copy to bring back. A folder that holds one and is not plugged in
   * throws instead, because that is the one case somebody can do something about.
   *
   * ponytail: the whole file comes back, so a loupe tile over an offloaded photograph costs the
   * whole RAW rather than the region decode the fork exists for. Ranged reads straight off the
   * mount are the upgrade, and they want an IO seam that reaches through the FFI.
   */
  private async fetchFromBackup(library: Library, photo: BasicPhoto): Promise<boolean> {
    for (const peerId of this.backups.holders(library.id, photo.id)) {
      const peer = passivePeerOf(this.db, peerId);
      if (peer == null) continue;
      if (!mirrorReady(peer.root, library.id)) {
        throw new AppError(
          'UNAVAILABLE',
          `this photo's RAW is on the backup "${peer.name}", which is not available. Connect ${peer.root} and try again.`,
        );
      }
      // Null is the file having arrived between the check above and the queue looking: another
      // request for the same photograph landed it.
      const transfer = this.transfers.fetchOriginal(photo.id, peerId);
      if (transfer == null) return true;
      const settled = await this.transfers.settled(transfer.id);
      if (settled.state === 'done') return true;
      log.warn('an original did not come back', { photo: photo.id, state: settled.state, err: settled.error });
    }
    return false;
  }
}
