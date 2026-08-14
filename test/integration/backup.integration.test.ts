// A backup nobody has restored is not a backup, so both halves are pinned here
// against a real database on a real filesystem (§4.9).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { LATEST_USER_VERSION } from '../../src/db/migrations';
import { BackupService, ScheduledBackup, findBackup, listBackups } from '../../src/services/maintenance/backup_service';
import { spaceNeededFor } from '../../src/services/maintenance/backup_worker';
import { holdAgainstUse, restoreBackup } from '../../src/services/maintenance/restore';
import { deleteBackupFile } from '../../src/utils/deletions';
import { backupsDir } from '../../src/utils/paths';

const LIB = 'lib0ab01';
const LATER = 'lib0ab02';

let dir: string;
let dbPath: string;
let db: Database;
let backups: BackupService;

function addLibrary(id: string, name: string): void {
  db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(id, path.join(dir, name), name);
}

function libraryNames(file: string): string[] {
  const copy = new Database(file, { readonly: true });
  try {
    return (copy.query('SELECT name FROM libraries ORDER BY name').all() as { name: string }[]).map((r) => r.name);
  } finally {
    copy.close();
  }
}

/** Everything in the backup directory, including sidecars and working files. */
function everything(): string[] {
  const backupDir = backupsDir(dbPath);
  return existsSync(backupDir) ? readdirSync(backupDir).sort() : [];
}

/**
 * A killed server: a library committed into the WAL with nothing left running to
 * checkpoint it out.
 *
 * It has to be a process that dies, not a connection left open. Closing the last
 * connection checkpoints and removes the WAL, so there would be nothing to test;
 * and holding one open instead is now refused outright, which is the other half of
 * what makes this the honest simulation.
 */
async function killedWriterLeavingWal(id: string, name: string): Promise<void> {
  const script = path.join(dir, 'writer.ts');
  const done = path.join(dir, 'writer.ready');
  writeFileSync(
    script,
    `import { Database } from 'bun:sqlite';
     import { writeFileSync } from 'node:fs';
     const db = new Database(${JSON.stringify(dbPath)});
     db.exec('PRAGMA journal_mode = WAL;');
     db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)')
       .run(${JSON.stringify(id)}, ${JSON.stringify(path.join(dir, name))}, ${JSON.stringify(name)});
     writeFileSync(${JSON.stringify(done)}, 'ready');
     setInterval(() => {}, 1000);`,
  );
  const writer = Bun.spawn(['bun', script], { stdout: 'ignore', stderr: 'ignore' });
  for (let attempt = 0; attempt < 200 && !existsSync(done); attempt++) await Bun.sleep(25);
  writer.kill(9);
  await writer.exited;
  if (!existsSync(done)) throw new Error('the writer never committed');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bb-backup-'));
  dbPath = path.join(dir, 'bowerbird.db');
  db = createDatabase(dbPath);
  backups = new BackupService(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a backup is a self-contained catalogue, holding writes still sitting in the WAL', async () => {
  addLibrary(LIB, 'holiday');

  const { path: file, bytes, removed } = await backups.backup(7);

  expect(existsSync(file)).toBe(true);
  expect(bytes).toBe(statSync(file).size);
  expect(removed).toBe(0);
  // Spelled out rather than compared against the helper that produced it, which
  // would only prove the code agrees with itself: §4.9 says beside the database.
  expect(path.dirname(file)).toBe(path.join(dir, 'backups'));
  // Nothing was checkpointed between the insert and the snapshot, so a plain file
  // copy of the .db would have missed this row entirely.
  expect(libraryNames(file)).toEqual(['holiday']);
  // Self-contained: `VACUUM INTO` writes one file, with no sidecars to restore alongside it.
  expect(everything()).toEqual([path.basename(file)]);
});

test('a backup that fails leaves nothing behind, and says so', async () => {
  // The whole failure path in one go: the worker refuses, `backup()` rejects rather
  // than reporting a success, and the part-written file does not survive. Every one
  // of those was previously unexercised, because every other test takes a backup
  // that works.
  db.close();
  writeFileSync(dbPath, 'not a database');

  await expect(backups.backup(7)).rejects.toThrow();
  // No promoted snapshot, and no abandoned working file either.
  expect(everything()).toEqual([]);

  rmSync(dbPath);
  db = createDatabase(dbPath);
});

test('a working file abandoned by a killed run is swept by the next one', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);
  // What SIGKILL during `VACUUM INTO` leaves: dot-prefixed, so rotation cannot see
  // it, and the size of the catalogue. Nothing else would ever come looking.
  const abandoned = path.join(backupsDir(dbPath), `.${path.basename(dbPath)}-2020-01-01T00-00-00-000Z-1.part`);
  writeFileSync(abandoned, 'half a catalogue');
  // Old enough that no live run could still be writing it. A fresh one belongs to
  // something that is still going, which the test below covers.
  const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(abandoned, longAgo, longAgo);

  await backups.backup(7);

  expect(existsSync(abandoned)).toBe(false);
});

