import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../../logger';
import { deleteBackupFile } from '../../utils/deletions';
import type { BackupJob, BackupOutcome } from './backup_worker';

const WORKER_URL = new URL('./backup_worker.ts', import.meta.url).href;

const log = new Logger('backup');

// Beside the database rather than under `DATA_DIR`, where the rest of what this
// app generates lives: that directory is disposable by design (§6), deleted whole
// when a library goes and safe for a user to clear by hand to reclaim space. A
// backup is the one generated file for which that is false (§4.9).
export function backupsDir(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

// What every snapshot of this database is named after, so two catalogues sharing
// a directory rotate their own files - and offer their own files to a restore -
// and not each other's.
function backupBase(dbPath: string): string {
  return path.basename(dbPath).replace(/\.[^.]*$/, '');
}

// This catalogue's snapshots, oldest first: the stamp in each name is ISO, so
// sorting by name is chronological and needs no `stat`. Both readers of this are
// selective for the same reason - rotation must not delete another database's
// backups, and a restore must not offer one.
export async function listBackups(dbPath: string): Promise<string[]> {
  const dir = backupsDir(dbPath);
  const prefix = `${backupBase(dbPath)}-`;
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
    .sort()
    .map((name) => path.join(dir, name));
}

// Which snapshot a person meant, from `latest` or from a name as `listBackups`
// prints it. A bare name is resolved against the backup directory rather than
// against the shell's working directory, or following the restore tool's own
// output would fail with "no such backup". A path is still taken as one, for
// restoring from somewhere else entirely - but a bare name is only ever matched
// within this catalogue's own snapshots.
export async function findBackup(dbPath: string, requested: string): Promise<string | undefined> {
  const backups = await listBackups(dbPath);
  if (requested === 'latest') return backups.at(-1);
  return backups.find((file) => path.basename(file) === requested) ?? (existsSync(requested) ? requested : undefined);
}

export interface BackupResult {
  path: string;
  bytes: number;
  /** Older snapshots dropped by the retention limit. */
  removed: number;
}

// Rolling snapshots of the catalogue (§4.9). The catalogue is the only copy of
// everything about the photographs that is not in the photographs - ratings,
// notes, verdicts, albums, shoots, and edits, which are stored here with no
// sidecar file to fall back on - so losing it loses work that no rescan brings
// back.
export class BackupService {
  constructor(private readonly dbPath: string) {}

  /** Takes one snapshot, then trims the directory to the newest `keep` of them. */
  async backup(keep: number): Promise<BackupResult> {
    const dir = backupsDir(this.dbPath);
    await mkdir(dir, { recursive: true });

    const base = backupBase(this.dbPath);
    // ISO, so the directory sorts chronologically by name and the rotation below
    // needs no stat of anything.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `${base}-${stamp}.db`);
    // Written under a name of its own and renamed into place once it has been
    // verified. Rename is atomic, so nothing that appears under the real name is
    // ever a partial file - and a partial backup that looks whole is worse than
    // no backup at all. Dot-prefixed, which is also what keeps it out of the
    // rotation's sight while it is being written.
    const temp = path.join(dir, `.${base}-${stamp}.db.part`);

    let bytes: number;
    try {
      bytes = await this.write(temp);
    } catch (err) {
      // However the run ended - a refusal, a crashed thread, a full disk partway
      // through - the part-written file is the size of the catalogue and nothing
      // else will ever come looking for it.
      await deleteBackupFile(dir, temp).catch(() => {});
      throw err;
    }
    await rename(temp, target);

    return { path: target, bytes, removed: await this.rotate(dir, keep) };
  }

  /** How long ago the newest snapshot was taken, or null if there is none. */
  async ageOfNewest(): Promise<number | null> {
    const newest = (await listBackups(this.dbPath)).at(-1);
    if (newest == null) return null;
    // Its mtime rather than the stamp in its name: the two agree, and one of them
    // is a filename being parsed back into a date.
    return Date.now() - (await stat(newest)).mtimeMs;
  }

  private write(outPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL);
      worker.onmessage = (event: MessageEvent<BackupOutcome>) => {
        worker.terminate();
        const outcome = event.data;
        if ('error' in outcome) reject(new Error(outcome.error));
        else resolve(outcome.bytes);
      };
      // Bun kills the thread after this fires, so there is no worker left to
      // report through the message channel.
      worker.onerror = (event: ErrorEvent) => {
        worker.terminate();
        reject(new Error(`backup worker crashed: ${event.message}`));
      };
      worker.postMessage({ dbPath: this.dbPath, outPath } satisfies BackupJob);
    });
  }

  private async rotate(dir: string, keep: number): Promise<number> {
    const existing = await listBackups(this.dbPath);
    const stale = existing.slice(0, Math.max(0, existing.length - keep));
    for (const file of stale) await deleteBackupFile(dir, file);
    return stale.length;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Runs the snapshot on a fixed interval, the same shape as the orphan sweep.
// Disabled when `everyDays` is 0.
export class ScheduledBackup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly backups: BackupService,
    private everyDays = 0,
    private keep = 7,
  ) {}

  start(): void {
    if (!(this.everyDays > 0) || this.timer != null) return;
    this.timer = setInterval(() => void this.fire(), this.everyDays * DAY_MS);
    log.info('catalogue backup scheduled', { everyDays: this.everyDays, keep: this.keep });
    void this.catchUp();
  }

  /** Applies a changed setting (§15) without a restart. */
  configure(everyDays: number, keep: number): void {
    if (everyDays === this.everyDays && keep === this.keep) return;
    this.stop();
    this.everyDays = everyDays;
    this.keep = keep;
    this.start();
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // The orphan sweep can wait for its interval to come round, because a restart
  // is not evidence that anything was orphaned. A backup cannot: a timer alone
  // means a laptop shut each night, or a server restarted more often than the
  // interval, reaches its first backup never. So the age of the newest snapshot
  // decides rather than this process's uptime - which also keeps a development
  // reload from taking one every time.
  private async catchUp(): Promise<void> {
    const age = await this.backups.ageOfNewest();
    if (age == null || age >= this.everyDays * DAY_MS) await this.fire();
  }

  private async fire(): Promise<void> {
    if (this.running) return; // a snapshot of a huge catalogue on a slow disk could outlast the interval
    this.running = true;
    const startedAt = Date.now();
    try {
      const { path: file, bytes, removed } = await this.backups.backup(this.keep);
      log.info('catalogue backed up', {
        file,
        mb: (bytes / 1024 / 1024).toFixed(1),
        removed,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      log.error('catalogue backup failed', { err });
    } finally {
      this.running = false;
    }
  }
}
