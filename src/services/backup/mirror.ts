import { statSync } from 'node:fs';
import path from 'node:path';
import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import {
  BackupReportSchema,
  type BackupAccess, type BackupActivity, type BackupCoverage, type BackupIssue, type BackupIssues, type BackupPhase,
  type BackupReport, type BackupRunResponse, type BackupStatus, type ConfiguredBackupStatus, type FetchBackProgress,
} from '../../schemas/backup';
import type { ActivityKind } from '../../schemas/activity';
import type { Transfer } from '../../schemas/blobs';
import { newId } from '../../schemas/id';
import type { LibraryConfiguration as Library } from '../../schemas/libraries';
import { ensureDir } from '../../utils/files';
import { contentHash } from '../../utils/hash';
import { containsPath } from '../../utils/paths';
import { LibraryActivity } from '../activity/library_activity';
import { isOnDisk } from '../blobs/blob_store';
import type { TransferService } from '../blobs/transfer_service';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import { linkLibrary, registerPeer } from '../replication/pairing';
import { libraryMutex } from '../sync/coordination/library_mutex';
import { BackupError, backupIssueCode, transferIssueCode } from './backup_error';
import type { BackupEntry, BackupLocations } from './backup_locations';
import { assertMirrorOf, backupPath, backupStagingDir, markerPath, mirrorAccess, readMarker } from './backup_root';
import type { Cull } from './cull';
import { passivePeersOf, placeInMirror, type PassivePeer } from './passive_peers';

const log = new Logger('mirror');
const PASS_EVERY_MS = 15 * 60 * 1000;
const SCRUB_PER_PASS = 500;
const ISSUE_SAMPLES = 10;

interface Operation {
  activity: BackupActivity;
  transfers: ReadonlySet<string>;
}

class IssueTally {
  readonly issues: BackupIssues = { total: 0, counts: [], samples: [] };
  private readonly seen = new Set<string>();

  add(issue: BackupIssue): void {
    const key = JSON.stringify([issue.code, issue.photo_id ?? issue.path]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.issues.total += 1;
    const count = this.issues.counts.find((item) => item.code === issue.code);
    if (count == null) this.issues.counts.push({ code: issue.code, count: 1 });
    else count.count += 1;
    if (this.issues.samples.length < ISSUE_SAMPLES) this.issues.samples.push(issue);
  }
}

function issueOf(error: unknown, phase: BackupPhase, photoId: string | null = null, at: string | null = null): BackupIssue {
  return { code: backupIssueCode(error), phase, photo_id: photoId, path: at };
}

function overallStatus(
  access: BackupAccess,
  activity: BackupActivity | null,
  issues: BackupIssues,
  pending: readonly Transfer[],
  coverage: BackupCoverage,
): ConfiguredBackupStatus['status'] {
  if (access !== 'ready') return 'unavailable';
  if (activity != null) return 'working';
  if (issues.counts.some((issue) => issue.code !== 'paused')) return 'attention';
  if (pending.some((item) => item.state === 'paused')) return 'paused';
  if (coverage.pending > 0 || pending.some((item) => item.state === 'queued')) return 'waiting';
  return coverage.originals === 0 ? 'empty' : 'current';
}

export class Mirror {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly operations = new Map<string, Operation>();
  private readonly finishes = new Map<string, () => void>();

  constructor(
    private readonly db: Database,
    private readonly libraries: LibrariesRepository,
    private readonly backups: BackupLocations,
    private readonly transfers: TransferService,
    private readonly cull: Cull,
    private readonly activity = new LibraryActivity(),
    private readonly changed: (libraryId: string) => void = () => {},
  ) {
    this.transfers.onChanged((libraryId) => this.changed(libraryId));
  }

