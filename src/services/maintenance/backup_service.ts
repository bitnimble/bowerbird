import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../../logger';
import { deleteBackupFile } from '../../utils/deletions';
import { backupsDir } from '../../utils/paths';
import type { BackupJob, BackupOutcome } from './backup_worker';
import { workerEntry } from '../worker_entry';

// Not a performance bound - a snapshot of a huge catalogue may take as long as it
// takes. It is a ceiling on how long a wedge can pass for work (§4.9).
const WORKER_DEADLINE_MS = 6 * 60 * 60 * 1000;

const TEARDOWN_MS = 5000;

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
  return new RegExp(`^${literal}-${STAMP.source}\\.db$`);
}

// `2026-08-06T15-04-35-704Z`, which is `toISOString()` with its colons and dot
// swapped for dashes so it can be a filename.
const STAMP = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;
const TAIL = new RegExp(`${STAMP.source}\\.db$`);

/**
 * When a snapshot says it was taken, from its name, or null if the name does not
 * carry a readable one.
 *
 * The name rather than the mtime. It is what this app wrote down at the time, and
 * it survives the file being copied, unzipped, downloaded or rsync'd without
 * `-t` - every one of which rewrites mtimes, and every one of which is how a
 * backup reaches the machine that has to restore it. Dating by mtime made
 * `latest` hand back the *oldest* snapshot in a directory that had been copied off
 * a dead machine, which is the disaster-recovery path itself.
 */
function snapshotTime(file: string): number | null {
  // Anchored to the tail, because the stamp is only ever the *last* thing in the
  // name. Matching anywhere takes the leftmost hit, so a catalogue whose own
  // filename carries a stamp-shaped run - `bowerbird.db.pre-restore-<stamp>`, which
  // this very module's restore writes, and a plausible thing to point DB_PATH at -
  // dates every one of its snapshots to that fixed instant instead. Measured: the
  // schedule then finds itself overdue on every hourly check and `backup_keep: 7`
  // collapses to seven consecutive hourly snapshots, all logging success.
  const match = TAIL.exec(path.basename(file));
  if (match == null) return null;
  const [, date, hh, mm, ss, ms] = match;
  const at = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(at) ? null : at;
}

/** Whether a snapshot's own account of when it was taken can be believed. */
function isDatable(file: string, now: number): boolean {
  const at = snapshotTime(file);
  return at != null && at <= now;
}