test('rotation keeps the newest N and drops the rest', async () => {
  addLibrary(LIB, 'holiday');

  const made: string[] = [];
  for (let i = 0; i < 4; i++) made.push((await backups.backup(2)).path);

  expect(everything()).toEqual(made.slice(-2).map((file) => path.basename(file)).sort());
  // The count goes into the operator's log line, so it has to be the real one.
  expect((await backups.backup(2)).removed).toBe(1);
});

test('rotation refuses a retention below one rather than deleting everything', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);

  // Deleting every snapshot is the one outcome this feature exists to prevent, so a
  // nonsense retention must not be read as "keep none".
  const { removed } = await backups.backup(0);

  expect(removed).toBe(0);
  expect(everything().length).toBe(2);
});

test('a catalogue whose name is a prefix of another does not rotate the other away', async () => {
  // `photos.db` and `photos-archive.db` in one directory. A prefix test would make
  // the first claim the second's snapshots - and since `a` sorts after a digit,
  // those are the *newest*, so rotation would delete every snapshot of `photos.db`
  // and keep only the neighbour's.
  const photos = path.join(dir, 'photos.db');
  const archive = path.join(dir, 'photos-archive.db');
  for (const file of [photos, archive]) createDatabase(file).close();

  const archived = await new BackupService(archive).backup(7);
  const mine = new BackupService(photos);
  const own = [];
  for (let i = 0; i < 3; i++) own.push((await mine.backup(2)).path);

  expect(await listBackups(photos)).toEqual(own.slice(-2));
  expect(await listBackups(archive)).toEqual([archived.path]);
  expect(existsSync(archived.path)).toBe(true);
});

test('two catalogues differing only by extension do not share snapshots', async () => {
  // Both would reduce to `photos` if the extension were stripped, and their
  // snapshots would then collide on one filename.
  const a = path.join(dir, 'photos.db');
  const b = path.join(dir, 'photos.sqlite');
  for (const file of [a, b]) createDatabase(file).close();

  const first = await new BackupService(a).backup(7);
  const second = await new BackupService(b).backup(7);

  expect(first.path).not.toBe(second.path);
  expect(await listBackups(a)).toEqual([first.path]);
  expect(await listBackups(b)).toEqual([second.path]);
});

// start() kicks the due check off without waiting for it, so the assertion is on
// what the directory settles to.
async function settled(): Promise<string[]> {
  let taken = await listBackups(dbPath);
  for (let attempt = 0; attempt < 100 && taken.length === 0; attempt++) {
    await Bun.sleep(20);
    taken = await listBackups(dbPath);
  }
  return taken;
}

test('starting with no backup at all takes one rather than waiting out the interval', async () => {
  addLibrary(LIB, 'holiday');
  const scheduled = new ScheduledBackup(backups, 1, 7);

  scheduled.start();
  const taken = await settled();
  scheduled.stop();

  // Otherwise a machine restarted more often than the interval never reaches its
  // first backup at all.
  expect(taken.length).toBe(1);
});

test('starting again does not take a second backup within the interval', async () => {
  addLibrary(LIB, 'holiday');
  const { path: first } = await backups.backup(7);
  const scheduled = new ScheduledBackup(backups, 1, 7);

  scheduled.start();
  await Bun.sleep(200);
  scheduled.stop();

  // Asserting the snapshot is the same file rather than counting: a count can pass
  // on a slow machine simply because the extra one has not landed yet.
  expect(await listBackups(dbPath)).toEqual([first]);
});

test('a disabled schedule takes nothing', async () => {
  addLibrary(LIB, 'holiday');
  const scheduled = new ScheduledBackup(backups, 0, 7);

  scheduled.start();
  await Bun.sleep(200);
  scheduled.stop();

  expect(await listBackups(dbPath)).toEqual([]);
});

// A settings write of any kind re-configures every scheduler, and `start` takes a
// backup when there is none - so an unchanged value restarting the schedule turns
// each one into a snapshot.
test('re-applying the settings a schedule is already running does nothing', async () => {
  addLibrary(LIB, 'holiday');
  const scheduled = new ScheduledBackup(backups, 1, 7);
  scheduled.start();
  await settled();
  rmSync(backupsDir(dbPath), { recursive: true, force: true });

  scheduled.configure(1, 7);
  await Bun.sleep(200);
  scheduled.stop();

  expect(await listBackups(dbPath)).toEqual([]);
});

