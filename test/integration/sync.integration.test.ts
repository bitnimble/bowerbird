// Integration test for sync change-detection against a real Sony ARW fixture.
// Requires LibRaw, so it runs under Bun inside the container, NOT host jest:
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = 'lib00001';

let root: string;
let outside: string;
let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;
let sync: SyncService;
let photoId: string;
let opens = 0; // counts LibRaw opens so we can assert the stat quick-check skips them

const abs = (rel: string) => path.join(root, rel);
const row = (filePath: string) =>
  db.query('SELECT id, shoot_id, is_missing FROM photos WHERE file_path = ?').get(filePath) as
    | { id: string; shoot_id: string | null; is_missing: number }
    | null;
const count = () => (db.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-int-'));
  outside = mkdtempSync(path.join(tmpdir(), 'bb-out-'));
  db = createDatabase(':memory:');
  // Mirroring off: this suite is about the diff, moves and relocation, and a
  // shoot appearing for every folder it makes would answer its questions for it.
  // Mirroring has its own suite (sync_mirror).
  db.query('INSERT INTO libraries (id, root_path, name, ordering, mirror_shoots) VALUES (?, ?, ?, ?, 0)').run(LIB, root, 'lib', 'taken_desc');
  photos = new PhotosRepository(db);
  // No-op processing trigger: this suite exercises scan/diff detection with real
  // metadata, not rendition generation (validated separately).
  const countingExtract = async (p: string) => {
    opens++;
    return extractMetadata(p);
  };
  sync = new SyncService(
    photos,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    countingExtract,
  );
  copyFileSync(FIXTURE, abs('photo1.arw'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('initial sync indexes the file with real LibRaw metadata', async () => {
  const status = await sync.syncLibrary(LIB);
  expect(status.photos_added).toBe(1);
  const p = db.query('SELECT id, width, height, orientation, date_taken FROM photos').get() as {
    id: string;
    width: number;
    height: number;
    orientation: number;
    date_taken: string;
  };
  photoId = p.id;
  expect(p.width).toBe(4024);
  expect(p.height).toBe(6024);
  expect(p.orientation).toBe(5); // LibRaw flip code for the rotated fixture
  expect(p.date_taken).toBe('2020-12-06T12:46:35.000Z');
  expect(opens).toBe(1); // the one new file was opened
});

test('a re-sync with nothing changed opens zero files (stat quick-check)', async () => {
  const before = opens;
  await sync.syncLibrary(LIB);
  expect(opens).toBe(before); // unchanged file is not re-opened
});

test('rename is a move: same record, new path, no add/remove', async () => {
  renameSync(abs('photo1.arw'), abs('renamed.arw')); // rename preserves mtime -> same content hash
  const status = await sync.syncLibrary(LIB);
  expect(status.photos_moved).toBe(1);
  expect(status.photos_added).toBe(0);
  expect(status.photos_removed).toBe(0);
  expect(row('renamed.arw')?.id).toBe(photoId);
});

test('duplicating to a new name adds a separate photo', async () => {
  copyFileSync(abs('renamed.arw'), abs('dup.arw')); // copy gets a fresh mtime -> distinct hash -> plain add
  const status = await sync.syncLibrary(LIB);
  expect(status.photos_added).toBe(1);
  expect(count()).toBe(2);
});

test('moving a file into a subfolder is a move', async () => {
  mkdirSync(abs('sub'));
  renameSync(abs('dup.arw'), abs('sub/dup.arw'));
  const status = await sync.syncLibrary(LIB);
  expect(status.photos_moved).toBe(1);
  expect(row('sub/dup.arw')).not.toBeNull();
});

test('deleting a file flags it missing but keeps the record', async () => {
  renameSync(abs('renamed.arw'), path.join(outside, 'renamed.arw')); // gone from the library
  const status = await sync.syncLibrary(LIB);
  expect(status.photos_removed).toBe(1);
  expect(row('renamed.arw')?.is_missing).toBe(1);
  expect(count()).toBe(2); // record retained
});

test('restoring the file at its path clears missing (reappearance)', async () => {
  renameSync(path.join(outside, 'renamed.arw'), abs('renamed.arw')); // same bytes + mtime -> same hash
  const status = await sync.syncLibrary(LIB);
  expect(status.photos_removed).toBe(0);
  expect(status.photos_added).toBe(0);
  expect(status.photos_moved).toBe(0);
  expect(row('renamed.arw')?.is_missing).toBe(0);
});

test('moving a file into a known shoot folder reconciles shoot_id', async () => {
  db.query('INSERT INTO shoots (id, library_id, folder_path, name, ordering) VALUES (?, ?, ?, ?, ?)').run(
    'sh1',
    LIB,
    'ShootFolder',
    'ShootFolder',
    'taken_desc',
  );
  mkdirSync(abs('ShootFolder'));
  renameSync(abs('renamed.arw'), abs('ShootFolder/renamed.arw'));
  await sync.syncLibrary(LIB);
  expect(row('ShootFolder/renamed.arw')?.shoot_id).toBe('sh1');
});

// A shoot folder renamed outside the app. The photos are the only evidence the
// folder moved rather than vanished, so this exercises the whole chain: scan ->
// per-file move detection -> whole-folder inference -> bulk prefix rewrite.
test('a shoot folder renamed on disk relocates the shoot instead of orphaning its photos', async () => {
  const folderPath = () => (db.query('SELECT folder_path FROM shoots WHERE id = ?').get('sh1') as { folder_path: string }).folder_path;
  // A photo binned out of the shoot. Its file is in the library's one bin, which
  // sync never scans, so nothing in the move detection can speak for it; only the
  // prefix rewrite can.
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, file_path, deleted_from_path, file_hash, width, height, orientation,
       date_added, file_size, is_deleted) VALUES (?, ?, ?, ?, ?, 'h', 1, 1, 1, '2024-01-01', 1, 1)`,
  ).run('binned', LIB, 'sh1', 'Bin/ShootFolder/old.arw', 'ShootFolder/old.arw');

  renameSync(abs('ShootFolder'), abs('Renamed'));
  const status = await sync.syncLibrary(LIB);

  expect(folderPath()).toBe('Renamed');
  // Membership never had to be recomputed: the shoot moved with the photo.
  expect(row('Renamed/renamed.arw')?.shoot_id).toBe('sh1');
  expect(row('ShootFolder/renamed.arw')).toBeNull();
  expect(row('Renamed/renamed.arw')?.is_missing).toBe(0);
  // The binned photo's file is in the bin and did not move with the folder, so
  // its path is untouched; what follows the rename is where a restore puts it
  // back, which is the folder under its new name (§12.3).
  const binned = db.query('SELECT file_path, deleted_from_path, is_deleted FROM photos WHERE id = ?').get('binned') as {
    file_path: string;
    deleted_from_path: string;
    is_deleted: number;
  };
  expect(binned).toEqual({ file_path: 'Bin/ShootFolder/old.arw', deleted_from_path: 'Renamed/old.arw', is_deleted: 1 });
  // Counted as moved, and emphatically not as removed-and-added.
  expect(status.photos_moved).toBe(1);
  expect(status.photos_removed).toBe(0);
  expect(status.photos_added).toBe(0);
});

// Organising a shoot's frames into a subfolder moves every one of them and keeps
// each filename, which by the paths alone is identical to renaming the folder.
// The shoot did not move, so it must not be relocated into its own subfolder.
test('sorting a shoot into a subfolder leaves the shoot where it is', async () => {
  const folderPath = () => (db.query('SELECT folder_path FROM shoots WHERE id = ?').get('sh1') as { folder_path: string }).folder_path;
  mkdirSync(abs('Renamed/Selects'));
  renameSync(abs('Renamed/renamed.arw'), abs('Renamed/Selects/renamed.arw'));

  await sync.syncLibrary(LIB);

  expect(folderPath()).toBe('Renamed');
  // The photo moved and is still in the shoot, because the subfolder is under it.
  expect(row('Renamed/Selects/renamed.arw')?.shoot_id).toBe('sh1');
});
