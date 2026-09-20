import type { Database } from '../../db/driver';
import { Logger } from '../../logger';
import type { TransferService } from '../blobs/transfer_service';
import { mirrorReady } from './backup_root';
import type { PassivePeer } from './passive_peers';

const log = new Logger('mirror');

// Keeping a library's originals under a ceiling on this device (docs/replication.md §14.5).
//
// Everything here is policy - which copies go, and in what order. The deletion itself is one
// function in `utils/deletions.ts`, and it proves for itself that the backup holds the same bytes
// before it unlinks anything; nothing in this file is trusted by it.

/** A local copy the cull may give back, oldest first. */
interface Candidate {
  id: string;
  size: number;
}

export class Cull {
  constructor(
    private readonly db: Database,
    private readonly transfers: TransferService,
  ) {}

  /** What this library's originals take up on this device. */
  localBytes(libraryId: string): number {
    return (
      this.db
        .query(
          `SELECT COALESCE(SUM(file_size), 0) AS bytes FROM photos
            WHERE library_id = ? AND is_missing = 0 AND json_extract(recipe, '$.kind') = 'file'`,
        )
        .get(libraryId) as { bytes: number }
    ).bytes;
  }

  budget(libraryId: string): number | null {
    const row = this.db
      .query('SELECT local_budget_bytes FROM replication_libraries WHERE library_id = ?')
      .get(libraryId) as { local_budget_bytes: number | null } | null;
    return row?.local_budget_bytes ?? null;
  }

  /**
   * Gives local copies back until the library fits its ceiling, least recently wanted first.
   *
   * "Wanted" is `last_accessed_at`, which the originals proxy writes every time anything opens the
   * RAW - a render, an export, a look at the photo, an edit (§14.4). A photograph nothing has ever
   * opened falls back to when it was added, so a library culled for the first time gives back its
   * oldest imports rather than treating the whole of it as equally cold.
   *
   * Nothing here decides a deletion is safe. Each copy goes through the same eviction the manual
   * action uses, which hashes both copies at the moment of the unlink and refuses where they
   * disagree - so a cull against a half-written backup removes nothing and says why, per
   * photograph.
   */
  async toBudget(peer: PassivePeer): Promise<number> {
    const ceiling = this.budget(peer.libraryId);
    if (ceiling == null) return 0;
    let held = this.localBytes(peer.libraryId);
    if (held <= ceiling) return 0;
    // Once, before a photograph is picked: every eviction would refuse against an unplugged drive,
    // and reporting that as ten thousand refusals is a log nobody reads and a pass that took
    // minutes to do nothing.
    if (!mirrorReady(peer.root, peer.libraryId)) {
      log.warn('skipping the cull: the backup folder is not there', { library: peer.libraryId, at: peer.root });
      return 0;
    }

    let offloaded = 0;
    for (const candidate of this.candidates(peer)) {
      if (held <= ceiling) break;
      const result = await this.transfers.evict([candidate.id], peer.peerId);
      const refusal = result.refused[0];
      if (refusal != null) {
        log.warn('a local copy stayed', { photo: candidate.id, why: refusal.reason });
        continue;
      }
      held -= candidate.size;
      offloaded += 1;
    }
    if (offloaded > 0) {
      log.info('gave local copies back to the backup', { library: peer.libraryId, photos: offloaded, held });
    }
    return offloaded;
  }

  /**
   * The copies that could go: on this device, on the backup, and the same bytes in both places.
   *
   * The hash comparison is against the row rather than the files - the deletion reads the files -
   * and it is what keeps a photograph whose backup copy is out of date out of the running
   * entirely, rather than offering it up to be refused one at a time.
   */
  private candidates(peer: PassivePeer): Candidate[] {
    return this.db
      .query(
        `SELECT p.id, COALESCE(p.file_size, 0) AS size FROM photos p
           JOIN backup_locations b ON b.library_id = p.library_id AND b.photo_id = p.id AND b.peer_id = ?
          WHERE p.library_id = ? AND p.is_missing = 0 AND json_extract(p.recipe, '$.kind') = 'file'
            AND p.content_hash IS NOT NULL AND p.content_hash = b.content_hash
          ORDER BY COALESCE(p.last_accessed_at, p.date_added), p.id`,
      )
      .all(peer.peerId, peer.libraryId) as Candidate[];
  }
}