test('configure starts a schedule that was built with the settings it is given', async () => {
  addLibrary(LIB, 'holiday');
  // Skipping the restart when nothing changed leaves this one never started at all,
  // which is a scheduler that silently backs up nothing for the life of the process.
  const scheduled = new ScheduledBackup(backups, 1, 7);

  scheduled.configure(1, 7);
  const taken = await settled();
  scheduled.stop();

  expect(taken.length).toBe(1);
});

test('turning backups off stops the schedule', async () => {
  addLibrary(LIB, 'holiday');
  const scheduled = new ScheduledBackup(backups, 0, 7);
  scheduled.start();

  scheduled.configure(1, 7);
  expect((await settled()).length).toBe(1);
  scheduled.configure(0, 7);
  rmSync(backupsDir(dbPath), { recursive: true, force: true });
  await Bun.sleep(200);
  scheduled.stop();

  expect(await listBackups(dbPath)).toEqual([]);
});

test('a backup is found by the name it is listed under, not by the shell’s working directory', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  // Exactly what `bun run restore` prints, and so exactly what gets typed back at
  // it. Resolved against cwd it would be nothing at all.
  const asListed = path.basename(file);

  expect(await findBackup(dbPath, asListed)).toBe(file);
  expect(await findBackup(dbPath, 'latest')).toBe(file);
  expect(await findBackup(dbPath, file)).toBe(file);
  expect(await findBackup(dbPath, 'bowerbird.db-2020-01-01T00-00-00-000Z.db')).toBeUndefined();
});

test('another catalogue’s snapshot is neither listed nor restorable by name', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);
  const other = path.join(backupsDir(dbPath), 'elsewhere.db-2099-01-01T00-00-00-000Z.db');
  writeFileSync(other, 'not ours');

  // Newest by name, so `latest` would reach for it if the filter were only `.db`.
  expect(await listBackups(dbPath)).not.toContain(other);
  expect(await findBackup(dbPath, path.basename(other))).toBeUndefined();
  expect(await findBackup(dbPath, 'latest')).not.toBe(other);
});

test('restoring puts the catalogue back and keeps the one it displaced', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);

  // Work done after the snapshot, with a WAL still holding it and nothing left
  // running to check it out - which is exactly when somebody reaches for a backup.
  db.close();
  await killedWriterLeavingWal(LATER, 'later');
  expect(existsSync(`${dbPath}-wal`)).toBe(true);

  const { movedAside, version } = await restoreBackup(dbPath, file);

  expect(version).toBe(LATEST_USER_VERSION);
  // Nothing of the old catalogue is left at any of the paths SQLite would derive a
  // sidecar name from. Left behind, a `-wal` is replayed over the restored file.
  for (const suffix of ['-wal', '-shm', '-journal']) expect(existsSync(`${dbPath}${suffix}`)).toBe(false);
  // The work that was in that WAL went with the catalogue it belongs to, so the
  // displaced copy is complete and the restore stays undoable. Reading it back
  // proves the sidecar travelled: the row lives in the parked `-wal`, not in the
  // parked main file.
  expect(existsSync(`${movedAside}-wal`)).toBe(true);
  expect(libraryNames(movedAside!).sort()).toEqual(['holiday', 'later']);

  // Reopened the way the server opens it, so the assertion covers what a restart
  // would actually find rather than what the file says on its own.
  db = createDatabase(dbPath);
  expect(libraryNames(dbPath)).toEqual(['holiday']);
});

test('restoring over a deleted catalogue still takes its WAL out of the way', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  db.close();
  await killedWriterLeavingWal(LATER, 'later');

  // The likeliest way anyone reaches a restore at all: the catalogue looks broken,
  // so they delete it and put a backup back. The WAL is left behind by the killed
  // server, and SQLite names it from the database's path - so left in place it
  // replays the old catalogue straight over the restored one, and nothing about the
  // result looks wrong.
  rmSync(dbPath);
  expect(existsSync(`${dbPath}-wal`)).toBe(true);

  const { movedAside } = await restoreBackup(dbPath, file);

  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  // Nothing to point anyone at: a lone WAL parked out of the way is not a catalogue
  // they could go back to, and naming it as one sends them to a path with no file.
  expect(movedAside).toBeNull();

  db = createDatabase(dbPath);
  expect(libraryNames(dbPath)).toEqual(['holiday']);
});

test('restoring a catalogue whose work is all in its WAL keeps that work', async () => {
  // The undo path the restore tool advertises, and the "a copy kept elsewhere" one:
  // both hand it a catalogue that normally arrives with a -wal beside it. A file
  // copy takes the main file alone, and a catalogue's committed work can be
  // entirely in the WAL - restoring one of those yields an empty database that
  // passes every check there is.
  db.close();
  await killedWriterLeavingWal(LATER, 'later');
  const parked = path.join(dir, 'rescued.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${parked}${suffix}`);
  }
  expect(existsSync(`${parked}-wal`)).toBe(true);

  await restoreBackup(dbPath, parked);

  db = createDatabase(dbPath);
  expect(libraryNames(dbPath)).toEqual(['later']);
});

