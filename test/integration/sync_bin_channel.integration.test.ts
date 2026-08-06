// The bin gets its own walk and its own diff (§6), so a binned file deleted,
// changed, moved or renamed by hand is noticed instead of ignored - and, in a
// read-only library, so a photograph binned in place is not re-imported as a
// duplicate on every sync (§5).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { PhotosService } from '../../src/services/photos/photos_service';
import type { ProcessingService } from '../../src/services/processing/processing_service';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = '00000000-0000-4000-8000-0000000000c8';

let root: string;
let db: ReturnType<typeof createDatabase>;
let libraries: LibrariesRepository;
let photos: PhotosRepository;
let sync: SyncService;
let service: PhotosService;

const abs = (rel: string) => path.join(root, rel);

interface Row {
  id: string;
  file_path: string;
  deleted_from_path: string | null;
  is_deleted: number;
  is_missing: number;
}
const rows = (): Row[] => db.query('SELECT id, file_path, deleted_from_path, is_deleted, is_missing FROM photos').all() as Row[];
const only = (): Row => {
  const all = rows();
  expect(all).toHaveLength(1);
  return all[0]!;
};

function makeLibrary(over: { read_only?: boolean; bin_name?: string | null } = {}): void {
  db.query('INSERT INTO libraries (id, root_path, name, ordering, bin_name, read_only) VALUES (?, ?, ?, ?, ?, ?)').run(
    LIB,
    root,
    'lib',
    'taken_desc',
    over.bin_name === undefined ? 'Bin' : over.bin_name,
    over.read_only === true ? 1 : 0,
  );
  const bin = over.bin_name === undefined ? 'Bin' : over.bin_name;
  if (bin != null) {
    mkdirSync(abs(bin), { recursive: true });
    const stats = statSync(abs(bin));
    libraries.setBinIdentity(LIB, { dev: stats.dev, ino: stats.ino, birthtime: stats.birthtimeMs });
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-binchan-'));
  db = createDatabase(':memory:');
  libraries = new LibrariesRepository(db);
  photos = new PhotosRepository(db);
  sync = new SyncService(
    photos,
    libraries,
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    extractMetadata,
  );
  service = new PhotosService(
    photos,
    new AlbumsRepository(db),
    new ShootsRepository(db),
    libraries,
    { renderLossless: async () => {} } as unknown as ProcessingService,
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// The whole point of §5: the exclusion is the row, not the folder. Without it the
// in-place binned file is in scope with no row to match and imports as a *new*
// photograph on every sync, for ever.
test('a photograph binned in place is not re-imported as a duplicate', async () => {
  makeLibrary({ read_only: true, bin_name: null });
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);

  await service.delete([only().id]);
  expect(only()).toMatchObject({ file_path: 'Trip/a.arw', deleted_from_path: 'Trip/a.arw', is_deleted: 1 });

  await sync.syncLibrary(LIB);
  await sync.syncLibrary(LIB);

  // One row, still binned, still where it was: nothing moved and nothing was
  // imported beside it.
  expect(only()).toMatchObject({ file_path: 'Trip/a.arw', is_deleted: 1, is_missing: 0 });
});

// `is_missing` on a binned row is unreachable without the bin channel, so a
// photograph whose RAW was taken out of the Bin by hand still showed in the Bin
// with an original that 404s.
test('a binned file deleted by hand is marked missing rather than ignored', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);
  expect(only().file_path).toBe('Bin/a.arw');

  unlinkSync(abs('Bin/a.arw'));
  const status = await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ is_deleted: 1, is_missing: 1 });
  // Not a photograph leaving the library, which is what photos_removed counts.
  expect(status.photos_removed).toBe(0);
});

// A file dropped into the bin by hand: the path test in §6.5 catches the crossing
// even though the copy has its own mtime and so its own hash.
test('a file moved into the bin by hand becomes the binned row, not a second one', async () => {
  makeLibrary();
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);
  const id = only().id;

  mkdirSync(abs('Bin/Trip'), { recursive: true });
  renameSync(abs('Trip/a.arw'), abs('Bin/Trip/a.arw'));
  await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ id, file_path: 'Bin/Trip/a.arw', deleted_from_path: 'Trip/a.arw', is_deleted: 1 });
});

test('a file taken back out of the bin by hand goes live again', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);
  const id = only().id;
  await service.delete([id]);

  renameSync(abs('Bin/a.arw'), abs('a.arw'));
  await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ id, file_path: 'a.arw', is_deleted: 0, is_missing: 0 });
  // The renditions it never had while it was binned are owed again.
  const flags = db.query('SELECT needs_tile, needs_renditions FROM photos WHERE id = ?').get(id) as {
    needs_tile: number;
    needs_renditions: number;
  };
  expect(flags).toEqual({ needs_tile: 1, needs_renditions: 1 });
});

