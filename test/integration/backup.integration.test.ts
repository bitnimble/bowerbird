// A backup nobody has restored is not a backup, so both halves are pinned here
// against a real database on a real filesystem (§4.9).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { LATEST_USER_VERSION } from '../../src/db/migrations';
import { BackupService, ScheduledBackup, backupsDir, findBackup, listBackups } from '../../src/services/maintenance/backup_service';
import { restoreBackup } from '../../src/services/maintenance/restore';

const LIB = '00000000-0000-4000-8000-00000000ab01';

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
  expect(bytes).toBeGreaterThan(0);
  expect(removed).toBe(0);
  expect(path.dirname(file)).toBe(backupsDir(dbPath));
  // Nothing was checkpointed between the insert and the snapshot, so a plain file
  // copy of the .db would have missed this row entirely.
  expect(libraryNames(file)).toEqual(['holiday']);
  // Self-contained: `VACUUM INTO` writes one file, with no sidecars to restore alongside it.
  expect(readdirSync(backupsDir(dbPath))).toEqual([path.basename(file)]);
});

test('a backup is only ever renamed into place once it has been verified', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);

  // Nothing part-written left behind, under any name: the working file is
  // dot-prefixed and goes either way the run ends.
  expect(readdirSync(backupsDir(dbPath)).filter((name) => name.startsWith('.'))).toEqual([]);
});

test('rotation keeps the newest N and drops the rest', async () => {
  addLibrary(LIB, 'holiday');

  const made: string[] = [];
  for (let i = 0; i < 4; i++) made.push((await backups.backup(2)).path);

  const kept = readdirSync(backupsDir(dbPath)).sort();
  expect(kept).toEqual(made.slice(-2).map((file) => path.basename(file)).sort());
});

test('rotation only counts this catalogue’s own backups', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(1);
  // A second catalogue in the same directory, so both share `backups/`.
  const other = path.join(backupsDir(dbPath), 'elsewhere-2020-01-01T00-00-00-000Z.db');
  writeFileSync(other, 'not ours');

  await backups.backup(1);

  expect(existsSync(other)).toBe(true);
});

// Finished snapshots only. Mid-run the directory also holds the dot-prefixed
// working file, and the verify step's read-only open leaves a -shm beside the
// output until it closes, so a raw count of the directory races both.
function finished(): string[] {
  const dir = backupsDir(dbPath);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.db')) : [];
}

// start() kicks the catch-up off without waiting for it, so the assertion is on
// what the directory settles to.
async function settled(): Promise<string[]> {
  for (let attempt = 0; attempt < 100 && finished().length === 0; attempt++) await Bun.sleep(20);
  return finished();
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
  await backups.backup(7);
  const scheduled = new ScheduledBackup(backups, 1, 7);

  scheduled.start();
  await Bun.sleep(200);
  scheduled.stop();

  expect(finished().length).toBe(1);
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
  expect(await findBackup(dbPath, 'bowerbird-2020-01-01T00-00-00-000Z.db')).toBeUndefined();
});

test('another catalogue’s snapshot is neither listed nor restorable by name', async () => {
  addLibrary(LIB, 'holiday');
  await backups.backup(7);
  const other = path.join(backupsDir(dbPath), 'elsewhere-2099-01-01T00-00-00-000Z.db');
  writeFileSync(other, 'not ours');

  // Newest by name, so `latest` would reach for it if the filter were only `.db`.
  expect(await listBackups(dbPath)).not.toContain(other);
  expect(await findBackup(dbPath, path.basename(other))).toBeUndefined();
  expect(await findBackup(dbPath, 'latest')).not.toBe(other);
});

test('restoring puts the catalogue back and keeps the one it displaced', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);

  // Work done after the snapshot, with a WAL still holding it. Left open rather
  // than closed, because closing checkpoints and removes the WAL - and the case
  // this has to survive is the one where nothing tidied up, which is exactly when
  // somebody reaches for a backup.
  addLibrary('00000000-0000-4000-8000-00000000ab02', 'later');
  expect(existsSync(`${dbPath}-wal`)).toBe(true);

  const { movedAside, version } = await restoreBackup(dbPath, file);
  db.close();

  expect(version).toBe(LATEST_USER_VERSION);
  // The live WAL travelled with the catalogue it belongs to. Left behind, SQLite
  // would replay it over the restored file and undo the restore.
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${movedAside}-wal`)).toBe(true);
  expect(libraryNames(movedAside!).sort()).toEqual(['holiday', 'later']);

  // Reopened the way the server opens it, so the assertion covers what a restart
  // would actually find rather than what the file says on its own.
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

  expect(restoreBackup(dbPath, file)).rejects.toThrow(/newer Bowerbird/);
  // Refused before anything moved: the catalogue is still where the server left it.
  expect(existsSync(dbPath)).toBe(true);

  db = createDatabase(dbPath);
});

test('a corrupt backup is refused', async () => {
  addLibrary(LIB, 'holiday');
  const { path: file } = await backups.backup(7);
  writeFileSync(file, 'not a database');

  expect(restoreBackup(dbPath, file)).rejects.toThrow();
});