test('a restore is refused while the server still has the catalogue open', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);

  // `db` is open, standing in for a running server. Left to proceed, the server
  // keeps writing through its handle to the inode this moves aside: its reads stay
  // right, its shutdown is clean, and every write since the restore is discarded at
  // the next start with nothing reported anywhere.
  await expect(restoreBackup(dbPath, file)).rejects.toThrow(/open in another process/);
  expect(existsSync(dbPath)).toBe(true);
  expect(libraryNames(file)).toEqual(['holiday']);
});

test('restoring an older backup is allowed, because the migrations bring it forward', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  const older = new Database(file);
  older.exec(`PRAGMA user_version = ${LATEST_USER_VERSION - 1}`);
  older.close();
  db.close();

  const { version } = await restoreBackup(dbPath, file);

  expect(version).toBe(LATEST_USER_VERSION - 1);
  db = createDatabase(dbPath);
  expect(libraryNames(dbPath)).toEqual(['holiday']);
});

test('a backup from a newer Bowerbird is refused rather than restored', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  const ahead = new Database(file);
  ahead.exec(`PRAGMA user_version = ${LATEST_USER_VERSION + 1}`);
  ahead.close();
  db.close();

  await expect(restoreBackup(dbPath, file)).rejects.toThrow(/newer Bowerbird/);
  // Refused before anything moved: the catalogue is still where the server left it,
  // and no staging copy was left beside it. The staged name carries a stamp, so
  // this has to match on the prefix rather than on a fixed name.
  expect(existsSync(dbPath)).toBe(true);
  expect(readdirSync(dir).filter((name) => name.includes('.restoring'))).toEqual([]);
  expect(readdirSync(dir).filter((name) => name.includes('.pre-restore'))).toEqual([]);

  db = createDatabase(dbPath);
});

test('a corrupt backup is refused, by the message it was given rather than a crash', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  writeFileSync(file, 'not a database');
  db.close();

  // A file that is not a database throws out of the open rather than failing
  // quick_check, and that has to arrive as the same refusal.
  await expect(restoreBackup(dbPath, file)).rejects.toThrow(/is not intact/);
  expect(existsSync(dbPath)).toBe(true);

  db = createDatabase(dbPath);
});

test('restoring a catalogue over itself is refused', async () => {
  addLibrary(LIB, 'holiday');

  // Without the guard the catalogue is renamed aside and the copy then fails,
  // leaving nothing at the path the server opens.
  await expect(restoreBackup(dbPath, dbPath)).rejects.toThrow(/same file/);
  expect(existsSync(dbPath)).toBe(true);
});

test('a symlinked catalogue stays on the volume it was put on', async () => {
  // A symlinked DB_PATH is a deliberate placement - the catalogue lives on the big
  // volume, the link sits on the small one. Restoring through the link would write
  // a regular file at the link's own path, silently relocating the catalogue and
  // orphaning the real one where nothing will look again.
  const real = path.join(dir, 'volume', 'bowerbird.db');
  mkdirSync(path.dirname(real), { recursive: true });
  db.close();
  renameSync(dbPath, real);
  symlinkSync(real, dbPath);
  db = createDatabase(dbPath);
  addLibrary(LIB, 'holiday');
  const { path: file } = await new BackupService(dbPath).backup(7);
  db.close();

  await restoreBackup(dbPath, file);

  // `lstat`, not `stat`: the question is whether DB_PATH is still the link the user
  // made it, and `stat` follows the link and answers about the target either way.
  expect(lstatSync(dbPath).isSymbolicLink()).toBe(true);
  expect(libraryNames(real)).toEqual(['holiday']);
  db = createDatabase(dbPath);
});

test('a chain of symlinks resolves to the catalogue at the end of it', async () => {
  // A link into a link is what a re-pointed volume leaves. Unwrapping only the
  // first writes the restored catalogue into the middle of the chain, leaving the
  // real one live, orphaned, and named as the thing to delete once happy.
  const real = path.join(dir, 'volume', 'bowerbird.db');
  const middle = path.join(dir, 'mid.db');
  mkdirSync(path.dirname(real), { recursive: true });
  db.close();
  renameSync(dbPath, real);
  symlinkSync(real, middle);
  symlinkSync(middle, dbPath);
  db = createDatabase(dbPath);
  addLibrary(LIB, 'holiday');
  const { path: file } = await new BackupService(dbPath).backup(7);
  db.close();

  await restoreBackup(dbPath, file);

  expect(lstatSync(dbPath).isSymbolicLink()).toBe(true);
  expect(lstatSync(middle).isSymbolicLink()).toBe(true);
  expect(libraryNames(real)).toEqual(['holiday']);
  db = createDatabase(dbPath);
});