  start(): void {
    this.timer ??= setInterval(() => void this.runAll(), PASS_EVERY_MS);
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  async runAll(): Promise<void> {
    for (const library of this.libraries.listConfigurations()) await this.runScheduled(library.id);
  }

  async runScheduled(libraryId: string): Promise<void> {
    if (this.targetOf(libraryId) == null || this.operations.has(libraryId)) return;
    try {
      await this.run(libraryId);
    } catch (error) {
      log.warn('a backup pass stopped', { library: libraryId, err: String(error) });
    }
  }

  private targetOf(libraryId: string): PassivePeer | null {
    return passivePeersOf(this.db, libraryId)[0] ?? null;
  }

  status(libraryId: string): BackupStatus {
    const library = this.library(libraryId);
    const peer = this.targetOf(libraryId);
    if (peer == null) return { library_id: libraryId, configured: false };
    const row = this.db.query(
      'SELECT name, last_backup_report, last_restore_report FROM replication_peers WHERE library_id = ? AND peer_id = ?',
    ).get(libraryId, peer.peerId) as { name: string; last_backup_report: string | null; last_restore_report: string | null };
    const items = this.transfers.list(libraryId).filter((item) => item.peer_id === peer.peerId);
    const pending = this.pendingTransfers(libraryId, peer.peerId, items);
    const access = mirrorAccess(peer.root, libraryId, library.name, peer.peerId);
    const coverage = this.backups.coverage(libraryId, peer.peerId);
    const activity = this.activityOf(libraryId, items);
    const tally = new IssueTally();
    if (access !== 'ready') tally.add({ code: access, phase: 'checking', photo_id: null, path: peer.root });
    for (const item of pending) {
      if (item.state === 'failed' || item.state === 'paused' || item.state === 'cancelled') {
        tally.add(this.transferIssue(item, item.direction === 'pull' ? 'restoring' : 'copying'));
      }
    }
    this.standingIssues(libraryId, peer.peerId, tally);
    const budget = this.cull.budget(libraryId);
    return {
      library_id: libraryId, configured: true, peer_id: peer.peerId, name: row.name, path: peer.root,
      status: overallStatus(access, activity, tally.issues, pending, coverage),
      access, activity, coverage, issues: tally.issues,
      transfers: {
        queued: pending.filter((item) => item.state === 'queued').length,
        active: items.filter((item) => item.state === 'active').length,
        paused: pending.filter((item) => item.state === 'paused').length,
        failed: pending.filter((item) => item.state === 'failed').length,
        cancelled: pending.filter((item) => item.state === 'cancelled').length,
      },
      local_bytes: this.cull.localBytes(libraryId), local_budget_bytes: budget, budget_unmet: this.cull.budgetUnmet(libraryId),
      last_backup_report: this.readReport(row.last_backup_report), last_restore_report: this.readReport(row.last_restore_report),
    };
  }

  /** Transfers to this backup whose photo still needs them: pushes of owed originals, pulls of missing ones. */
  private pendingTransfers(libraryId: string, peerId: string, items: readonly Transfer[]): Transfer[] {
    const owed = new Set(this.backups.owed(libraryId, peerId).map((photo) => photo.photo_id));
    const missing = new Set((this.db.query(
      "SELECT id FROM photos WHERE library_id = ? AND is_missing = 1 AND json_extract(recipe, '$.kind') = 'file'",
    ).all(libraryId) as { id: string }[]).map((photo) => photo.id));
    return items.filter((item) => item.direction === 'pull' ? missing.has(item.photo_id) : owed.has(item.photo_id));
  }

  private activityOf(libraryId: string, items: readonly Transfer[]): BackupActivity | null {
    const operation = this.operations.get(libraryId);
    if (operation != null && operation.transfers.size > 0) {
      const tracked = items.filter((item) => operation.transfers.has(item.id));
      return {
        ...operation.activity,
        done: tracked.filter((item) => item.state === 'done').length, total: tracked.length, current: this.current(tracked),
      };
    }
    if (operation != null) return operation.activity;
    const moving = items.find((item) => item.state === 'active');
    if (moving == null) return null;
    return { phase: moving.direction === 'pull' ? 'restoring' : 'copying', done: 0, total: 1, current: this.current([moving]) };
  }

  private standingIssues(libraryId: string, peerId: string, tally: IssueTally): void {
    for (const copy of this.backups.unhealthy(libraryId, peerId)) {
      tally.add({ code: copy.health === 'missing' ? 'backup_missing' : 'backup_changed', phase: 'checking', photo_id: copy.photo_id, path: copy.rel_path });
    }
    for (const issue of this.backups.issues(libraryId, peerId)) tally.add(issue);
    for (const photo of this.backups.lost(libraryId, peerId)) {
      tally.add({ code: 'local_missing', phase: 'checking', photo_id: photo.photo_id, path: photo.rel_path });
    }
    if (this.cull.budgetUnmet(libraryId)) tally.add({ code: 'budget_unmet', phase: 'offloading', photo_id: null, path: null });
  }

  private readReport(serialized: string | null): BackupReport | null {
    if (serialized == null) return null;
    try {
      const parsed = BackupReportSchema.safeParse(JSON.parse(serialized));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  list(): BackupStatus[] {
    return this.libraries.listConfigurations().map((library) => this.status(library.id));
  }

  async setTarget(libraryId: string, root: string, name?: string): Promise<BackupStatus> {
    const library = this.library(libraryId);
    this.begin(libraryId, 'configuring', 'backing_up');
    const { report, tally } = this.report('configure');
    try {
      const at = path.resolve(root);
      this.assertUsable(library, at);
      const existing = this.targetOf(libraryId);
      await libraryMutex.run(libraryId, async () => {
        const marker = readMarker(at);
        if (marker != null && marker.library_id !== libraryId) {
          throw new BackupError('wrong_library', `This folder backs up "${marker.library_name}". Choose another folder.`);
        }
        const peerId = marker?.peer_id ?? newId();
        if (this.db.query("SELECT 1 FROM replication_peers WHERE peer_id = ? AND (kind <> 'passive' OR library_id <> ?) LIMIT 1").get(peerId, libraryId) != null
          || this.db.query('SELECT 1 FROM replication_identity WHERE peer_id = ?').get(peerId) != null) {
          throw new BackupError('wrong_backup', 'This backup marker names a device. Choose another folder or restore its backup marker.');
        }
        const photos = this.originalPhotos(libraryId);
        const problems = existing == null ? [] : this.backups.issues(libraryId, existing.peerId);
        const localVerified = new Set<string>();
        const verified = new Map<string, { at: string; size: number; hash: string }>();
        const evidence = new Map<string, BackupEntry>();
        for (const photo of photos) {
          const old = existing == null ? null : this.backups.entry(libraryId, existing.peerId, photo.id);
          if (old == null && photo.is_missing === 0) continue;
          if (old != null && existing?.root === at) evidence.set(photo.id, old);
          const expected = photo.content_hash ?? old?.content_hash ?? null;
          const paths = [...new Set([photo.path, old?.rel_path].filter((value): value is string => value != null))];
          for (const relative of paths) {
            const copy = backupPath(at, relative);
            if (!isOnDisk(copy) || expected == null || (await contentHash(copy)) !== expected) continue;
            verified.set(photo.id, { at: relative, size: Bun.file(copy).size, hash: expected });
            break;
          }
          const local = backupPath(library.root_path, photo.path);
          if (expected != null && isOnDisk(local) && (await contentHash(local)) === expected) localVerified.add(photo.id);
          if (existing != null && existing.root !== at && old != null && !verified.has(photo.id) && !localVerified.has(photo.id)) {
            throw new BackupError('local_missing', 'Some originals are only on the current backup. Restore them before choosing another folder.');
          }
        }
        await ensureDir(at);
        // Hashing above can take minutes, long enough for another device sharing the folder to claim it.
        const stillSelected = readMarker(at);
        if (stillSelected?.peer_id !== marker?.peer_id || stillSelected?.library_id !== marker?.library_id) {
          throw new BackupError('wrong_backup', 'The backup marker changed while selecting the folder. Select it again.');
        }
        await Bun.write(markerPath(at), `${JSON.stringify({ library_id: libraryId, library_name: library.name, peer_id: peerId }, null, 2)}\n`);
        linkLibrary(this.db, libraryId);
        if (existing != null) {
          await this.transfers.cancelFor(libraryId, existing.peerId);
          if (existing.root !== at) await this.transfers.sweepStages(backupStagingDir(existing.root), libraryId, existing.peerId);
          if (existing.peerId !== peerId) this.forget(libraryId, existing.peerId);
        }
        registerPeer(this.db, libraryId, peerId, name ?? path.basename(at), at, 'passive');
        this.backups.forget(libraryId, peerId);
        for (const [photoId, copy] of verified) this.backups.record(libraryId, peerId, photoId, copy.at, copy.hash, copy.size);
        for (const [photoId, copy] of evidence) {
          if (verified.has(photoId)) continue;
          this.backups.record(libraryId, peerId, photoId, copy.rel_path, copy.content_hash, copy.size);
          this.backups.mark(libraryId, peerId, photoId, isOnDisk(backupPath(at, copy.rel_path)) ? 'changed' : 'missing');
        }
        for (const photo of photos) {
          if (verified.has(photo.id)) continue;
          const copy = backupPath(at, photo.path);
          if (!isOnDisk(copy)) continue;
          const local = backupPath(library.root_path, photo.path);
          const expected = photo.content_hash ?? (isOnDisk(local) ? await contentHash(local) : null);
          if (expected != null && (await contentHash(copy)) === expected) {
            if (photo.content_hash != null) this.backups.record(libraryId, peerId, photo.id, photo.path, expected, Bun.file(copy).size);
          } else {
            tally.add({ code: 'path_conflict', phase: 'configuring', photo_id: photo.id, path: photo.path });
          }
        }
        for (const photo of photos) {
          if (photo.is_missing === 1 && !verified.has(photo.id)) tally.add({ code: 'local_missing', phase: 'configuring', photo_id: photo.id, path: photo.path });
        }
        for (const problem of problems) {
          if (problem.photo_id == null) continue;
          const copy = this.backups.entry(libraryId, peerId, problem.photo_id);
          if (copy == null) continue;
          if (problem.code === 'local_changed' ? !localVerified.has(problem.photo_id)
            : problem.phase === 'moving' && existing?.root === at && copy.rel_path !== problem.path) {
            this.backups.setIssue(libraryId, peerId, problem.photo_id, problem);
            tally.add(problem);
          }
        }
        this.finish({ libraryId, peerId, name: library.name, root: at }, report);
      });
    } finally {
      this.end(libraryId);
    }
    return this.status(libraryId);
  }

  async removeTarget(libraryId: string, fetchFirst: boolean): Promise<void> {
    const library = this.library(libraryId);
    const peer = this.targetOf(libraryId);
    if (peer == null) throw new AppError('NOT_FOUND', 'No backup folder is selected. Select one before removing it.');
    this.begin(libraryId, fetchFirst ? 'restoring' : 'configuring', fetchFirst ? 'restoring_backup' : null);
    try {
      if (fetchFirst) await this.fetchBack(peer, library);
      await this.transfers.cancelFor(libraryId, peer.peerId);
      await libraryMutex.run(libraryId, async () => {
        await this.transfers.sweepStages(backupStagingDir(peer.root), libraryId, peer.peerId);
        this.forget(libraryId, peer.peerId);
      });
    } finally {
      this.end(libraryId);
    }
  }

  fetchBackProgress(libraryId: string): FetchBackProgress | null {
    const operation = this.operations.get(libraryId);
    if (operation?.activity.phase !== 'restoring') return null;
    const items = this.transfers.list(libraryId).filter((item) => operation.transfers.has(item.id));
    return {
      done: items.filter((item) => item.state === 'done').length, total: items.length,
      failed: items.filter((item) => item.state === 'failed').length,
      paused: items.filter((item) => item.state === 'paused').length,
      cancelled: items.filter((item) => item.state === 'cancelled').length,
      current: this.current(items),
    };
  }

  private current(items: readonly Transfer[]): BackupActivity['current'] {
    const moving = items.find((item) => item.state === 'active');
    return moving == null ? null : { path: this.pathOf(moving.photo_id), bytes_done: moving.bytes_done, bytes_total: moving.bytes_total };
  }

  private pathOf(photoId: string): string {
    const row = this.db.query("SELECT json_extract(recipe, '$.path') AS path FROM photos WHERE id = ?").get(photoId) as { path: string | null } | null;
    return row?.path ?? photoId;
  }

  private async fetchBack(peer: PassivePeer, library: Library): Promise<void> {
    const { report, tally } = this.report('restore');
    let finished = false;
    try {
      assertMirrorOf(peer.root, peer.libraryId, library.name, peer.peerId);
      const owed = new Set(this.backups.offloadedTo(peer.libraryId, peer.peerId));
      this.transfers.queuePull(peer.libraryId, peer.peerId, [...owed]);
      const pulls = this.transfers.list(peer.libraryId).filter((item) => item.direction === 'pull' && item.peer_id === peer.peerId && owed.has(item.photo_id));
      this.track(peer.libraryId, pulls.map((item) => item.id), 'restoring');
      const settled = await Promise.all(pulls.map((item) => this.transfers.settled(item.id)));
      const left = new Set(this.backups.offloadedTo(peer.libraryId, peer.peerId));
      report.restored = settled.filter((item) => item.state === 'done' && !left.has(item.photo_id)).length;
      for (const item of settled) if (item.state !== 'done') tally.add(this.transferIssue(item, 'restoring'));
      if (left.size > 0 && tally.issues.total === 0) tally.add({ code: 'transfer_failed', phase: 'restoring', photo_id: null, path: null });
      this.finish(peer, report);
      finished = true;
      if (left.size > 0) {
        throw new AppError('CONFLICT', `${left.size} ${left.size === 1 ? 'original' : 'originals'} couldn't be restored. Your backup folder is still selected. Check its details and try again.`);
      }
    } catch (error) {
      if (!finished) {
        tally.add(issueOf(error, 'restoring'));
        this.finish(peer, report, true);
      }
      throw error;
    }
  }

  private forget(libraryId: string, peerId: string): void {
    this.db.query('DELETE FROM replication_peers WHERE library_id = ? AND peer_id = ?').run(libraryId, peerId);
    this.backups.forget(libraryId, peerId);
  }

  setBudget(libraryId: string, bytes: number | null): void {
    this.library(libraryId);
    linkLibrary(this.db, libraryId);
    this.db.query('UPDATE replication_libraries SET local_budget_bytes = ? WHERE library_id = ?').run(bytes, libraryId);
    this.changed(libraryId);
  }

  async run(libraryId: string): Promise<BackupRunResponse> {
    const library = this.library(libraryId);
    const peer = this.targetOf(libraryId);
    if (peer == null) throw new AppError('NOT_FOUND', 'No backup folder is selected. Select one before running a backup.');
    this.begin(libraryId, 'checking', 'backing_up');
    const { report, tally } = this.report('backup');
    try {
      assertMirrorOf(peer.root, libraryId, library.name, peer.peerId);
      await this.follow(peer, report);
      await this.scrub(peer, library, tally);
      await this.transfers.sweepStages(backupStagingDir(peer.root), libraryId, peer.peerId);
      const owed = new Set(this.backups.owed(libraryId, peer.peerId).map((photo) => photo.photo_id));
      this.transfers.queuePush(libraryId, peer.peerId, [...owed]);
      const pushes = this.transfers.list(libraryId).filter((item) => item.direction === 'push' && item.peer_id === peer.peerId && owed.has(item.photo_id));
      this.track(libraryId, pushes.map((item) => item.id), 'copying');
      const settled = await Promise.all(pushes.map((item) => this.transfers.settled(item.id)));
      report.copied = settled.filter((item) => item.state === 'done' && this.backups.entry(libraryId, peer.peerId, item.photo_id)?.health === 'held').length;
      for (const item of settled) if (item.state !== 'done') tally.add(this.transferIssue(item, 'copying'));
      this.phase(libraryId, 'offloading');
      const culled = await this.cull.toBudget(peer, (done, total) => this.phase(libraryId, 'offloading', done, total));
      report.offloaded = culled.evicted.length;
      for (const refusal of culled.refused) {
        tally.add({ code: refusal.error_code ?? 'transfer_failed', phase: 'offloading', photo_id: refusal.photo_id, path: this.pathOf(refusal.photo_id) });
      }
      this.standingIssues(libraryId, peer.peerId, tally);
      this.finish(peer, report);
    } catch (error) {
      tally.add(issueOf(error, this.operations.get(libraryId)?.activity.phase ?? 'checking'));
      this.finish(peer, report, true);
    } finally {
      this.end(libraryId);
    }
    return { status: this.status(libraryId), report };
  }

  private async follow(peer: PassivePeer, report: BackupReport): Promise<void> {
    const copies = this.backups.misplaced(peer.libraryId, peer.peerId);
    this.phase(peer.libraryId, 'moving', 0, copies.length);
    for (const copy of copies) {
      try {
        const entry = this.backups.entry(peer.libraryId, peer.peerId, copy.photo_id);
        if (entry == null) continue;
        const from = backupPath(peer.root, copy.was_at);
        const to = backupPath(peer.root, copy.belongs_at);
        if (isOnDisk(to) && (await contentHash(to)) === entry.content_hash) {
          this.backups.record(peer.libraryId, peer.peerId, copy.photo_id, copy.belongs_at, entry.content_hash, Bun.file(to).size);
          this.backups.clearIssue(peer.libraryId, peer.peerId, copy.photo_id, 'moving');
          report.moved += 1;
        } else if (!isOnDisk(from)) {
          this.backups.mark(peer.libraryId, peer.peerId, copy.photo_id, 'missing');
        } else if ((await contentHash(from)) !== entry.content_hash) {
          this.backups.mark(peer.libraryId, peer.peerId, copy.photo_id, 'changed');
        } else {
          await placeInMirror(from, to, copy.belongs_at);
          this.backups.moved(peer.libraryId, peer.peerId, copy.photo_id, copy.belongs_at);
          report.moved += 1;
        }
      } catch (error) {
        this.backups.setIssue(peer.libraryId, peer.peerId, copy.photo_id, issueOf(error, 'moving', copy.photo_id, copy.belongs_at));
      }
      this.phase(peer.libraryId, 'moving', report.moved, copies.length);
    }
  }

  private async scrub(peer: PassivePeer, library: Library, tally: IssueTally): Promise<void> {
    const copies = this.backups.stalest(peer.libraryId, peer.peerId, SCRUB_PER_PASS);
    this.phase(peer.libraryId, 'checking', 0, copies.length);
    let checked = 0;
    for (const copy of copies) {
      try {
        const at = backupPath(peer.root, copy.rel_path);
        const found = isOnDisk(at) ? statSync(at) : null;
        if (found == null) this.backups.mark(peer.libraryId, peer.peerId, copy.photo_id, 'missing');
        else if (found.size !== copy.size) this.backups.mark(peer.libraryId, peer.peerId, copy.photo_id, 'changed');
        else if (copy.health === 'held' || (await contentHash(at)) === copy.content_hash) this.backups.mark(peer.libraryId, peer.peerId, copy.photo_id, 'held');
        else this.backups.mark(peer.libraryId, peer.peerId, copy.photo_id, 'changed');
        if (this.backups.issuesFor(peer.libraryId, peer.peerId, copy.photo_id).some((issue) => issue.code === 'local_changed')) {
          const local = backupPath(library.root_path, this.pathOf(copy.photo_id));
          if (isOnDisk(local) && (await contentHash(local)) === copy.content_hash) this.backups.clearLocalIssues(peer.libraryId, copy.photo_id);
        }
      } catch (error) {
        tally.add(issueOf(error, 'checking', copy.photo_id, copy.rel_path));
      }
      checked += 1;
      this.phase(peer.libraryId, 'checking', checked, copies.length, false);
    }
  }

  private begin(libraryId: string, phase: BackupPhase, kind: ActivityKind | null): void {
    if (this.operations.has(libraryId)) throw new AppError('CONFLICT', 'A backup operation is running. Try again when it finishes.');
    this.operations.set(libraryId, { activity: { phase, done: 0, total: 0, current: null }, transfers: new Set() });
    if (kind != null) this.finishes.set(libraryId, this.activity.begin(libraryId, kind));
    this.changed(libraryId);
  }

  private phase(libraryId: string, phase: BackupPhase, done = 0, total = 0, notify = true): void {
    this.operations.set(libraryId, { activity: { phase, done, total, current: null }, transfers: new Set() });
    if (notify) this.changed(libraryId);
  }

  private track(libraryId: string, ids: readonly string[], phase: BackupPhase): void {
    this.operations.set(libraryId, { activity: { phase, done: 0, total: ids.length, current: null }, transfers: new Set(ids) });
    this.changed(libraryId);
  }

  private end(libraryId: string): void {
    this.operations.delete(libraryId);
    this.finishes.get(libraryId)?.();
    this.finishes.delete(libraryId);
    this.changed(libraryId);
  }

  private report(operation: BackupReport['operation']): { report: BackupReport; tally: IssueTally } {
    const tally = new IssueTally();
    const report: BackupReport = {
      operation, started_at: new Date().toISOString(), finished_at: '', outcome: 'complete',
      copied: 0, moved: 0, offloaded: 0, restored: 0, issues: tally.issues,
    };
    return { report, tally };
  }

  private transferIssue(item: Transfer, phase: BackupPhase): BackupIssue {
    return { code: transferIssueCode(item), phase, photo_id: item.photo_id, path: this.pathOf(item.photo_id) };
  }

  private finish(peer: PassivePeer, report: BackupReport, blocked = false): void {
    report.finished_at = new Date().toISOString();
    report.outcome = blocked ? 'blocked' : report.issues.total > 0 ? 'partial' : 'complete';
    if (report.operation === 'restore') {
      this.db.query('UPDATE replication_peers SET last_restore_report = ? WHERE library_id = ? AND peer_id = ?')
        .run(JSON.stringify(report), peer.libraryId, peer.peerId);
    } else {
      this.db.query('UPDATE replication_peers SET last_backup_report = ?, last_replicated_at = ? WHERE library_id = ? AND peer_id = ?')
        .run(JSON.stringify(report), report.finished_at, peer.libraryId, peer.peerId);
    }
    this.changed(peer.libraryId);
  }

  private originalPhotos(libraryId: string): { id: string; path: string; content_hash: string | null; is_missing: number }[] {
    return this.db.query(
      "SELECT id, json_extract(recipe, '$.path') AS path, content_hash, is_missing FROM photos WHERE library_id = ? AND json_extract(recipe, '$.kind') = 'file' ORDER BY id",
    ).all(libraryId) as { id: string; path: string; content_hash: string | null; is_missing: number }[];
  }

  private assertUsable(library: Library, at: string): void {
    for (const other of this.libraries.listConfigurations()) {
      if (containsPath(other.root_path, at) || containsPath(at, other.root_path)) {
        throw new AppError('VALIDATION_ERROR', 'The backup folder overlaps a library. Choose a separate folder.');
      }
      if (other.id === library.id) continue;
      const theirs = this.targetOf(other.id);
      if (theirs != null && (containsPath(theirs.root, at) || containsPath(at, theirs.root))) {
        throw new AppError('CONFLICT', `This folder overlaps the backup for "${other.name}". Choose another folder.`);
      }
    }
  }

  private library(libraryId: string): Library {
    const library = this.libraries.getConfiguration(libraryId);
    if (library == null) throw new AppError('NOT_FOUND', `Library not found: ${libraryId}`);
    return library;
  }
}