// Undetected this is the worst outcome in the design: the live walk takes the
// renamed folder's files as unclaimed additions whose hashes match the binned
// rows exactly, and the whole bin is restored with `deleted_from_path` destroyed.
test('a hand-renamed bin folder is followed, not read as the whole bin being restored', async () => {
  makeLibrary();
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);

  renameSync(abs('Bin'), abs('Rubbish'));
  const status = await sync.syncLibrary(LIB);

  expect(libraries.getById(LIB)!.bin_name).toBe('Rubbish');
  expect(only()).toMatchObject({ file_path: 'Rubbish/Trip/a.arw', deleted_from_path: 'Trip/a.arw', is_deleted: 1 });
  // A folder rename, not a photograph moving.
  expect(status.photos_moved).toBe(0);
  expect(status.photos_added).toBe(0);

  // And a restore afterwards still puts the photograph back where it came from.
  await service.restore([only().id]);
  expect(only()).toMatchObject({ file_path: 'Trip/a.arw', is_deleted: 0 });
});

// A folder that merely inherited the bin's recycled inode number claims none of
// its files, and following it would silently bin a real shoot.
test('a folder carrying the bin identity but no binned file is not followed', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);

  // The bin is gone and something else now carries its identity.
  const identity = libraries.getBinIdentity(LIB)!;
  mkdirSync(abs('Keepers'));
  rmSync(abs('Bin'), { recursive: true });
  const innocent = statSync(abs('Keepers'));
  libraries.setBinIdentity(LIB, { ...identity, dev: innocent.dev, ino: innocent.ino });

  await sync.syncLibrary(LIB);

  expect(libraries.getById(LIB)!.bin_name).toBe('Bin');
  expect(only()).toMatchObject({ file_path: 'a.arw', is_deleted: 0 });
});

// Unclaimed files under the bin are the catalogue's, and they come in already
// binned rather than as live photographs the live walk would then never find.
test('an unclaimed file under the bin is imported as already-binned', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  mkdirSync(abs('Bin/Trip'), { recursive: true });
  copyFileSync(FIXTURE, abs('Bin/Trip/old.arw'));

  await sync.syncLibrary(LIB);

  const binned = rows().find((r) => r.is_deleted === 1);
  expect(binned).toMatchObject({ file_path: 'Bin/Trip/old.arw', deleted_from_path: 'Trip/old.arw' });
  // No renditions queued: `PENDING_PROCESSING` excludes binned rows anyway, and
  // building them for something already thrown away is work nobody asked for.
  const flags = db.query('SELECT needs_tile, needs_renditions FROM photos WHERE id = ?').get(binned!.id) as {
    needs_tile: number;
    needs_renditions: number;
  };
  expect(flags).toEqual({ needs_tile: 0, needs_renditions: 0 });
});

// `rewritePathPrefix` assumed a binned row's file was in the bin and so did not
// move with a renamed shoot folder. An in-place binned row's file is not in the
// bin, and it did move.
test('a hand-renamed shoot folder keeps its in-place binned rows reachable', async () => {
  makeLibrary({ read_only: true, bin_name: null });
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);

  renameSync(abs('Trip'), abs('Trip 2019'));
  await sync.syncLibrary(LIB);

  // One row, not a live duplicate plus an orphan pointing at nothing.
  expect(only()).toMatchObject({ file_path: 'Trip 2019/a.arw', deleted_from_path: 'Trip 2019/a.arw', is_deleted: 1 });
});

// The run that finds the bin gone has no evidence about the files that were in
// it: "the folder is not there" is the state §2.4 hands §6.3 for repair as much
// as it is a deletion.
test('a deleted bin folder skips the channel rather than marking every binned row missing', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);

  rmSync(abs('Bin'), { recursive: true });
  await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ is_deleted: 1, is_missing: 0 });
});

// The cost is the point, and the row assertions pass either way: a bin of 100k
// frames that re-hashed nightly would be hours of LibRaw for nothing.
test('a binned file whose stat has not changed is never opened', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);

  const opened: string[] = [];
  const spying = new SyncService(
    photos,
    libraries,
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    async (absPath: string) => {
      opened.push(absPath);
      return extractMetadata(absPath);
    },
  );
  await spying.syncLibrary(LIB);

  expect(opened).toEqual([]);
});

// The watcher never reports events inside the bin, so a scoped run has no
// evidence and must not conclude `is_missing` on rows it did not look at.
test('a scoped sync touches no binned row', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  copyFileSync(FIXTURE, abs('b.arw'));
  await sync.syncLibrary(LIB);
  const binnedId = rows().find((r) => r.file_path === 'a.arw')!.id;
  await service.delete([binnedId]);
  unlinkSync(abs('Bin/a.arw'));

  await sync.syncLibrary(LIB, ['b.arw']);

  expect(rows().find((r) => r.id === binnedId)).toMatchObject({ is_deleted: 1, is_missing: 0 });
});
