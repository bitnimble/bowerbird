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
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = '00000000-0000-4000-8000-000000000001';

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
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, root, 'taken_desc');
  photos = new PhotosRepository(db);
  // No-op processing trigger: this suite exercises scan/diff detection with real
  // metadata, not thumbnail generation (validated separately).
  const countingExtract = async (p: string) => {
    opens++;
    return extractMetadata(p);
  };
  sync = new SyncService(
    photos,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
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
  const p = db.query('SELECT id, width, height, date_taken FROM photos').get() as {
    id: string;
    width: number;
    height: number;
    date_taken: string;
  };
  photoId = p.id;
  expect(p.width).toBe(4024);
  expect(p.height).toBe(6024);
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