/** How old a snapshot claims to be, and `Infinity` if it will not say credibly. */
function age(file: string, now: number): number {
  return isDatable(file, now) ? now - snapshotTime(file)! : Number.POSITIVE_INFINITY;
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

// The most recent snapshot whose date can be believed, and null if there is none.
//
// A snapshot dated in the future is a clock that was wrong, not a backup taken
// later, and it cannot be allowed to answer "when was the last backup" or "which is
// the latest". Trusting it stalls the schedule for the length of the skew. Reading
// it as *due* is worse, and was measured: it keeps its future stamp so it stays
// newest for ever, so every hourly check finds itself due again, and a week of
// history rotates away in eight hours with every run logging success. Ignoring it
// does neither - the snapshot this run takes is dated now, and answers next time.
function newestDatable(files: readonly string[]): string | null {
  const now = Date.now();
  const datable = files.filter((file) => isDatable(file, now));
  // Names sort chronologically, being fixed-width ISO, so the last is the newest.
  return datable.at(-1) ?? null;
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
  // Before the listing: a path names a file directly, and a backup directory that
  // cannot be read is no reason to refuse a copy rescued from somewhere else.
  if (requested.includes(path.sep) || requested.includes('/')) return requested;
  const backups = await listBackups(dbPath);
  // Skipping any a skewed clock stamped years ahead, which would otherwise be
  // "latest" for ever and hand back the oldest catalogue there is.
  if (requested === 'latest') return newestDatable(backups) ?? backups.at(-1);
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

/**
 * Where the snapshot work happens and how long it may take. Both are here so the
 * two ways a worker can fail to answer - exiting mute, and wedging - can be tested
 * against a stub, which is otherwise a code path nothing can reach and which is
 * precisely the "backups have silently stopped" class.
 */
export interface BackupWorkerOptions {
  workerUrl?: string | URL;
  deadlineMs?: number;
}

// Rolling snapshots of the catalogue (§4.9).
export class BackupService {
  /** Absent means the one this build ships with; the tests point it elsewhere. */
  private readonly workerUrl: string | URL | undefined;
  private readonly deadlineMs: number;

  constructor(
    private readonly dbPath: string,
    options: BackupWorkerOptions = {},
  ) {
    this.workerUrl = options.workerUrl;
    this.deadlineMs = options.deadlineMs ?? WORKER_DEADLINE_MS;
  }

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

    let bytes: number;
    try {
      bytes = await this.write(temp);
    } catch (err) {
      await deleteBackupFile(dir, temp).catch(() => {});
      throw err;
    }
    await rename(temp, target);

    // After the snapshot is safely in place, and never fatal to it: a snapshot that
    // exists must not be reported as a failed backup because an *old* file would not
    // delete. The operator needs to hear about it, which is what the log is for.
    let removed = 0;
    try {
      removed = await this.rotate(dir, keep, target);
    } catch (err) {
      log.error('the backup was taken, but rotating older ones failed', { err });
    }
    return { path: target, bytes, removed };
  }

  /**
   * How long ago the last datable snapshot was taken, or null if there is none -
   * which includes a directory holding nothing but future-stamped ones (§4.9).
   */
  async ageOfNewest(): Promise<number | null> {
    const newest = newestDatable(await listBackups(this.dbPath));
    const at = newest == null ? null : snapshotTime(newest);
    return at == null ? null : Date.now() - at;
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

  private write(outPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        this.workerUrl ?? workerEntry('backup_worker', new URL('./backup_worker.ts', import.meta.url)),
      );
      let settled = false;
      // `close` fires when the thread has actually gone, which is what this waits for: a libSQL
      // connection is released as its thread unwinds rather than when `terminate()` resolves, and
      // until it has, the catalogue is still open from in here - so the owner's `close()` cannot
      // leave WAL mode, and the next restore is refused (`driver.ts`).
      //
      // Bounded, because waiting forever on a thread that will not die is the latch this method is
      // shaped to avoid: a teardown that never reports leaves the backup no worse off, where a hung
      // promise stops every later one.
      const gone = new Promise<void>((done) => {
        worker.addEventListener('close', () => done());
        setTimeout(done, TEARDOWN_MS).unref?.();
      });
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        void Promise.resolve(worker.terminate())
          .then(() => gone)
          .then(outcome, outcome);
      };

      // Not a performance bound - a snapshot of a huge catalogue is allowed to take
      // hours. It breaks a deadlock: `close` fires when a thread *exits*, so a thread
      // wedged inside `VACUUM INTO` or `statfs` on a hung mount emits nothing at all,
      // the promise never settles, and the in-flight flag latches for the life of the
      // process - every later backup silently skipped by a schedule that still logs
      // as healthy.
      const deadline = setTimeout(
        () => finish(() => reject(new Error(`the backup worker did not finish within ${this.deadlineMs}ms`))),
        this.deadlineMs,
      );

      worker.onmessage = (event: MessageEvent<BackupOutcome>) => {
        const outcome = event.data;
        finish(() => ('error' in outcome ? reject(new Error(outcome.error)) : resolve(outcome.bytes)));
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

  private async rotate(dir: string, keep: number, taken: string): Promise<number> {
    // A nonsense retention must not be read as "keep none": deleting every snapshot
    // is the one outcome this whole feature exists to prevent.
    if (!(keep >= 1)) return 0;
    // The snapshot just taken is never a rotation candidate, whatever it sorts as.
    // A clock stepped backwards gives it an older name than the history it joins,
    // and deleting the backup this run just made is not a thing to leave to the
    // wall clock.
    const others = (await listBackups(this.dbPath)).filter((file) => file !== taken);
    const excess = others.length + 1 - keep;
    if (excess <= 0) return 0;

    // Oldest first, by the date each snapshot claims, with a date that cannot be
    // read or is in the future counting as oldest. Ordering by name instead leaves
    // a future-stamped snapshot at the end of the list for ever, so rotation never
    // reaches it while it still counts against `keep`: measured, seven of those
    // collapse `backup_keep: 7` to one snapshot at most one interval old, every run
    // reporting a successful backup and a rotation. A bogus date is what should go
    // first. Keyed rather than compared, so two undatable snapshots do not hand the
    // sort a NaN.
    const now = Date.now();
    const oldestFirst = others
      .map((file) => ({ file, age: age(file, now) }))
      .sort((a, b) => (a.age === b.age ? 0 : b.age - a.age));
    const stale = oldestFirst.slice(0, Math.min(excess, oldestFirst.length)).map((entry) => entry.file);

    const undatable = oldestFirst.slice(0, stale.length).filter((entry) => entry.age === Number.POSITIVE_INFINITY);
    if (undatable.length > 0) {
      // Otherwise the one case where rotation drops the *newest* work - a clock that
      // ran forward and was corrected - is completely invisible.
      log.warn('dropping snapshots whose own date cannot be believed', { files: undatable.map((e) => path.basename(e.file)) });
    }

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

  /** Applies a changed setting (§15) without a restart. */
  configure(everyDays: number, keep: number): void {
    // Also on `timer`, not the values alone: a scheduler constructed with its final
    // settings has never started, and a value-only guard leaves it never starting.
    if (everyDays === this.everyDays && keep === this.keep && this.timer != null) return;
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