test('a symlinked catalogue whose volume is missing is not replaced by a plain file', async () => {
  // The two ways people arrive at a restore both produce this: the volume failed to
  // mount, or they deleted the catalogue they thought was broken. Read as "no
  // catalogue here", the restored file lands on top of the link - so the catalogue
  // silently moves onto the container's writable layer, is deleted at the next
  // rebuild, and the real one is orphaned when the volume comes back.
  const real = path.join(dir, 'volume', 'bowerbird.db');
  mkdirSync(path.dirname(real), { recursive: true });
  db.close();
  const { path: file } = await backups.backup(7);
  rmSync(dbPath);
  symlinkSync(real, dbPath);
  expect(existsSync(dbPath)).toBe(false); // dangling: existsSync follows the link

  await restoreBackup(dbPath, file);

  expect(lstatSync(dbPath).isSymbolicLink()).toBe(true);
  expect(existsSync(real)).toBe(true);

  // Opened through the link, which now resolves, so the catalogue is on its volume.
  db = createDatabase(dbPath);
  expect(libraryNames(real)).toEqual([]);
});

test('a catalogue too corrupt to open can still be restored over', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  db.close();
  // The reason anyone runs this tool. Refusing here - on the grounds that the probe
  // for a running server failed - tells them to stop a server that is not running
  // and leaves deleting their only catalogue by hand as the sole way through.
  writeFileSync(dbPath, 'the header is gone');

  const { version } = await restoreBackup(dbPath, file);

  expect(version).toBe(LATEST_USER_VERSION);
  db = createDatabase(dbPath);
  expect(libraryNames(dbPath)).toEqual(['holiday']);
});

test('an unreadable backup directory is raised, not reported as having no backups', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);
  const backupDir = backupsDir(dbPath);
  chmodSync(backupDir, 0o000);

  // Reporting "no backups" here would be the most dangerous lie this can tell: it
  // is exactly the moment somebody is looking for one.
  try {
    await expect(listBackups(dbPath)).rejects.toThrow();
    // ...but it must not take a rescued copy down with it. That path names its file
    // directly and has no business being refused because a directory it never reads
    // cannot be listed.
    expect(await findBackup(dbPath, path.join(dir, 'rescued.db'))).toBe(path.join(dir, 'rescued.db'));
  } finally {
    chmodSync(backupDir, 0o755);
  }
});

test('a bare name is never resolved against the working directory', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);
  // A neighbouring catalogue's snapshot, sitting in the directory somebody is
  // standing in when they read the listing. Resolved against the cwd it would be
  // found, restored over this catalogue, and pass every check downstream - it is
  // intact and its user_version matches.
  const neighbour = 'elsewhere.db-2099-01-01T00-00-00-000Z.db';
  writeFileSync(path.join(backupsDir(dbPath), neighbour), 'not ours');
  const previous = process.cwd();

  try {
    process.chdir(backupsDir(dbPath));
    expect(await findBackup(dbPath, neighbour)).toBeUndefined();
  } finally {
    process.chdir(previous);
  }
});

// A snapshot a skewed clock stamped in the future, in the name as well as the
// mtime - which is what actually happens, since both come from the same clock.
// Named that way it sorts last for ever, so anything that reads "the newest
// snapshot" off the end of the list keeps finding it.
async function futureStampedSnapshot(): Promise<string> {
  const ahead = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const file = path.join(
    backupsDir(dbPath),
    `${path.basename(dbPath)}-${ahead.toISOString().replace(/[:.]/g, '-')}.db`,
  );
  mkdirSync(backupsDir(dbPath), { recursive: true });
  const seeded = createDatabase(file);
  seeded.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run('from-the-future', '/f', 'from-the-future');
  seeded.close();
  utimesSync(file, ahead, ahead);
  return file;
}

test('a snapshot stamped in the future neither stalls the schedule nor makes it spin', async () => {
  addLibrary(LIB, 'holiday');
  const stuck = await futureStampedSnapshot();
  // Trusting it stalls backups for the length of the skew. Treating it as due is
  // worse: it stays newest by name for ever, so every hourly check finds itself due
  // again and rotation grinds a week of history away in hours, logging success each
  // time. Neither - it is ignored, and the snapshot taken now answers next time.
  expect(await backups.ageOfNewest()).toBeNull();

  const scheduled = new ScheduledBackup(backups, 1, 7);
  scheduled.start();
  const taken = await settled();
  await Bun.sleep(200);
  scheduled.stop();

  expect(taken.length).toBeGreaterThan(0);
  // One catch-up snapshot beside the stuck one, and no further spinning.
  expect((await listBackups(dbPath)).length).toBe(2);
  expect(await backups.ageOfNewest()).toBeGreaterThanOrEqual(0);
  expect(existsSync(stuck)).toBe(true);
});

