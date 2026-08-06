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
//
// A directory that is not there yet is empty; anything else - unreadable, a
// permission change, a mount gone - is raised. Swallowing those would have the
// restore tool report "no backups" during the one event this feature exists for,
// which is the most dangerous lie it could tell.
export async function listBackups(dbPath: string): Promise<string[]> {
  const dir = backupsDir(dbPath);
  const pattern = snapshotPattern(backupBase(dbPath));
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  return names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

// Which snapshot a person meant, from `latest` or from a name as `listBackups`
// prints it.
//
// A bare name is ONLY ever matched within this catalogue's own snapshots. It is
// deliberately not passed to the filesystem as well: `photos.db-<stamp>.db` typed
// while standing in the backup directory would otherwise resolve against the cwd
// and restore a *different* catalogue's snapshot over this one, which nothing
// downstream can catch - it is intact, and its `user_version` matches. Restoring a
// copy kept elsewhere still works, by giving a path rather than a name.
export async function findBackup(dbPath: string, requested: string): Promise<string | undefined> {
  const backups = await listBackups(dbPath);
  if (requested === 'latest') return backups.at(-1);
  if (requested.includes(path.sep) || requested.includes('/')) return requested;
  return backups.find((file) => path.basename(file) === requested);
}

export interface BackupResult {
  path: string;
  bytes: number;
  /** Older snapshots dropped by the retention limit. */
  removed: number;
}

// A working file this much older than now was left by a run that died: the process
// that owns one is holding it open and writing to it, and a live `VACUUM INTO` does
// not pause for an hour. Sweeping without this deletes a *concurrent* run's output
// from under it, which two servers on one catalogue (or an overlapping restart) will
// do to each other.
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

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
    // to stay out of the rotation's sight, and counter-suffixed so two runs starting
    // in the same millisecond do not vacuum into one file.
    const temp = path.join(dir, `.${base}-${stamp}-${nextAttempt()}.part`);

    let written: { bytes: number; libraries: number };
    try {
      written = await this.write(temp);
    } catch (err) {
      await deleteBackupFile(dir, temp).catch(() => {});
      throw err;
    }
    const { bytes } = written;
    await rename(temp, target);

    // After the snapshot is safely in place, and never fatal to it: a snapshot that
    // exists must not be reported as a failed backup because an *old* file would not
    // delete. The operator needs to hear about it, which is what the log is for.
    let removed = 0;
    try {
      removed = await this.rotate(dir, keep, target, written);
    } catch (err) {
      log.error('the backup was taken, but rotating older ones failed', { err });
    }
    return { path: target, bytes, removed };
  }

  /**
   * How long ago the newest snapshot was taken. Negative if its timestamp is in the
   * future, which callers must treat as "due" rather than "not yet" (§4.9).
   */
  async ageOfNewest(): Promise<number | null> {
    const newest = (await listBackups(this.dbPath)).at(-1);
    if (newest == null) return null;
    // Its mtime rather than the stamp in its name: the two agree, and one of them
    // is a filename being parsed back into a date.
    return Date.now() - (await stat(newest)).mtimeMs;
  }

  // What a killed process leaves behind. The cleanup on the failure path above only
  // runs if that process lived to reach it, and an abandoned file is the size of the
  // catalogue - nothing else names it, and rotation cannot see it.
  private async sweepAbandoned(dir: string, base: string): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.startsWith(`.${base}-`) && n.endsWith('.part'))) {
      const file = path.join(dir, name);
      const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age < ABANDONED_AFTER_MS) continue;
      await deleteBackupFile(dir, file).catch(() => {});
    }
  }

  private write(outPath: string): Promise<{ bytes: number; libraries: number }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL);
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        worker.terminate();
        outcome();
      };

      // Not a performance bound - a snapshot of a huge catalogue is allowed to take
      // hours. It breaks a deadlock: `close` fires when a thread *exits*, so a thread
      // wedged inside `VACUUM INTO` or `statfs` on a hung mount emits nothing at all,
      // the promise never settles, and the in-flight flag latches for the life of the
      // process - every later backup silently skipped by a schedule that still logs
      // as healthy.
      const deadline = setTimeout(
        () => finish(() => reject(new Error(`the backup worker did not finish within ${WORKER_DEADLINE_MS}ms`))),
        WORKER_DEADLINE_MS,
      );

      worker.onmessage = (event: MessageEvent<BackupOutcome>) => {
        const outcome = event.data;
        finish(() => ('error' in outcome ? reject(new Error(outcome.error)) : resolve(outcome)));
      };
      // Bun kills the thread after this fires, so there is no worker left to report
      // through the message channel.
      worker.onerror = (event: ErrorEvent) => {
        finish(() => reject(new Error(`backup worker crashed: ${event.message}`)));
      };
      // A thread that ends without answering either way.
      worker.addEventListener('close', () => {
        finish(() => reject(new Error('the backup worker exited without reporting')));
      });
      worker.postMessage({ dbPath: this.dbPath, outPath } satisfies BackupJob);
    });
  }

  private async rotate(dir: string, keep: number, taken: string, snapshot: { bytes: number; libraries: number }): Promise<number> {
    // A nonsense retention must not be read as "keep none": deleting every snapshot
    // is the one outcome this whole feature exists to prevent.
    if (!(keep >= 1)) return 0;
    const others = (await listBackups(this.dbPath)).filter((file) => file !== taken);

    // The snapshot just taken is never a rotation candidate, whatever it sorts as.
    // A clock stepped backwards gives it an older name than the history it joins,
    // and deleting the backup this run just made is not a thing to leave to the
    // wall clock.
    const excess = others.length + 1 - keep;
    if (excess <= 0) return 0;

    // A catalogue with no libraries at all, displacing history that is larger, is
    // not a catalogue that shrank - it is a *replacement* for one. `createDatabase`
    // creates on open, so anything leaving DB_PATH absent (a volume that failed to
    // mount, a restore killed mid-rename) gets a fresh empty catalogue on the next
    // start, and rotating on its snapshots destroys the real one's entire history
    // within `keep` runs: at the defaults, a week, every run logging success.
    //
    // Emptiness rather than a size ratio, because size cannot tell them apart: an
    // empty migrated catalogue is already 225KB of schema, and a real but modest one
    // is only a few times that. Both conditions together, so a genuinely new install
    // - empty, and no larger history to lose - still rotates normally.
    const sizes = await Promise.all(others.map((file) => stat(file).then((s) => s.size, () => 0)));
    const largest = Math.max(0, ...sizes);
    if (snapshot.libraries === 0 && snapshot.bytes < largest) {
      log.error('this snapshot has no libraries and is smaller than the history it would replace; keeping all of it', {
        bytes: snapshot.bytes,
        largest,
        db: this.dbPath,
      });
      return 0;
    }

    const stale = others.slice(0, excess);
    for (const file of stale) await deleteBackupFile(dir, file);
    return stale.length;
  }
}

// Distinguishes two runs that start inside one millisecond.
let attempt = 0;
function nextAttempt(): number {
  return ++attempt;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER_DEADLINE_MS = 6 * 60 * 60 * 1000;
// How often the schedule asks whether a backup is due, which is not how often one
// is taken. Deliberately short and fixed: `setInterval` clamps a delay past its
// signed 32-bit range to 1ms, so an interval of 25 days or more fires continuously
// - which would quietly rotate a week of history down to a few seconds of it, the
// exact opposite of what the setting asks for.
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
    const age = await this.backups.ageOfNewest().catch((err: unknown) => {
      log.error('could not tell when the last backup was; taking one', { err });
      return null;
    });
    // Re-read after the await: the setting can have been turned off while it ran.
    if (!(this.everyDays > 0)) return;
    // A negative age is a snapshot stamped in the future - a clock that was ahead
    // and got corrected, or a fileserver whose clock leads this one's. Waiting for
    // the wall clock to catch up would stop backups for as long as the skew, with
    // nothing logged and nothing to see, so it counts as due.
    if (age != null && age >= 0 && age < due) return;
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
