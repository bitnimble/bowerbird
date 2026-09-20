import { existsSync, readdirSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { BackupRunResponse, BackupStatus } from '../../schemas/backup';
import { newId } from '../../schemas/id';
import type { Library } from '../../schemas/libraries';
import { deleteStagedBlob } from '../../utils/deletions';
import { ensureDir } from '../../utils/files';
import { contentHash } from '../../utils/hash';
import { containsPath } from '../../utils/paths';
import { occupant } from '../blobs/blob_store';
import type { TransferService } from '../blobs/transfer_service';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import { linkLibrary, registerPeer } from '../replication/pairing';
import type { BackupLocations } from './backup_locations';
import { assertMirrorOf, backupPath, backupStagingDir, markerPath, mirrorReady, readMarker } from './backup_root';
import type { Cull } from './cull';
import { passivePeersOf, type PassivePeer } from './passive_peers';

// `backup` is the catalogue's own snapshots (§4.9), which this is not: one scope for two
// subsystems is a log nobody can narrow.
const log = new Logger('mirror');

// Keeping a library's originals on a folder that is not a Bowerbird device (docs/replication.md
// §14): a drive, a share, a directory somewhere else on this machine.
//
// What this owns is the *policy* - which copies the backup is owed, which have been moved out from
// under it, and when to look. Moving the bytes is the transfer queue's job, exactly as it is for a
// device, and giving a local copy back is the cull's.

/** How often a backup that nobody has touched looks at what it owes. */
const PASS_EVERY_MS = 15 * 60 * 1000;

/**
 * How many copies one pass looks at again.
 *
 * A stat apiece, which is milliseconds over a network mount, so this is what one pass is willing
 * to spend rather than a number anything depends on. At a pass every quarter of an hour it covers
 * about fifty thousand photographs a day.
 */
const SCRUB_PER_PASS = 500;

export class Mirror {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly libraries: LibrariesRepository,
    private readonly backups: BackupLocations,
    private readonly transfers: TransferService,
    private readonly cull: Cull,
  ) {}

  /**
   * Starts the periodic pass.
   *
   * A pass is also run whenever a scan changes anything, which is what covers an import; this is
   * the backstop for everything else - a drive plugged back in, a transfer that failed while the
   * network was down, a ceiling lowered while nothing else was happening.
   */
  start(): void {
    this.timer ??= setInterval(() => void this.runAll(), PASS_EVERY_MS);
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A pass over every library that has a folder.
   *
   * One library's failure is one library's: an unplugged drive is the ordinary case, and it says
   * nothing about the other libraries' folders. What went wrong is on the peer row either way
   * (§8.6), which is what the panel reads.
   */
  async runAll(): Promise<void> {
    for (const library of this.libraries.list()) {
      try {
        await this.run(library.id);
      } catch (err) {
        log.warn('a backup pass stopped', { library: library.id, err: String(err) });
      }
    }
  }

  /** Nothing to do where the library has no backup, which is most of them. */
  private targetOf(libraryId: string): PassivePeer | null {
    return passivePeersOf(this.db, libraryId)[0] ?? null;
  }

  status(libraryId: string): BackupStatus | null {
    const peer = this.targetOf(libraryId);
    if (peer == null) return null;
    const row = this.db
      .query('SELECT name, last_error, last_replicated_at FROM replication_peers WHERE library_id = ? AND peer_id = ?')
      .get(libraryId, peer.peerId) as { name: string; last_error: string | null; last_replicated_at: string | null };
    return {
      library_id: libraryId,
      peer_id: peer.peerId,
      name: row.name,
      path: peer.root,
      available: mirrorReady(peer.root, libraryId),
      owed: this.backups.owed(libraryId, peer.peerId).length,
      backed_up: this.backups.count(libraryId, peer.peerId),
      local_bytes: this.cull.localBytes(libraryId),
      local_budget_bytes: this.cull.budget(libraryId),
      offloaded: this.backups.offloaded(libraryId),
      last_run_at: row.last_replicated_at,
      last_error: row.last_error,
    };
  }

  list(): BackupStatus[] {
    return this.libraries
      .list()
      .map((library) => this.status(library.id))
      .filter((status): status is BackupStatus => status != null);
  }

  /**
   * Points a library at a folder, or moves it to another one.
   *
   * The marker is written before anything else is recorded: it is what tells a later pass that the
   * drive it is looking at is the one that was chosen, and a folder with no marker is how an
   * unmounted share looks (§14.1).
   */
  async setTarget(libraryId: string, root: string, name?: string): Promise<BackupStatus> {
    const library = this.library(libraryId);
    const at = path.resolve(root);
    this.assertUsable(library, at);
    await ensureDir(at);

    const existing = this.targetOf(libraryId);
    const marker = readMarker(at);
    if (marker != null && marker.library_id !== libraryId) {
      throw new AppError('CONFLICT', `${at} is already the backup of another library ("${marker.library_name}")`);
    }
    // The folder's own marker wins where it has one, so a backup carried to another machine - or
    // re-paired after the catalogue was restored - is adopted rather than made a second time under
    // a new id, which would leave every file on it looking like one nothing has copied yet.
    const peerId = marker?.peer_id ?? existing?.peerId ?? newId();
    await Bun.write(
      markerPath(at),
      `${JSON.stringify({ library_id: libraryId, library_name: library.name, peer_id: peerId }, null, 2)}\n`,
    );

    // A library gets its replication row here as it does when a device is paired: the backup is a
    // peer, and what `blob_locations` records about this device's own holdings is what a later
    // fetch and a later cull both read.
    linkLibrary(this.db, libraryId);
    if (existing != null && existing.peerId !== peerId) this.forget(libraryId, existing.peerId);
    registerPeer(this.db, libraryId, peerId, name ?? path.basename(at), at, 'passive');
    await this.rediscover({ libraryId, peerId, name: library.name, root: at });
    log.info('a library has a backup folder', { library: libraryId, at });
    const status = this.status(libraryId);
    if (status == null) throw new AppError('INTERNAL_ERROR', `the backup folder for ${libraryId} did not record`);
    return status;
  }

  /**
   * Forgets the folder. Nothing on it is touched: a backup somebody unpairs is a backup they still
   * have, and this app has never deleted from one (§14.3).
   */
  async removeTarget(libraryId: string): Promise<void> {
    const peer = this.targetOf(libraryId);
    if (peer == null) throw new AppError('NOT_FOUND', `library ${libraryId} has no backup folder`);
    await this.transfers.cancelFor(libraryId, peer.peerId);
    this.forget(libraryId, peer.peerId);
  }

  private forget(libraryId: string, peerId: string): void {
    this.db.query('DELETE FROM replication_peers WHERE library_id = ? AND peer_id = ?').run(libraryId, peerId);
    this.backups.forget(libraryId, peerId);
  }

  setBudget(libraryId: string, bytes: number | null): void {
    this.library(libraryId);
    linkLibrary(this.db, libraryId);
    this.db
      .query('UPDATE replication_libraries SET local_budget_bytes = ? WHERE library_id = ?')
      .run(bytes, libraryId);
  }

  /**
   * One pass: follow the moves, send what is owed, then give back what does not fit.
   *
   * In that order for a reason. A photograph the catalogue has moved is still on the backup under
   * its old name, so replaying the move first is what keeps the next step from sending a second
   * copy of it - and the cull runs last because a copy is only safe to give back once the pass
   * that would have sent it has had its go.
   *
   * Throws what stopped it, having recorded it on the peer row first. The person who pressed the
   * button is told; the timer and the scan that call this on their own are the ones that swallow
   * it, because a drive that is not plugged in is not an error either of them can do anything
   * about.
   */
  async run(libraryId: string): Promise<BackupRunResponse> {
    const peer = this.targetOf(libraryId);
    const nothing = { copied: 0, moved: 0, offloaded: 0 };
    if (peer == null || this.running.has(libraryId)) return nothing;
    this.running.add(libraryId);
    try {
      const library = this.library(libraryId);
      assertMirrorOf(peer.root, libraryId, library.name);
      const moved = await this.follow(peer);
      this.scrub(peer);
      await this.sweepStages(peer);
      const owed = this.backups.owed(libraryId, peer.peerId).map((each) => each.photo_id);
      this.transfers.queuePush(libraryId, peer.peerId, owed);
      // After the queue has emptied rather than beside it: what the cull may give back is what the
      // backup holds *now*, and half of it is still in flight until the drain finishes.
      await this.transfers.drain();
      // What is still owed is what did not make it: `drain` resolves on an empty queue whether each
      // push landed or failed, so counting what was sent would report a full drive as a backup.
      const stillOwed = new Set(this.backups.owed(libraryId, peer.peerId).map((each) => each.photo_id));
      const copied = owed.filter((photoId) => !stillOwed.has(photoId)).length;
      const offloaded = await this.cull.toBudget(peer);
      this.note(libraryId, peer.peerId, null);
      return { copied, moved, offloaded };
    } catch (error) {
      this.note(libraryId, peer.peerId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.running.delete(libraryId);
    }
  }

  /**
   * Takes up the copies a folder already holds of photographs this device has given back.
   *
   * What makes unpairing a backup reversible. Those photographs have no local bytes, so nothing
   * would ever send them again, and their rows went when the folder was forgotten - so without
   * this, re-pairing the same drive leaves the only copy of each sitting on it, unreachable.
   *
   * Hashed rather than matched by name, because it is the same question the cull will ask later:
   * whether the file on the drive is this photograph's.
   */
  private async rediscover(peer: PassivePeer): Promise<number> {
    let found = 0;
    for (const lost of this.backups.stranded(peer.libraryId, peer.peerId)) {
      const copy = backupPath(peer.root, lost.rel_path);
      if (!existsSync(copy)) continue;
      if ((await contentHash(copy)) !== lost.content_hash) continue;
      this.backups.record(peer.libraryId, peer.peerId, lost.photo_id, lost.rel_path, lost.content_hash, Bun.file(copy).size);
      found += 1;
    }
    if (found > 0) log.info('the backup already held originals this device has given back', { photos: found });
    return found;
  }

  /**
   * Replays onto the backup the moves the library has made: a rename, a photo binned, one
   * restored (§14.3).
   *
   * Never over an occupied name, and never a delete. A copy whose source has gone - somebody
   * tidied the drive by hand - is forgotten rather than chased, which puts the photograph back
   * among what the backup is owed and copies it again.
   */
  private async follow(peer: PassivePeer): Promise<number> {
    let moved = 0;
    for (const copy of this.backups.misplaced(peer.libraryId, peer.peerId)) {
      const from = backupPath(peer.root, copy.was_at);
      const to = backupPath(peer.root, copy.belongs_at);
      if (!existsSync(from)) {
        this.backups.drop(peer.libraryId, peer.peerId, copy.photo_id);
        continue;
      }
      await ensureDir(path.dirname(to));
      const taken = occupant(path.dirname(to), path.basename(to));
      if (taken != null) {
        log.warn('a backup copy stayed where it was', { photo: copy.photo_id, at: copy.was_at, blocked: taken });
        continue;
      }
      await rename(from, to);
      this.backups.moved(peer.libraryId, peer.peerId, copy.photo_id, copy.belongs_at);
      moved += 1;
    }
    return moved;
  }

  /**
   * Looks again at the copies gone longest unchecked, and forgets the ones that are not there.
   *
   * A backup is only worth what is still on it, and a row saying a file was copied in March is
   * evidence about March. Somebody tidies the drive, a filesystem loses a directory, a share is
   * remounted at a different path: none of that says anything here until something asks, and by
   * then what asks is a person who has lost the photograph.
   *
   * A forgotten copy is one the next pass owes, so a file that has gone is copied again rather
   * than reported - and a size that has changed is the same answer, because the bytes are no
   * longer the ones the row vouches for. Existence and size only: hashing what is on the mount is
   * what the cull does to the one photograph it is about to give up, and doing it to a library
   * would read every byte of it on a timer.
   */
  private scrub(peer: PassivePeer): void {
    let dropped = 0;
    for (const copy of this.backups.stalest(peer.libraryId, peer.peerId, SCRUB_PER_PASS)) {
      const at = backupPath(peer.root, copy.rel_path);
      const found = statSync(at, { throwIfNoEntry: false });
      if (found?.size === copy.size) {
        this.backups.verified(peer.libraryId, peer.peerId, copy.photo_id);
        continue;
      }
      this.backups.drop(peer.libraryId, peer.peerId, copy.photo_id);
      dropped += 1;
    }
    if (dropped > 0) log.warn('the backup no longer holds what it was recorded as holding', { photos: dropped });
  }

  /**
   * Part-copied files on the backup that nothing is waiting to finish.
   *
   * A transfer that was cancelled or whose photograph has since gone leaves its staged bytes on
   * the drive, where nothing else ever looks - and the whole point of the drive is that it has
   * room. What a queued or paused entry staged is left alone: that is what lets it carry on from
   * where it stopped rather than start the file again.
   */
  private async sweepStages(peer: PassivePeer): Promise<void> {
    const dir = backupStagingDir(peer.root);
    if (!existsSync(dir)) return;
    const waiting = new Set(
      (
        this.db
          .query(
            `SELECT photo_id FROM blob_transfers
              WHERE library_id = ? AND peer_id = ? AND state IN ('queued', 'active', 'paused')`,
          )
          .all(peer.libraryId, peer.peerId) as { photo_id: string }[]
      ).map((row) => row.photo_id),
    );
    for (const name of readdirSync(dir)) {
      const photoId = name.endsWith('.partial') ? name.slice(0, -'.partial'.length) : null;
      if (photoId == null || waiting.has(photoId)) continue;
      await deleteStagedBlob(dir, path.join(dir, name));
    }
  }

  private note(libraryId: string, peerId: string, error: string | null): void {
    this.db
      .query('UPDATE replication_peers SET last_error = ?, last_replicated_at = ? WHERE library_id = ? AND peer_id = ?')
      .run(error, new Date().toISOString(), libraryId, peerId);
  }

  /**
   * Where a backup may not be put.
   *
   * Inside the library is the one that would be found out slowly: the scan walks everything under
   * the root, so a mirror there is imported as a second copy of every photograph, which then gets
   * backed up in turn.
   */
  private assertUsable(library: Library, at: string): void {
    if (!path.isAbsolute(at)) {
      throw new AppError('VALIDATION_ERROR', `the backup folder has to be an absolute path: ${at}`);
    }
    if (containsPath(library.root_path, at) || containsPath(at, library.root_path)) {
      throw new AppError('VALIDATION_ERROR', `the backup folder cannot be inside the library, or hold it: ${at}`);
    }
    for (const other of this.libraries.list()) {
      if (other.id === library.id) continue;
      const theirs = passivePeersOf(this.db, other.id)[0];
      if (theirs != null && (containsPath(theirs.root, at) || containsPath(at, theirs.root))) {
        throw new AppError('CONFLICT', `${at} is already the backup folder of "${other.name}"`);
      }
    }
  }

  private library(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }
}