test('“latest” is the most recent backup, not one a skewed clock stamped years ahead', async () => {
  addLibrary(LIB, 'holiday');
  const stuck = await futureStampedSnapshot();
  const { path: real } = await backups.backup(7);

  // By name the future one wins for ever, so `bun run restore latest` would hand
  // back the oldest catalogue in the directory and report success.
  expect(await findBackup(dbPath, 'latest')).toBe(real);
  expect(await findBackup(dbPath, 'latest')).not.toBe(stuck);
});

test('“latest” survives a backup directory whose timestamps were not preserved', async () => {
  addLibrary(LIB, 'holiday');
  const oldest = await backups.backup(7);
  addLibrary(LATER, 'later');
  const newest = await backups.backup(7);

  // What `cp -r`, an unzip, a download or an rsync without `-t` leaves - and those
  // are exactly how backups reach the machine that has to restore them. Dating by
  // mtime here handed back the *oldest* snapshot and reported success.
  const now = new Date();
  const earlier = new Date(Date.now() - 60_000);
  utimesSync(newest.path, earlier, earlier);
  utimesSync(oldest.path, now, now);

  expect(await findBackup(dbPath, 'latest')).toBe(newest.path);
  expect(libraryNames(newest.path).sort()).toEqual(['holiday', 'later']);
});

test('a snapshot with a bogus date is rotated out rather than made immortal', async () => {
  addLibrary(LIB, 'holiday');
  const stuck = await futureStampedSnapshot();

  // It sorts last by name for ever, so deleting from the front of the name order
  // never reaches it - while it still counts against `keep`. Measured before the
  // fix: seven of these collapse `backup_keep: 7` to "one snapshot, at most one
  // interval old", every run reporting a successful backup and a rotation.
  const first = await backups.backup(2);
  const second = await backups.backup(2);

  const kept = await listBackups(dbPath);
  expect(kept).toContain(second.path);
  expect(kept).toContain(first.path);
  expect(kept).not.toContain(stuck);
});

test('a catalogue whose own filename carries a date does not date every snapshot to it', async () => {
  // `<db>.pre-restore-<stamp>` is a name this module's own restore writes, and a
  // plausible thing to point DB_PATH at to inspect a parked catalogue. Matching the
  // stamp anywhere in the name takes the leftmost hit, so every snapshot dates to
  // that fixed instant - the schedule then finds itself overdue on every check and
  // the retention window collapses to consecutive minutes.
  const awkward = path.join(dir, 'bowerbird.db.pre-restore-2026-01-02T03-04-05-678Z');
  db.close();
  renameSync(dbPath, awkward);
  dbPath = awkward;
  db = createDatabase(dbPath);
  addLibrary(LIB, 'holiday');
  backups = new BackupService(dbPath);

  await backups.backup(7);

  // Dated now, not in January.
  const age = await backups.ageOfNewest();
  expect(age).not.toBeNull();
  expect(age!).toBeLessThan(60_000);
});

test('rotation never deletes the snapshot it just took', async () => {
  addLibrary(LIB, 'holiday');
  // Two hours of history, then a clock that steps backwards - which is the only
  // thing that makes the snapshot taken *now* look older than the history it joins,
  // and so the only arrangement where rotation could reach it.
  for (const hoursAgo of [3, 2]) {
    const when = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    const file = path.join(backupsDir(dbPath), `${path.basename(dbPath)}-${when.toISOString().replace(/[:.]/g, '-')}.db`);
    mkdirSync(backupsDir(dbPath), { recursive: true });
    createDatabase(file).close();
  }

  const realNow = Date.now;
  Date.now = () => realNow() - 60 * 60 * 1000;
  let taken: string;
  try {
    taken = (await backups.backup(2)).path;
  } finally {
    Date.now = realNow;
  }

  expect(existsSync(taken)).toBe(true);
});

test('a staging file left by a killed restore is swept by the next one', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  db.close();
  // Killed between the vacuum and the rename, this is catalogue-sized and nothing
  // else names it - the same litter the backup side sweeps for itself.
  const abandoned = `${dbPath}.restoring-2020-01-01T00-00-00-000Z`;
  writeFileSync(abandoned, 'half a catalogue');
  // Old enough that no live run could still be writing it. A second restore started
  // by an impatient user is still going, and deleting its staging file mid-vacuum
  // fails that run for no reason.
  const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(abandoned, longAgo, longAgo);

  await restoreBackup(dbPath, file);

  expect(existsSync(abandoned)).toBe(false);
  db = createDatabase(dbPath);
});

test('a staging file a running restore is still writing is left alone', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  db.close();
  const inFlight = `${dbPath}.restoring-2026-01-01T00-00-00-000Z`;
  writeFileSync(inFlight, 'someone else is vacuuming into this');

  await restoreBackup(dbPath, file);

  expect(existsSync(inFlight)).toBe(true);
  db = createDatabase(dbPath);
});

