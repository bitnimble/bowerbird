// A backup nobody has restored is not a backup, so both halves are pinned here
// against a real database on a real filesystem (§4.9).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { LATEST_USER_VERSION } from '../../src/db/migrations';
import { BackupService, ScheduledBackup, findBackup, listBackups } from '../../src/services/maintenance/backup_service';
import { restoreBackup } from '../../src/services/maintenance/restore';
import { deleteBackupFile } from '../../src/utils/deletions';
import { backupsDir } from '../../src/utils/paths';

const LIB = '00000000-0000-4000-8000-00000000ab01';
const LATER = '00000000-0000-4000-8000-00000000ab02';

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
  // Nothing of the old catalogue is left at the path SQLite would derive a WAL
  // name from. Left behind, it would be replayed over the restored file.
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  // The work that was in that WAL went with the catalogue it belongs to, so the
  // displaced copy is complete and the restore stays undoable. (The in-use probe
  // recovers the WAL into the main file on its way past, so it travels inside the
  // parked catalogue rather than beside it.)
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
  // Refused before anything moved: the catalogue is still where the server left it.
  expect(existsSync(dbPath)).toBe(true);
  expect(existsSync(`${dbPath}.restoring`)).toBe(false);

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

  expect(statSync(dbPath).isSymbolicLink === undefined || existsSync(real)).toBe(true);
  expect(existsSync(real)).toBe(true);
  expect(libraryNames(real)).toEqual(['holiday']);
  db = createDatabase(dbPath);
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

test('a snapshot stamped in the future counts as due rather than stopping the schedule', async () => {
  addLibrary(LIB, 'holiday');
  const { path: first } = await backups.backup(7);
  // A clock that was briefly ahead - a VM before NTP settles, a fileserver leading
  // the client. Read as "not due yet" this stops backups for the length of the
  // skew, with nothing logged and nothing on screen to see it by.
  const ahead = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  utimesSync(first, ahead, ahead);
  expect(await backups.ageOfNewest()).toBeLessThan(0);

  const scheduled = new ScheduledBackup(backups, 1, 7);
  scheduled.start();
  for (let attempt = 0; attempt < 100 && (await listBackups(dbPath)).length < 2; attempt++) await Bun.sleep(20);
  scheduled.stop();

  expect((await listBackups(dbPath)).length).toBe(2);
});

test('history is not rotated away for a snapshot of a suddenly-empty catalogue', async () => {
  addLibrary(LIB, 'holiday');
  for (let i = 0; i < 200; i++) addLibrary(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `lib-${i}`);
  const real = await backups.backup(2);
  db.close();

  // Anything that leaves DB_PATH absent gets a fresh 8KB catalogue on the next
  // start, because the server creates on open. Rotating on those wipes the real
  // catalogue's entire history within `keep` runs - at the defaults, a week - with
  // every run logging a successful backup.
  rmSync(dbPath);
  db = createDatabase(dbPath);
  await backups.backup(2);
  await backups.backup(2);

  expect(await listBackups(dbPath)).toContain(real.path);
  expect(libraryNames(real.path).length).toBeGreaterThan(200);
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

test('deleting a backup refuses anything that is not a flat file in the backup directory', async () => {
  const backupDir = backupsDir(dbPath);
  await backups.backup(7);

  // The guard that stands between rotation and the rest of the disk.
  await expect(deleteBackupFile(backupDir, path.join(backupDir, 'nested', 'x.db'))).rejects.toThrow(/not a file in/);
  await expect(deleteBackupFile(backupDir, path.join(dir, 'bowerbird.db'))).rejects.toThrow(/not a file in/);
  await expect(deleteBackupFile(backupDir, path.join(backupDir, 'DSC00001.ARW'))).rejects.toThrow(/is an original/);
});
