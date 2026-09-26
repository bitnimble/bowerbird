import type { Database } from '../../db/driver';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import {
  BlobCommitRequestSchema,
  BlobHashResponseSchema,
  BlobStageResponseSchema,
  BlobVerifyResponseSchema,
  type BlobScope,
  type BlobVerifyResponse,
  type EvictResult,
  type Transfer,
  type TransferDirection,
} from '../../schemas/blobs';
import { ErrorEnvelopeSchema } from '../../schemas/error';
import { newId } from '../../schemas/id';
import type { Library } from '../../schemas/libraries';
import { soleInputOf } from '../../schemas/recipes';
import { PathSegment, route } from '../../schemas/route';
import { deleteBackedUpOriginal, deleteEvictedOriginal, deleteStagedBlob } from '../../utils/deletions';
import { contentHash } from '../../utils/hash';
import { originalPathOf } from '../../utils/paths';
import type { BackupLocations } from '../backup/backup_locations';
import { backupPath, mirrorReady } from '../backup/backup_root';
import { passivePeerOf } from '../backup/passive_peers';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotoMetadataRepository } from '../photos/metadata/photo_metadata_repository';
import type { BasicPhoto, PhotoPathsRepository } from '../photos/paths/photo_paths_repository';
import { libraryMutex } from '../sync/coordination/library_mutex';
import type { BlobLocations } from './blob_locations';
import type { PeerTransport } from './peer';
import { appendToStage, materialise, stagePath, stagedSize, stagingDir } from './blob_store';
import { unsettled } from '../replication/materialise';
import { isEvicting, whileEvicting } from './evicting';

// Moving the originals themselves (docs/replication.md §7.3, §7.5, §7.6).
// Catalogue replication never carries a byte of them; everything here is manual
// and explicit, except fetch-on-open, where opening the photo is the ask.

const log = new Logger('blobs');

/**
 * The file a transfer is about, refusing a row that is not one.
 *
 * Nothing here can carry a composed photograph: what would be sent is a recipe naming other
 * photographs, which is catalogue rather than blob and replicates as such. So a queue entry for
 * one is a bug on the side that made it, and it says so rather than transferring a path that
 * resolves to nothing.
 */
function originalToTransfer(library: Library, photo: BasicPhoto): string {
  const abs = originalPathOf(library, photo);
  if (abs == null) {
    throw new AppError('VALIDATION_ERROR', `${photo.id} is composed rather than imported, so it has no original to transfer`);
  }
  return abs;
}

const PUSH_CHUNK = 8 * 1024 * 1024;
const PROGRESS_EVERY = 4 * 1024 * 1024;

const COLUMNS = 'id, library_id, photo_id, peer_id, direction, state, bytes_done, bytes_total, error';

/**
 * A verified staged blob becoming the photograph's original: renamed to the
 * row's *current* path (the bin path if it is binned by now), the location row
 * recorded only after the rename, and the pipeline handed the arrival (§7.4,
 * §7.5, §7.8). Under the library mutex, like every other move of these files.
 */
