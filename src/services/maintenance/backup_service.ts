import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../../logger';
import { deleteBackupFile } from '../../utils/deletions';
import { backupsDir } from '../../utils/paths';
import type { BackupJob, BackupOutcome } from './backup_worker';

const WORKER_URL = new URL('./backup_worker.ts', import.meta.url).href;

const log = new Logger('backup');

// The whole filename, extension included, so `photos.db` and `photos.sqlite` are
// told apart rather than both answering to `photos`.
function backupBase(dbPath: string): string {
  return path.basename(dbPath);
}

// Snapshots of this catalogue and no other. A prefix test is not enough: it would
// make `photos.db` claim `photos-archive.db`'s files, and since `a` sorts after a
// digit those are the newest ones - so rotation would delete every snapshot of the
// catalogue it was protecting and `latest` would restore the wrong database. The
// stamp's shape is what separates them.
function snapshotPattern(base: string): RegExp {
  const literal = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${literal}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.db$`);
}

// Oldest first: the stamp is ISO, so sorting by name is chronological.
export async function listBackups(dbPath: string): Promise<string[]> {
  const dir = backupsDir(dbPath);
  const pattern = snapshotPattern(backupBase(dbPath));
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

// Which snapshot a person meant, from `latest` or from a name as `listBackups`
// prints it. A bare name resolves against the backup directory, not the shell's
// working directory, or typing back what the restore tool just printed would fail
// with "no such backup". An explicit path is taken as one, for a copy kept
// elsewhere.
export async function findBackup(dbPath: string, requested: string): Promise<string | undefined> {
  const backups = await listBackups(dbPath);
  if (requested === 'latest') return backups.at(-1);
  const listed = backups.find((file) => path.basename(file) === requested);
  if (listed != null) return listed;
  return existsSync(requested) ? requested : undefined;
}

export interface BackupResult {
  path: string;
  bytes: number;
  /** Older snapshots dropped by the retention limit. */
  removed: number;
}

// Rolling snapshots of the catalogue (§4.9).
export class BackupService {
  constructor(private readonly dbPath: string) {}

  /** Takes one snapshot, then trims the directory to the newest `keep` of them. */
  async backup(keep: number): Promise<BackupResult> {
    const dir = backupsDir(this.dbPath);
    await mkdir(dir, { recursive: true });

    const base = backupBase(this.dbPath);
    await this.sweepAbandoned(dir, base);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `${base}-${stamp}.db`);
    // Written aside and renamed into place only once it has been verified. Rename
    // is atomic, so nothing appearing under a real name is ever a partial file, and
    // a partial backup that looks whole is worse than no backup at all. Dot-prefixed
    // to stay out of the rotation's sight, and counter-suffixed because two runs
    // starting in the same millisecond would otherwise vacuum into one file.
    const temp = path.join(dir, `.${base}-${stamp}-${nextAttempt()}.part`);

    let bytes: number;
    try {
      bytes = await this.write(temp);
    } catch (err) {
      await deleteBackupFile(dir, temp).catch(() => {});
      throw err;
    }
    await rename(temp, target);

    return { path: target, bytes, removed: await this.rotate(dir, keep) };
  }

  async ageOfNewest(): Promise<number | null> {
    const newest = (await listBackups(this.dbPath)).at(-1);
    if (newest == null) return null;
    // Its mtime rather than the stamp in its name: the two agree, and one of them
    // is a filename being parsed back into a date.
    return Date.now() - (await stat(newest)).mtimeMs;
  }

  // What a killed process leaves behind. The cleanup on the failure path below only
  // runs if this one lived to reach it, and an abandoned file is the size of the
  // catalogue - nothing else names it, and rotation cannot see it.
  private async sweepAbandoned(dir: string, base: string): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.startsWith(`.${base}-`) && n.endsWith('.part'))) {
      await deleteBackupFile(dir, path.join(dir, name)).catch(() => {});
    }
  }

  private write(outPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL);
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        worker.terminate();
        outcome();
      };

      worker.onmessage = (event: MessageEvent<BackupOutcome>) => {
        const outcome = event.data;
        finish(() => ('error' in outcome ? reject(new Error(outcome.error)) : resolve(outcome.bytes)));
      };
      // Bun kills the thread after this fires, so there is no worker left to report
      // through the message channel.
      worker.onerror = (event: ErrorEvent) => {
        finish(() => reject(new Error(`backup worker crashed: ${event.message}`)));
      };
      // A thread that ends without answering either way. Without this the promise
      // never settles, which latches `running` and silently stops every future
      // backup - the failure that looks exactly like a working schedule.
      worker.addEventListener('close', () => {
        finish(() => reject(new Error('the backup worker exited without reporting')));
      });
      worker.postMessage({ dbPath: this.dbPath, outPath } satisfies BackupJob);
    });
  }

  private async rotate(dir: string, keep: number): Promise<number> {
    // A nonsense retention must not be read as "keep none": deleting every snapshot
    // is the one outcome this whole feature exists to prevent.
    if (!(keep >= 1)) return 0;
    const existing = await listBackups(this.dbPath);
    const stale = existing.slice(0, Math.max(0, existing.length - keep));
    for (const file of stale) await deleteBackupFile(dir, file);
    return stale.length;
  }
}

// Distinguishes two runs that start inside one millisecond. A counter rather than
// a random suffix so a leftover is still recognisably this process's.
let attempt = 0;
function nextAttempt(): number {
  return ++attempt;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// How often the schedule asks whether a backup is due, which is not how often one
// is taken. Deliberately short and fixed: `setInterval` truncates its delay to a
// signed 32-bit integer, so an interval of 25 days or more wraps to milliseconds
// and fires continuously - which would quietly rotate a week of history down to a
// few seconds of it, the exact opposite of what the setting asks for.
const DUE_CHECK_MS = 60 * 60 * 1000;

// Takes a snapshot when one is due. Disabled when `everyDays` is 0.
export class ScheduledBackup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly backups: BackupService,
    private everyDays = 0,
    // Not the shipped default repeated: `configure` always supplies one, and
    // rotation refuses to act on a value below 1, so this cannot delete anything.
    private keep = 0,
  ) {}

  start(): void {
    if (!(this.everyDays > 0) || this.timer != null) return;
    this.timer = setInterval(() => void this.takeIfDue(), DUE_CHECK_MS);
    log.info('catalogue backup scheduled', { everyDays: this.everyDays, keep: this.keep });
    void this.takeIfDue();
  }

  /**
   * Applies a changed setting (§15) without a restart.
   *
   * Restarts unconditionally, where the orphan sweep skips an unchanged value: that
   * shortcut leaves a scheduler constructed with its final settings never starting
   * at all, and re-arming an hourly check costs nothing.
   */
  configure(everyDays: number, keep: number): void {
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

  // The age of the newest snapshot decides, not this process's uptime. The orphan
  // sweep can wait for its interval to come round, because a restart is not evidence
  // that anything was orphaned; a backup cannot, or a laptop shut each night and a
  // server restarted more often than the interval reach their first backup never.
  // Age is also what keeps a development reload from taking one every time.
  private async takeIfDue(): Promise<void> {
    if (this.running) return;
    const due = this.everyDays * DAY_MS;
    const age = await this.backups.ageOfNewest().catch(() => null);
    // Re-read after the await: the setting can have been turned off while it ran.
    if (!(this.everyDays > 0)) return;
    if (age != null && age < due) return;
    await this.take();
  }

  private async take(): Promise<void> {
    if (this.running) return; // a snapshot of a huge catalogue on a slow disk could outlast the check
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