test('a restore holds the catalogue’s path even when there is no catalogue there', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  db.close();
  // Disaster recovery onto a host with nothing at DB_PATH - one of the two ways
  // anyone gets here. With no file to lock, a server starting during the vacuum
  // creates its own catalogue at that path, takes writes, and has them discarded by
  // the final rename: measured at 60 committed rows gone, both processes exiting 0.
  rmSync(dbPath);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  const held = holdAgainstUse(dbPath);
  try {
    expect(held).not.toBeNull();
    expect(existsSync(dbPath)).toBe(true); // an empty file, created purely to be locked
    const other = new Database(dbPath, { create: true });
    try {
      other.exec('PRAGMA busy_timeout = 0;');
      expect(() => other.exec('BEGIN IMMEDIATE')).toThrow();
    } finally {
      other.close();
    }
  } finally {
    held?.close();
  }

  // And the placeholder is never offered as "the catalogue that was there".
  const { movedAside } = await restoreBackup(dbPath, file);
  expect(movedAside).toBeNull();
  db = createDatabase(dbPath);
  expect(libraryNames(dbPath)).toEqual(['holiday']);
});

test('a WAL that cannot belong to the catalogue beside it is refused', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  db.close();
  await killedWriterLeavingWal(LATER, 'later');
  expect(existsSync(`${dbPath}-wal`)).toBe(true);

  // A restore done by hand: snapshot copied in, sidecars forgotten. SQLite binds a
  // WAL to nothing - its header identifies no database - so it replays over
  // whatever it is found beside, giving a catalogue that opens, passes quick_check,
  // is the right size, and holds a mix of two. What is checkable is the pairing:
  // `VACUUM INTO` writes a rollback-mode file, and such a file has never had a WAL.
  copyFileSync(file, dbPath);

  expect(() => createDatabase(dbPath)).toThrow(/cannot belong to/);
  expect(() => createDatabase(dbPath)).toThrow(/delete/);

  // And once the sidecars go, exactly as the message says, it opens clean.
  rmSync(`${dbPath}-wal`);
  rmSync(`${dbPath}-shm`, { force: true });
  db = createDatabase(dbPath);
  expect(libraryNames(dbPath)).toEqual(['holiday']);
});

test('a catalogue and its own WAL are left alone', async () => {
  addLibrary(LIB, 'holiday');
  // The ordinary case, and the one a careless check would break: a live WAL-mode
  // catalogue always has a `-wal`, and it is its own.
  expect(existsSync(`${dbPath}-wal`)).toBe(true);
  db.close();

  db = createDatabase(dbPath);

  expect(libraryNames(dbPath)).toEqual(['holiday']);
});

test('an empty database where the catalogue was counts as missing, not as a catalogue', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);
  db.close();
  rmSync(dbPath);

  // Zero bytes is what a truncating filesystem failure leaves; a valid but empty
  // 4096-byte database is what a killed restore's own lock placeholder leaves.
  // SQLite reads both as a database and the next start builds the schema straight
  // into them, so neither `existsSync` nor a size test sees the hazard.
  writeFileSync(dbPath, '');
  expect(() => createDatabase(dbPath)).toThrow(/backup\(s\) of it sit in/);

  // The real article, made the way a killed restore makes it.
  rmSync(dbPath);
  holdAgainstUse(dbPath)?.close();
  expect(statSync(dbPath).size).toBeGreaterThan(0);
  expect(() => createDatabase(dbPath)).toThrow(/backup\(s\) of it sit in/);

  db = new Database(dbPath, { create: true });
});

test('the in-use lock is still held when the check that took it returns', () => {
  db.close(); // nothing else holding it, so the lock is this check's to take
  // The check is worth nothing sampled. Everything after it - vacuuming the
  // snapshot out, then four renames - takes as long as the catalogue is big, and a
  // server starting in that window writes through its handle to the inode about to
  // be parked: reads right, shutdown clean, work gone at the next start.
  const held = holdAgainstUse(dbPath);

  try {
    expect(held).not.toBeNull();
    const other = new Database(dbPath);
    try {
      other.exec('PRAGMA busy_timeout = 0;');
      expect(() => other.exec('BEGIN IMMEDIATE')).toThrow();
    } finally {
      other.close();
    }
  } finally {
    held?.close();
    db = createDatabase(dbPath);
  }
});