export async function acceptVerifiedBlob(
  photoPaths: PhotoPathsRepository,
  photoMetadata: PhotoMetadataRepository,
  locations: BlobLocations,
  library: Library,
  photoId: string,
  stageFile: string,
  /**
   * Asks for the tile and renditions the arrival now owes (§7.8).
   *
   * Explicitly rather than by leaving the flags for somebody to notice: the only
   * thing that would otherwise pick them up is the watcher seeing a new file and
   * running a scoped scan, which is off on any install with watching disabled,
   * late by a debounce everywhere else, and a coincidence in all cases.
   */
  build: (photoIds: string[]) => void = () => {},
): Promise<void> {
  await libraryMutex.run(library.id, async () => {
    const photo = photoPaths.getBasicById(photoId);
    if (photo == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    // Bytes arriving for a row that is not one file cannot be placed: there is no path they are
    // the contents of, and the recipe is what would have to have travelled instead.
    const at = soleInputOf(photo.recipe);
    if (at == null) throw new AppError('VALIDATION_ERROR', `${photoId} is composed rather than imported`);
    const outcome = await materialise(library, at, stageFile);
    if (!outcome.placed) {
      locations.flag(library.id, photoId, at, `target occupied by ${outcome.occupiedBy}`);
      throw new AppError('CONFLICT', `${at} is occupied by ${outcome.occupiedBy}; staged copy kept`);
    }
    locations.record(library.id, photoId);
    locations.clearFlag(library.id, photoId);
    photoMetadata.markOriginalArrived(photoId);
  });
  // Outside the mutex: building is minutes of GPU work and holds nothing.
  build([photoId]);
}

export class TransferService {
  private draining: Promise<void> | null = null;
  private readonly aborts = new Map<string, AbortController>();
  /**
   * The queued pulls that named a photograph rather than a device, and may
   * therefore be handed to another holder when the one they have fails.
   *
   * `pullDiff` is the other kind and must never fail over: it is "send me what
   * *that* device has", so a peer dropping out mid-run would otherwise reroute
   * every photograph still queued for it onto some other holder, over a link
   * nobody chose.
   *
   * ponytail: in memory, so a fetch-on-open that outlives a restart is retried
   * against its own peer and no other. Nobody is still waiting on that open, and
   * the alternative is a column and a migration to carry it.
   */
  private readonly anyHolderWillDo = new Set<string>();
  /** Who is waiting on one entry rather than on the queue (see {@link settled}). */
  private readonly waiting = new Map<string, ((item: Transfer) => void)[]>();

  constructor(
    private readonly db: Database,
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly libraries: LibrariesRepository,
    private readonly locations: BlobLocations,
    private readonly backups: BackupLocations,
    private readonly transport: PeerTransport,
    /** What an arriving original owes the pipeline (§7.8). */
    private readonly build: (photoIds: string[]) => void = () => {},
  ) {
    // A crash mid-transfer leaves rows active; the bytes staged so far are on
    // disk, so they are simply work still owed.
    this.db.query("UPDATE blob_transfers SET state = 'queued' WHERE state = 'active'").run();
  }

  /**
   * Staged bytes no transfer is waiting on (§7.7).
   *
   * Every path that clears a stage file is the receiving side of a *pull* or a
   * refused commit. A push the sender abandons - its process died, the person
   * cancelled it there, the queue never came back to it - leaves the receiver
   * holding a partial it will never hear about again, inside the library root,
   * where nothing else ever looks. A few thousand of those is tens of gigabytes of
   * somebody's photographs volume spent on transfers that are not happening.
   *
   * Only what nothing is waiting on: a queued or paused entry's staged bytes are
   * what lets it resume where it stopped rather than start again.
   */
  async sweepAbandonedStages(): Promise<number> {
    let swept = 0;
    for (const library of this.libraries.list()) {
      const dir = stagingDir(library);
      if (!existsSync(dir)) continue;
      const waiting = new Set(
        (
          this.db
            .query("SELECT photo_id FROM blob_transfers WHERE library_id = ? AND state IN ('queued', 'paused')")
            .all(library.id) as { photo_id: string }[]
        ).map((row) => row.photo_id),
      );
      for (const name of readdirSync(dir)) {
        const photoId = name.endsWith('.partial') ? name.slice(0, -'.partial'.length) : null;
        if (photoId == null || waiting.has(photoId)) continue;
        await deleteStagedBlob(dir, path.join(dir, name));
        swept += 1;
      }
    }
    if (swept > 0) log.info('swept staged originals nothing was waiting on', { files: swept });
    return swept;
  }

  /**
   * "Send the originals `peer` lacks" (§7.3): a diff over `blob_locations`, not
   * a list of files, which is what makes pressing it again restart recovery.
   */
  async pushDiff(libraryId: string, peer: string, scope: BlobScope): Promise<number> {
    const library = this.library(libraryId);
    // The diff reads location rows, so this peer's own must be current first.
    await this.locations.reconcile(library);
    const lacking = this.locations.heldHereLackedBy(libraryId, peer, this.scopeIds(libraryId, scope));
    return this.enqueue(libraryId, peer, 'push', lacking);
  }

  /**
   * Queues originals for a peer that works out for itself what it is owed (§14.3).
   *
   * The backup pass reads a table of its own rather than `blob_locations` - a folder holds no
   * opinion about what it has - so it arrives here with the list already computed, where a push to
   * a device arrives with a scope and has the diff taken for it.
   */
  queuePush(libraryId: string, peer: string, photoIds: readonly string[]): number {
    const queued = this.enqueue(libraryId, peer, 'push', photoIds);
    this.kick();
    return queued;
  }

  /** Fetches named originals from one holder, with no failing over to another. */
  queuePull(libraryId: string, peer: string, photoIds: readonly string[]): number {
    const queued = this.enqueue(libraryId, peer, 'pull', photoIds);
    this.kick();
    return queued;
  }

  /** The same diff the other way: fetch what `peer` holds that this replica lacks. */
  async pullDiff(libraryId: string, peer: string, scope: BlobScope): Promise<number> {
    const library = this.library(libraryId);
    // Refused here as well as per transfer: a read-only library cannot take a file,
    // so queuing the diff only spends a download apiece to learn that N times.
    if (library.read_only) throw new AppError('READ_ONLY', `library ${library.name} is read-only`);
    await this.locations.reconcile(library);
    const lacking = this.locations.heldByLackedHere(libraryId, peer, this.scopeIds(libraryId, scope));
    return this.enqueue(libraryId, peer, 'pull', lacking);
  }

  /**
   * §7.5: opening a photo whose original is remote streams it from a holder and
   * keeps it. Null when the original is already local. Cancellable through the
   * queue entry it returns.
   *
   * @param from the one holder to take it from, which is what reading an offloaded original does
   * (§14.4): its copy is on a drive this device can see, and a device on the network that also has
   * it must not be pulled from instead. Absent is the person's own ask, which takes whichever
   * holder answers and moves on to the next when one fails.
   */
  fetchOriginal(photoId: string, from?: string): Transfer | null {
    const photo = this.photo(photoId);
    const library = this.library(photo.library_id);
    if (existsSync(originalToTransfer(library, photo))) return null;
    const holders = from == null ? this.otherHolders(library.id, photoId) : [from];
    if (holders.length === 0) throw new AppError('NOT_FOUND', `no peer is recorded as holding ${photoId}`);
    const peer = this.dialable(holders)[0];
    if (peer == null) {
      throw new AppError(
        'VALIDATION_ERROR',
        `${holders.length} peer(s) hold ${photoId}, and none of them can be reached from here: ` +
          'they dialled whoever they joined through, and only that device knows where they are',
      );
    }
    this.enqueue(library.id, peer, 'pull', [photoId]);
    const queued = this.byKey(library.id, photoId, peer, 'pull');
    if (queued != null && from == null) this.anyHolderWillDo.add(queued.id);
    this.kick();
    return queued;
  }

  /**
   * Everywhere but here the original is, which is the set a fetch chooses from.
   *
   * Devices and backup folders together, and deliberately in that order: a device on the network
   * usually answers faster than a drive somebody has to have plugged in, and `dialable` takes the
   * first that can be reached at all.
   */
  private otherHolders(libraryId: string, photoId: string): string[] {
    return [
      ...this.locations.holders(libraryId, photoId).filter((peer) => peer !== this.locations.selfId()),
      ...this.backups.holders(libraryId, photoId),
    ];
  }

  /**
   * The holders this device could actually ask, in the order it should ask them.
   *
   * `blob_locations` replicates, so it names holders this peer has never paired
   * with: a device that joined the library through somebody else is recorded here
   * and has no address anywhere on this machine (§6.4). Asking it is a request
   * that cannot be honoured, and taking the first name in the table meant a
   * photograph went unfetched with a copy one hop away.
   */
  private dialable(holders: readonly string[]): string[] {
    return holders.filter((peer) => this.transport.canReach(peer));
  }

  /**
   * Hands a failed fetch to the next holder that has not been tried.
   *
   * What fetch-on-open asked for is the photograph's original, not one device's
   * copy of it, so a holder that is offline or no longer has the bytes is the
   * wrong peer rather than a refusal. The failed row is left standing, so which
   * peers were tried is on the transfer list rather than swallowed, and a
   * photograph every holder refuses ends with one failed row each and no fetch
   * outstanding.
   */
  private tryNextHolder(item: Transfer): void {
    const tried = new Set(
      (
        this.db
          .query("SELECT peer_id FROM blob_transfers WHERE library_id = ? AND photo_id = ? AND direction = 'pull'")
          .all(item.library_id, item.photo_id) as { peer_id: string }[]
      ).map((row) => row.peer_id),
    );
    const next = this.dialable(this.otherHolders(item.library_id, item.photo_id)).find((peer) => !tried.has(peer));
    if (next == null) return;
    log.info('a fetch is moving to another holder', { photo: item.photo_id, from: item.peer_id, to: next });
    this.enqueue(item.library_id, next, 'pull', [item.photo_id]);
    const queued = this.byKey(item.library_id, item.photo_id, next, 'pull');
    if (queued != null) this.anyHolderWillDo.add(queued.id);
  }

  list(libraryId?: string): Transfer[] {
    if (libraryId == null) {
      return this.db.query(`SELECT ${COLUMNS} FROM blob_transfers ORDER BY queued_at, id`).all() as Transfer[];
    }
    return this.db
      .query(`SELECT ${COLUMNS} FROM blob_transfers WHERE library_id = ? ORDER BY queued_at, id`)
      .all(libraryId) as Transfer[];
  }

  get(id: string): Transfer {
    const row = this.db.query(`SELECT ${COLUMNS} FROM blob_transfers WHERE id = ?`).get(id) as Transfer | null;
    if (row == null) throw new AppError('NOT_FOUND', `transfer not found: ${id}`);
    return row;
  }

  pause(id: string): void {
    const item = this.get(id);
    if (item.state !== 'queued' && item.state !== 'active') return;
    this.db.query("UPDATE blob_transfers SET state = 'paused' WHERE id = ?").run(id);
    this.aborts.get(id)?.abort();
    // A paused entry is one nothing will finish, so whoever was waiting on the picture is told
    // now rather than left holding a request until somebody resumes it.
    this.wake(id);
  }

  resume(id: string): void {
    const item = this.get(id);
    if (item.state !== 'paused' && item.state !== 'failed') return;
    this.db.query("UPDATE blob_transfers SET state = 'queued', error = NULL WHERE id = ?").run(id);
    this.kick();
  }

  async cancel(id: string): Promise<void> {
    const item = this.get(id);
    if (item.state === 'done') return;
    this.db.query("UPDATE blob_transfers SET state = 'cancelled' WHERE id = ?").run(id);
    this.aborts.get(id)?.abort();
    this.wake(id);
    if (item.direction === 'pull') {
      const library = this.library(item.library_id);
      const stage = stagePath(library, item.photo_id);
      if (existsSync(stage)) await deleteStagedBlob(stagingDir(library), stage);
    }
  }

  /**
   * Drops what this library still has coming in, for a device that has just said
   * it does not keep RAW files (§7.10). Without it the queue goes on delivering
   * exactly what the setting was turned off to stop.
   */
  async cancelIncoming(libraryId: string): Promise<number> {
    const pending = this.db
      .query(
        `SELECT id FROM blob_transfers
          WHERE library_id = ? AND direction = 'pull' AND state IN ('queued', 'active', 'paused')`,
      )
      .all(libraryId) as { id: string }[];
    // Each on its own: the state is already written when the stage file is removed,
    // and removing one can fail for reasons that say nothing about the rest - a
    // handle the download still holds is refused on Windows. Letting the first one
    // decide would leave the remainder of the queue delivering exactly what the
    // setting was turned off to stop.
    let cancelled = 0;
    for (const item of pending) {
      try {
        await this.cancel(item.id);
        cancelled += 1;
      } catch (err) {
        log.warn('could not cancel an incoming transfer', { transfer: item.id, err: String(err) });
      }
    }
    return cancelled;
  }

  /** Drops what is still queued for one peer, for a backup folder somebody has unpaired (§14.1). */
  async cancelFor(libraryId: string, peerId: string): Promise<number> {
    const pending = this.db
      .query(
        `SELECT id FROM blob_transfers
          WHERE library_id = ? AND peer_id = ? AND state IN ('queued', 'active', 'paused')`,
      )
      .all(libraryId, peerId) as { id: string }[];
    let cancelled = 0;
    for (const item of pending) {
      try {
        await this.cancel(item.id);
        cancelled += 1;
      } catch (err) {
        log.warn('could not cancel a transfer', { transfer: item.id, err: String(err) });
      }
    }
    return cancelled;
  }

  /** Starts the queue without waiting on it; enqueue paths and startup call this. */
  kick(): void {
    void this.drain().catch((error: unknown) => log.error('transfer queue stopped', { err: String(error) }));
  }

  // One worker; a second drain awaits the one in flight rather than racing it.
  drain(): Promise<void> {
    this.draining ??= this.processQueued().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /**
   * Waits for one queue entry to reach a state it will not leave by itself.
   *
   * What opening an offloaded photograph waits on (§14.4). Per entry rather than on the drain,
   * which only settles when the queue has emptied: a read of one photograph must not wait out a
   * backup pass of ten thousand.
   */
  settled(id: string): Promise<Transfer> {
    const item = this.get(id);
    if (item.state !== 'queued' && item.state !== 'active') return Promise.resolve(item);
    return new Promise((resolve) => {
      this.waiting.set(id, [...(this.waiting.get(id) ?? []), resolve]);
    });
  }

  private wake(id: string): void {
    const waiters = this.waiting.get(id);
    if (waiters == null) return;
    this.waiting.delete(id);
    const item = this.get(id);
    for (const resolve of waiters) resolve(item);
  }

  private async processQueued(): Promise<void> {
    for (;;) {
      // Pulls first, whatever the order they were asked in: a pull is somebody waiting for a
      // picture and a push is housekeeping, so a fetch-on-open queued behind a backup pass of the
      // whole library would otherwise wait out the library.
      const item = this.db
        .query(
          `SELECT ${COLUMNS} FROM blob_transfers WHERE state = 'queued'
            ORDER BY direction = 'push', queued_at, id LIMIT 1`,
        )
        .get() as Transfer | null;
      if (item == null) return;
      await this.run(item);
    }
  }

  /**
   * §7.6: "remove local copy", only on a live confirmation from `peer` that it
   * holds the bytes *at this moment* - existence plus a hash spot-check against
   * the recorded `content_hash`. The replicated table alone is never enough
   * (§7.2): its rows are stale by construction.
   */
  async evict(photoIds: readonly string[], peer: string): Promise<EvictResult> {
    const evicted: string[] = [];
    const refused: EvictResult['refused'] = [];
    for (const photoId of photoIds) {
      const reason = await this.evictOne(photoId, peer);
      if (reason == null) evicted.push(photoId);
      else refused.push({ photo_id: photoId, reason });
    }
    return { evicted, refused };
  }

  /** What a peer's possession check has to take into account (§7.6). */
  isEvicting(libraryId: string, photoId: string): boolean {
    return isEvicting(this.db, libraryId, photoId);
  }

  /** Whether the file at this photograph's path may not be its own (§7.4, §7.7). */
  isUnsettled(libraryId: string, photoId: string): boolean {
    return unsettled(this.db, libraryId).some((entry) => entry.photoId === photoId);
  }

  /**
   * The copy leaving this disk, once everything about the photograph has been checked but the
   * other copy.
   *
   * The two arms are two different safety arguments and neither can be made from the other. A
   * device is asked, because only it can say what it holds *now* and its answer is a promise it
   * is keeping by refusing to evict at the same moment (§7.6). A backup is read, because a folder
   * promises nothing and cannot be asked - so this device hashes both copies itself, here, where
   * the deletion happens (§14.5).
   */
  private async removeLocalCopy(
    photo: BasicPhoto,
    library: Library,
    at: string,
    abs: string,
    recorded: string,
    peer: string,
  ): Promise<string | null> {
    const backup = passivePeerOf(this.db, peer);
    if (backup != null) {
      const entry = this.backups.entry(library.id, backup.peerId, photo.id);
      if (entry == null) return 'the backup holds no copy of this photo';
      if (!mirrorReady(backup.root, library.id)) return `the backup folder is not there: ${backup.root}`;
      return await this.refusable(() =>
        libraryMutex.run(library.id, async () => {
          await deleteBackedUpOriginal(library.root_path, abs, backupPath(backup.root, entry.rel_path), recorded);
          this.retire(library.id, photo.id, at);
        }),
      );
    }

    let confirmation: BlobVerifyResponse;
    try {
      const res = await this.transport.request(peer, route(photo.id, PathSegment.verify()));
      if (!res.ok) return `peer answered ${res.status} to the possession check`;
      confirmation = BlobVerifyResponseSchema.parse(await res.json());
    } catch (error) {
      return `peer could not be reached for a live possession check: ${String(error)}`;
    }
    if (!confirmation.held || confirmation.content_hash !== recorded) {
      return 'peer could not verify possession of a matching copy';
    }
    return await this.refusable(() =>
      libraryMutex.run(library.id, async () => {
        await deleteEvictedOriginal(library.root_path, abs, confirmation, recorded);
        this.retire(library.id, photo.id, at);
      }),
    );
  }

  /**
   * The deletion's own refusal, reported as one.
   *
   * Every check above is made again inside `utils/deletions.ts`, against the files rather than
   * against the rows, and a copy that fails one there is a photograph that keeps its original -
   * which is the answer `evict` promises per photograph. Thrown instead, one refused copy ends the
   * whole batch, and a cull that meets a half-written backup stops rather than stepping over it.
   */
  private async refusable(remove: () => Promise<void>): Promise<string | null> {
    try {
      await remove();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  // What the catalogue records about an original that has just left this disk. Both halves
  // together or neither: a retracted row with the flag unset advertises a fetch nobody can serve.
  private retire(libraryId: string, photoId: string, at: string): void {
    this.locations.retract(libraryId, photoId);
    this.photoMetadata.setMissing(photoId, at);
  }

  private async evictOne(photoId: string, peer: string): Promise<string | null> {
    let photo: BasicPhoto;
    let library: Library;
    try {
      photo = this.photo(photoId);
      library = this.library(photo.library_id);
    } catch (error) {
      return (error as Error).message;
    }
    if (library.read_only) return `library ${library.name} is read-only`;
    // Marked before the peer is asked and held until the file is gone, because the
    // question being asked of the peer is the one being asked of this device at the
    // same moment. Two peers each keeping a photograph "on the other" both hear yes
    // otherwise - neither has deleted yet - and the original ends up nowhere (§7.6).
    const refusal = await whileEvicting(this.db, library.id, photoId, async () => {
      const recorded = this.photoMetadata.contentHashOf(photoId);
      if (recorded == null) return 'never transferred: no verified copy exists anywhere else';
      // The row's path is only where the bytes are when the two agree. Where a
      // merged move has not run, or a transfer refused to overwrite what it found,
      // the file sitting there belongs to somebody else - and the peer is being
      // asked about *its* copy, so it says yes and this unlinks the occupant. That
      // is the photographer's own file, never imported, deleted to free space for a
      // photograph whose original is somewhere else entirely.
      if (unsettled(this.db, library.id).some((entry) => entry.photoId === photoId)) {
        return 'this photograph has a move or a collision outstanding, so what is at its path may not be its own';
      }
      const at = soleInputOf(photo.recipe);
      const abs = originalPathOf(library, photo);
      // A row composed out of others holds no original, so there is nothing here an eviction
      // would free: what it costs this device is its renditions, which the cache sweeps.
      if (at == null || abs == null) return 'this photograph is composed rather than imported, so it has no original to evict';
      if (!existsSync(abs)) return 'the original is not on this device';
      return await this.removeLocalCopy(photo, library, at, abs, recorded, peer);
    });
    return refusal === 'busy' ? 'this device is already removing its copy' : refusal;
  }

  private scopeIds(libraryId: string, scope: BlobScope): readonly string[] | undefined {
    if ('library' in scope) return undefined;
    if ('photo_ids' in scope) return scope.photo_ids;
    const rows = this.db
      .query('SELECT id FROM photos WHERE library_id = ? AND shoot_id = ?')
      .all(libraryId, scope.shoot_id) as { id: string }[];
    return rows.map((row) => row.id);
  }

  private enqueue(libraryId: string, peer: string, direction: TransferDirection, photoIds: readonly string[]): number {
    let queued = 0;
    this.db.transaction(() => {
      for (const photoId of photoIds) {
        const existing = this.byKey(libraryId, photoId, peer, direction);
        if (existing == null) {
          this.db
            .query(
              `INSERT INTO blob_transfers (id, library_id, photo_id, peer_id, direction, queued_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(newId(), libraryId, photoId, peer, direction, new Date().toISOString());
          queued += 1;
        } else if (existing.state === 'failed' || existing.state === 'cancelled' || existing.state === 'done') {
          this.db.query("UPDATE blob_transfers SET state = 'queued', error = NULL WHERE id = ?").run(existing.id);
          queued += 1;
        }
      }
    })();
    return queued;
  }

  private byKey(libraryId: string, photoId: string, peer: string, direction: TransferDirection): Transfer | null {
    return this.db
      .query(`SELECT ${COLUMNS} FROM blob_transfers WHERE library_id = ? AND photo_id = ? AND peer_id = ? AND direction = ?`)
      .get(libraryId, photoId, peer, direction) as Transfer | null;
  }

  private async run(item: Transfer): Promise<void> {
    const abort = new AbortController();
    this.aborts.set(item.id, abort);
    this.db.query("UPDATE blob_transfers SET state = 'active' WHERE id = ?").run(item.id);
    try {
      const photo = this.photo(item.photo_id);
      const library = this.library(item.library_id);
      if (item.direction === 'push') await this.push(item, photo, library, abort.signal);
      else await this.pull(item, photo, library, abort.signal);
      this.db.query("UPDATE blob_transfers SET state = 'done', error = NULL WHERE id = ?").run(item.id);
    } catch (error) {
      // pause() and cancel() abort the in-flight request having already written
      // the state they wanted; overwriting it here would resurrect the item.
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.db.query("UPDATE blob_transfers SET state = 'failed', error = ? WHERE id = ?").run(message, item.id);
      // Queued rather than run here, so it is the drain that takes it and the
      // retry is bounded by the same single worker as everything else.
      if (this.anyHolderWillDo.has(item.id)) this.tryNextHolder(item);
    } finally {
      this.aborts.delete(item.id);
      this.anyHolderWillDo.delete(item.id);
      this.wake(item.id);
    }
  }

  private async push(item: Transfer, photo: BasicPhoto, library: Library, signal: AbortSignal): Promise<void> {
    const abs = originalToTransfer(library, photo);
    if (!existsSync(abs)) throw new AppError('NOT_FOUND', `original not on disk: ${photo.id}`);
    const file = Bun.file(abs);
    const size = file.size;

    const stagedRes = await this.transport.request(item.peer_id, route(photo.id, PathSegment.stage()), { signal });
    if (!stagedRes.ok) throw new AppError('IO_ERROR', `peer answered ${stagedRes.status} for staged size`);
    const { staged, held } = BlobStageResponseSchema.parse(await stagedRes.json());
    if (held) {
      this.progress(item.id, size, size);
      return;
    }
    if (staged > size) throw new AppError('CONFLICT', `peer holds ${staged} staged bytes of a ${size}-byte file`);

    // §7.1: hashed while streaming - the bytes already staged prime the hash, the
    // rest is hashed as it is read to be sent, and no separate hashing pass runs.
    const hasher = new Bun.CryptoHasher('sha256');
    if (staged > 0) hasher.update(await file.slice(0, staged).arrayBuffer());
    let sent = staged;
    this.progress(item.id, sent, size);
    while (sent < size) {
      const chunk = await file.slice(sent, Math.min(sent + PUSH_CHUNK, size)).arrayBuffer();
      // A file truncated under a running push yields nothing past its new end, and
      // an empty chunk advances `sent` by nothing: the loop would PUT empty bodies
      // at a fixed offset for ever, which the receiver accepts and which never
      // finishes. Deletion mid-push fails the read and is answered already; this is
      // the case that reads fine and cannot progress.
      if (chunk.byteLength === 0) {
        throw new AppError('IO_ERROR', `the original shrank under this transfer: ${sent} of ${size} bytes sent`);
      }
      hasher.update(chunk);
      const res = await this.transport.request(item.peer_id, `${route(photo.id, PathSegment.stage())}?offset=${sent}`, {
        method: 'PUT',
        body: chunk,
        signal,
      });
      if (!res.ok) throw new AppError('IO_ERROR', `peer refused bytes at ${sent}: ${res.status}`);
      sent += chunk.byteLength;
      this.progress(item.id, sent, size);
    }
    const computed = hasher.digest('hex');
    const recorded = this.photoMetadata.contentHashOf(photo.id);
    if (recorded != null && computed !== recorded) {
      throw new AppError('CONFLICT', `this copy no longer matches its recorded content hash`);
    }

    const commit = await this.transport.request(item.peer_id, route(photo.id, PathSegment.commit()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BlobCommitRequestSchema.parse({ content_hash: recorded ?? computed })),
      signal,
    });
    if (!commit.ok) {
      throw new AppError('CONFLICT', `peer refused the transfer: ${await commitError(commit)}`);
    }
    if (recorded == null) {
      // The first transfer is the moment the hash starts existing (§7.1), stamped
      // into the imported unit as an ordinary replicated write.
      this.photoMetadata.setContentHash(photo.id, computed);
    }
    this.locations.record(library.id, photo.id);
  }

  private async pull(item: Transfer, photo: BasicPhoto, library: Library, signal: AbortSignal): Promise<void> {
    if (library.read_only) throw new AppError('READ_ONLY', `library ${library.name} is read-only`);
    // Two peers holding the same original queue two pulls of it, the entries
    // differing only by which peer they name. The first lands the file; without
    // this the second downloads the whole thing again and then finds its target
    // occupied - by the copy the first one just put there - so it flags a collision
    // against itself, fails, and does it again on every retry.
    if (existsSync(originalToTransfer(library, photo))) return;
    const stage = stagePath(library, photo.id);
    let done = stagedSize(stage);

    const res = await this.transport.request(item.peer_id, route(photo.id, PathSegment.original()), {
      headers: done > 0 ? { range: `bytes=${done}-` } : {},
      signal,
    });
    if (!res.ok || res.body == null) {
      throw new AppError('IO_ERROR', `peer answered ${res.status} for the original`);
    }
    const remaining = Number(res.headers.get('content-length'));
    const total = Number.isFinite(remaining) && remaining > 0 ? done + remaining : null;
    this.progress(item.id, done, total);
    let sinceWrite = 0;
    await appendToStage(stage, done, res.body, (bytes) => {
      done += bytes;
      sinceWrite += bytes;
      if (sinceWrite >= PROGRESS_EVERY) {
        sinceWrite = 0;
        this.progress(item.id, done, total);
      }
    });
    this.progress(item.id, done, total ?? done);

    const expected = this.photoMetadata.contentHashOf(photo.id) ?? (await this.senderHash(item.peer_id, photo.id));
    const computed = await contentHash(stage);
    if (computed !== expected) {
      await deleteStagedBlob(stagingDir(library), stage);
      throw new AppError('VALIDATION_ERROR', `discarded download of ${photo.id}: bytes hash ${computed}, expected ${expected}`);
    }
    await acceptVerifiedBlob(this.photoPaths, this.photoMetadata, this.locations, library, photo.id, stage, this.build);
  }

  private async senderHash(peer: string, photoId: string): Promise<string> {
    const res = await this.transport.request(peer, route(photoId, PathSegment.hash()));
    if (!res.ok) throw new AppError('IO_ERROR', `peer answered ${res.status} for the content hash`);
    return BlobHashResponseSchema.parse(await res.json()).content_hash;
  }

  private progress(id: string, done: number, total: number | null): void {
    this.db.query('UPDATE blob_transfers SET bytes_done = ?, bytes_total = ? WHERE id = ?').run(done, total, id);
  }

  private photo(photoId: string): BasicPhoto {
    const photo = this.photoPaths.getBasicById(photoId);
    if (photo == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    return photo;
  }

  private library(libraryId: string): Library {
    const library = this.libraries.getById(libraryId);
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return library;
  }
}

async function commitError(res: Response): Promise<string> {
  const envelope = ErrorEnvelopeSchema.safeParse(await res.json().catch(() => null));
  return envelope.success ? envelope.data.error.message : `status ${res.status}`;
}
