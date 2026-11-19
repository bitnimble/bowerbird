import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import { newId } from '../../schemas/id';
import { captureKey, importJobDone, type ImportJob } from '../../schemas/imports';
import type { Library } from '../../schemas/libraries';
import type { PhotoFormat } from '../../schemas/photos';
import { copyOriginal, moveOriginal } from '../../utils/deletions';
import { numberedName } from '../../utils/files';
import { toLibraryRelative } from '../../utils/paths';
import type { ScanScope } from '../sync/scan/scan_evidence';

const log = new Logger('import');

const JOB_NAMES_KEPT = 20;
const SCAN_LEASE_RETRIES = 60;
const SCAN_LEASE_RETRY_MS = 1000;
const COARSEST_MTIME_MS = 2000;

export interface HeldFile {
  absPath: string;
  relPath: string;
  format: PhotoFormat;
  size: number;
  mtime: Date;
  hash: string;
  deleted: boolean;
}

interface ImportPlan {
  library: Pick<Library, 'id' | 'root_path'>;
  shootId: string | null;
  dir: string;
  /** The whole scan, ticked or not: an unticked file still holds its group's name. */
  scanned: readonly HeldFile[];
  ticked: ReadonlySet<HeldFile>;
  deleteOriginals: boolean;
}

export interface LibraryScanner {
  scanLibrary(libraryId: string, scope: ScanScope): Promise<unknown>;
}

interface Target {
  path: string;
  identical: boolean;
}

function withName(names: string[], name: string): string[] {
  return names.length < JOB_NAMES_KEPT ? [...names, name] : names;
}

/** One press of "Add to library", from its first copy to the scan of what landed. */
export class ImportRun {
  readonly job: ImportJob;
  private stopRequested = false;
  private readonly landed: string[] = [];

  constructor(
    private readonly plan: ImportPlan,
    private readonly scans: LibraryScanner,
    private readonly announce: (job: ImportJob) => void,
  ) {
    this.job = {
      id: newId(),
      library_id: plan.library.id,
      shoot_id: plan.shootId,
      status: 'copying',
      total: plan.ticked.size,
      copied: 0,
      skipped: 0,
      failed: 0,
      failed_names: [],
      deleted: 0,
      kept: 0,
      kept_names: [],
    };
  }

  start(): void {
    void this.run().catch((err: unknown) => {
      log.error('import stopped on an unexpected error', { err: String(err) });
      this.update({ status: 'stopped' });
    });
  }

  stop(): void {
    this.stopRequested = true;
  }

  private async run(): Promise<void> {
    const { scanned, ticked, library } = this.plan;
    for (const group of sameCaptureGroups(scanned)) {
      if (this.stopRequested) break;
      if (group.some((file) => ticked.has(file))) await this.placeGroup(group);
    }
    if (this.landed.length > 0)
      await this.scanLanded(this.landed.map((abs) => toLibraryRelative(library.root_path, abs)));
    this.update({ status: importJobDone(this.job) < this.job.total ? 'stopped' : 'finished' });
  }

  // One suffix for the whole group, unticked files included: the library links a RAW to its camera
  // file by filename stem, and either may be copied on a later run.
  private async placeGroup(group: HeldFile[]): Promise<void> {
    const targets = await freeTargets(group, this.plan.dir);
    for (const [index, file] of group.entries()) {
      if (!this.plan.ticked.has(file)) continue;
      if (this.stopRequested) return;
      await this.place(file, targets[index]!);
    }
  }

  private async place(file: HeldFile, target: Target): Promise<void> {
    const { job } = this;
    try {
      file.deleted = await this.transfer(file, target);
    } catch (err) {
      log.warn('could not copy a file', { file: file.absPath, err: String(err) });
      this.update({
        failed: job.failed + 1,
        failed_names: withName(job.failed_names, file.relPath),
      });
      return;
    }
    this.landed.push(target.path);
    this.update({
      ...(target.identical ? { skipped: job.skipped + 1 } : { copied: job.copied + 1 }),
      ...this.deletionCounts(file),
    });
  }

  /** Whether the source went. Throws when the destination can't be shown to hold it. */
  private async transfer(file: HeldFile, target: Target): Promise<boolean> {
    if (this.plan.deleteOriginals) return await moveOriginal(file.absPath, target.path);
    if (!target.identical) await copyOriginal(file.absPath, target.path);
    return false;
  }

  private deletionCounts(file: HeldFile): Partial<ImportJob> {
    const { job } = this;
    if (!this.plan.deleteOriginals) return {};
    return file.deleted
      ? { deleted: job.deleted + 1 }
      : { kept: job.kept + 1, kept_names: withName(job.kept_names, file.relPath) };
  }

  // Past the retries the watcher or the daily scan finds them: the files are in the library.
  private async scanLanded(paths: string[]): Promise<void> {
    const libraryId = this.plan.library.id;
    for (let attempt = 0; attempt < SCAN_LEASE_RETRIES; attempt++) {
      try {
        await this.scans.scanLibrary(libraryId, { paths });
        return;
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'SYNC_IN_PROGRESS') {
          log.warn('could not scan what was added', { library: libraryId, err: String(err) });
          return;
        }
        if (this.stopRequested) return;
        await Bun.sleep(SCAN_LEASE_RETRY_MS);
      }
    }
    log.warn('gave up waiting for a running scan', { library: libraryId });
  }

  private update(change: Partial<ImportJob>): void {
    Object.assign(this.job, change);
    this.announce(this.job);
  }
}

function sameCaptureGroups(files: readonly HeldFile[]): HeldFile[][] {
  const groups = new Map<string, HeldFile[]>();
  for (const file of files) {
    const key = captureKey(file.relPath);
    const group = groups.get(key);
    if (group == null) groups.set(key, [file]);
    else group.push(file);
  }
  return [...groups.values()];
}

async function freeTargets(group: readonly HeldFile[], dir: string): Promise<Target[]> {
  for (let n = 0; ; n++) {
    const targets = await Promise.all(
      group.map(async (file) => {
        const target = path.join(dir, numberedName(path.basename(file.relPath), n));
        const existing = await stat(target).catch(() => null);
        return {
          path: target,
          identical: existing != null && isSameFile(existing, file),
          taken: existing != null,
        };
      }),
    );
    if (targets.every((target) => !target.taken || target.identical)) return targets;
  }
}

function isSameFile(existing: Stats, file: HeldFile): boolean {
  return (
    existing.size === file.size &&
    // A library on exFAT, HFS+ or FAT rounds the mtime the copy set, as far as FAT's 2 s.
    Math.abs(existing.mtime.getTime() - file.mtime.getTime()) <= COARSEST_MTIME_MS
  );
}