test('a catalogue that has gone missing is refused rather than silently replaced', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);
  db.close();

  // Opening creates, so anything leaving DB_PATH absent - a volume that failed to
  // mount, a restore killed between its renames - otherwise gets a silent empty
  // replacement. Everything after that is invisible: the user sees an empty library
  // and re-adds their folder, and the rolling backup starts snapshotting the
  // replacement, rotating the real catalogue's history away within `keep` runs.
  //
  // Guarded here rather than in rotation, which is where it was first caught and
  // first patched: refusing to rotate on a snapshot with no libraries is defeated by
  // the very next thing the user does, which is re-add their library.
  rmSync(dbPath);

  expect(() => createDatabase(dbPath)).toThrow(/backup\(s\) of it sit in/);

  // And says what to do about it, rather than just refusing.
  expect(() => createDatabase(dbPath)).toThrow(/bun run restore latest/);
  db = new Database(dbPath, { create: true });
});

test('a first run with no backups beside it still creates a catalogue', async () => {
  db.close();
  rmSync(dbPath);
  rmSync(backupsDir(dbPath), { recursive: true, force: true });

  db = createDatabase(dbPath);

  expect(libraryNames(dbPath)).toEqual([]);
});

test('a catalogue emptied on purpose rotates normally', async () => {
  addLibrary(LIB, 'holiday');
  const first = await backups.backup(3);

  // Removing the last library is a thing people do, and it must not look like a
  // catalogue that vanished. The old rotation-side guard could not tell them apart
  // and refused for ever once it fired.
  db.query('DELETE FROM libraries').run();
  for (let i = 0; i < 5; i++) await backups.backup(3);

  const kept = await listBackups(dbPath);
  expect(kept.length).toBe(3);
  expect(kept).not.toContain(first.path);
});

test('a working file from a run that is still going is left alone', async () => {
  addLibrary(LIB, 'holiday');
  // Two servers on one catalogue, or an overlapping restart. Sweeping every working
  // file on sight deletes the other run's output from under it mid-vacuum.
  const inFlight = path.join(backupsDir(dbPath), `.${path.basename(dbPath)}-2020-01-01T00-00-00-000Z-9.part`);
  mkdirSync(backupsDir(dbPath), { recursive: true });
  writeFileSync(inFlight, 'someone else is writing this');

  await backups.backup(7);

  expect(existsSync(inFlight)).toBe(true);
});

// A stub worker, so the two ways a real one can fail to answer are reachable at
// all. Both are the same class of hazard: the promise never settles, the in-flight
// flag latches, and every later run is skipped by a schedule still logging health.
function stubWorker(body: string): string {
  const file = path.join(dir, `stub-worker-${body.length}.ts`);
  writeFileSync(file, `declare const self: { onmessage: ((e: MessageEvent) => void) | null };\n${body}`);
  return `file://${file}`;
}

test('a worker that exits without reporting is a failure, not silence', async () => {
  addLibrary(LIB, 'holiday');
  const service = new BackupService(dbPath, {
    workerUrl: stubWorker('self.onmessage = () => { process.exit(0); };'),
  });

  await expect(service.backup(7)).rejects.toThrow(/exited without reporting/);
});

test('a worker that wedges is given up on rather than latching the schedule', async () => {
  addLibrary(LIB, 'holiday');
  // A thread alive but stuck - inside VACUUM INTO or statfs on a hung mount - emits
  // no event at all, so `close` never fires and only the deadline breaks it.
  const service = new BackupService(dbPath, {
    workerUrl: stubWorker('self.onmessage = () => { setInterval(() => {}, 1000); };'),
    deadlineMs: 200,
  });

  await expect(service.backup(7)).rejects.toThrow(/did not finish within/);
  // And the schedule keeps going afterwards rather than being stuck for good.
  const scheduled = new ScheduledBackup(service, 1, 7);
  scheduled.start();
  await Bun.sleep(400);
  scheduled.stop();
  expect(await listBackups(dbPath)).toEqual([]);
});

test('the space a snapshot needs is the larger of the catalogue and its WAL', () => {
  // Both directions have shipped as bugs. Ignoring the WAL under-demands by 200x
  // when a reader has been holding checkpoints off; summing them over-demands by
  // 3x, because a checkpoint-starved WAL is mostly rewrites of pages already in
  // the main file, and refuses backups that had room.
  expect(spaceNeededFor(4096, 1_800_000)).toBe(2_700_000);
  expect(spaceNeededFor(15_700_000, 15_700_000)).toBe(23_550_000);
  expect(spaceNeededFor(1_000_000, 0)).toBe(1_500_000);
});

test('deleting a backup refuses anything that is not a flat file in the backup directory', async () => {
  const backupDir = backupsDir(dbPath);
  await backups.backup(7);

  // The guard that stands between rotation and the rest of the disk.
  await expect(deleteBackupFile(backupDir, path.join(backupDir, 'nested', 'x.db'))).rejects.toThrow(/not a file in/);
  await expect(deleteBackupFile(backupDir, path.join(dir, 'bowerbird.db'))).rejects.toThrow(/not a file in/);
  await expect(deleteBackupFile(backupDir, path.join(backupDir, 'DSC00001.ARW'))).rejects.toThrow(/is an original/);
});
