// The bin gets its own walk and its own diff (§6), so a binned file deleted,
// changed, moved or renamed by hand is noticed instead of ignored - and, in a
// read-only library, so a photograph binned in place is not re-imported as a
// duplicate on every sync (§9.1.1).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
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
const shootOf = (id: string): string | null =>
  (db.query('SELECT shoot_id FROM photos WHERE id = ?').get(id) as { shoot_id: string | null }).shoot_id;

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

// The whole point of the bin channel: the exclusion is the row, not the folder. Without it the
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

// A file moved into the bin by hand pairs on its hash, which a rename preserves.
// Its shoot membership is kept rather than nulled by the move's own write, which
// is what an app-driven binning does.
test('a file moved into the bin by hand becomes the binned row, not a second one', async () => {
  makeLibrary();
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);
  const id = only().id;
  const shoot = shootOf(id);
  expect(shoot).not.toBeNull();

  mkdirSync(abs('Bin/Trip'), { recursive: true });
  renameSync(abs('Trip/a.arw'), abs('Bin/Trip/a.arw'));
  await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ id, file_path: 'Bin/Trip/a.arw', deleted_from_path: 'Trip/a.arw', is_deleted: 1 });
  expect(shootOf(id)).toBe(shoot);
});

// Copied in and the original deleted, or touched on the way: the hashes differ,
// so only the path test (§9.1.1) can see this is one photograph rather than a missing
// live row plus a second already-binned one.
test('a file copied into the bin with its own mtime is still one row, not two', async () => {
  makeLibrary();
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);
  const id = only().id;

  mkdirSync(abs('Bin/Trip'), { recursive: true });
  copyFileSync(abs('Trip/a.arw'), abs('Bin/Trip/a.arw'));
  // A fresh mtime, which is what a copy leaves and what the hash is a digest of.
  utimesSync(abs('Bin/Trip/a.arw'), new Date(), new Date());
  unlinkSync(abs('Trip/a.arw'));

  await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ id, file_path: 'Bin/Trip/a.arw', deleted_from_path: 'Trip/a.arw', is_deleted: 1 });
});

test('a file taken back out of the bin by hand goes live again, in the shoot it landed in', async () => {
  makeLibrary();
  mkdirSync(abs('Keepers'));
  copyFileSync(FIXTURE, abs('a.arw'));
  copyFileSync(FIXTURE, abs('Keepers/kept.arw')); // so `Keepers` is a mirrored shoot
  await sync.syncLibrary(LIB);
  const id = rows().find((r) => r.file_path === 'a.arw')!.id;
  await service.delete([id]);
  expect(shootOf(id)).toBeNull();

  // Back out of the bin, and into a folder that is a shoot: `markRestored` does
  // not touch `shoot_id`, and mirroring only restates claims under folders it has
  // just made - so without the crossing setting it the photograph would land in
  // the grid with no shoot for good.
  renameSync(abs('Bin/a.arw'), abs('Keepers/a.arw'));
  await sync.syncLibrary(LIB);

  expect(rows().find((r) => r.id === id)).toMatchObject({ file_path: 'Keepers/a.arw', is_deleted: 0, is_missing: 0 });
  expect(shootOf(id)).toBe(shootOf(rows().find((r) => r.file_path === 'Keepers/kept.arw')!.id));
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

// A folder that merely inherited the bin's freed inode number does not hold the
// bin's files, and following it would silently bin a real shoot - the worst
// outcome in the design. The library has binned rows, which is the case the
// guard has to survive: "does this library have anything in its bin" is true of
// every library that has ever binned anything.
test('a folder carrying the bin identity but not holding its files is not followed', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  mkdirSync(abs('Keepers'));
  copyFileSync(FIXTURE, abs('Keepers/kept.arw'));
  await sync.syncLibrary(LIB);
  const binnedId = rows().find((r) => r.file_path === 'a.arw')!.id;
  await service.delete([binnedId]);
  expect(rows().find((r) => r.id === binnedId)!.file_path).toBe('Bin/a.arw');

  // The photographer deletes the bin, contents and all, and the filesystem hands
  // the freed inode to a real shoot folder.
  rmSync(abs('Bin'), { recursive: true });
  const innocent = statSync(abs('Keepers'));
  libraries.setBinIdentity(LIB, { dev: innocent.dev, ino: innocent.ino, birthtime: innocent.birthtimeMs });

  await sync.syncLibrary(LIB);

  expect(libraries.getById(LIB)!.bin_name).toBe('Bin');
  // The shoot is still a shoot: its photograph is live, present, and its file was
  // not adopted as a binned one.
  expect(rows().find((r) => r.file_path === 'Keepers/kept.arw')).toMatchObject({ is_deleted: 0, is_missing: 0 });
  expect(rows()).toHaveLength(2);
});

// A bin the photographer named with a leading dot is the tree being walked, not
// a dotfolder to skip - and skipping it marked every binned frame below the bin
// root missing while the files sat right there.
test('a bin named with a leading dot is still walked', async () => {
  makeLibrary({ bin_name: '.Trash' });
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);
  expect(only().file_path).toBe('.Trash/Trip/a.arw');

  await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ is_deleted: 1, is_missing: 0 });
});

// A read-only library keeps the bin it had from before the flag, and its
// photographer may have deleted that folder on purpose. Making it again is a
// write under a root the app may not write to.
test('a deleted bin is not recreated in a read-only library', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);
  rmSync(abs('Bin'), { recursive: true });
  db.query('UPDATE libraries SET read_only = 1 WHERE id = ?').run(LIB);

  await sync.syncLibrary(LIB);
  expect(existsSync(abs('Bin'))).toBe(false);

  // And a writable one does get it back, so this is the flag doing the work.
  db.query('UPDATE libraries SET read_only = 0 WHERE id = ?').run(LIB);
  await sync.syncLibrary(LIB);
  expect(existsSync(abs('Bin'))).toBe(true);
});

// The inode answers a rename; it cannot answer a copy-and-delete or a library
// restored from a backup. An in-place binned row's file moved with the folder
// either way, and reading that as a hand-restore puts a thrown-away photograph
// back in the collection - or, with no bin at all, leaves an orphan pointing at
// nothing beside a fresh live duplicate.
test('a folder move the inode cannot follow does not restore an in-place binned row', async () => {
  makeLibrary({ read_only: true, bin_name: null });
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);

  // Copied and deleted rather than renamed, so the new folder has its own inode
  // and §9.4.1 cannot answer. Timestamps preserved, as a restore from a backup
  // preserves them - which is what leaves the frame recognisable at all, the
  // hash being a digest of the stat rather than of the pixels.
  const was = statSync(abs('Trip/a.arw'));
  mkdirSync(abs('Trip 2019'));
  copyFileSync(abs('Trip/a.arw'), abs('Trip 2019/a.arw'));
  utimesSync(abs('Trip 2019/a.arw'), was.atime, was.mtime);
  rmSync(abs('Trip'), { recursive: true });

  await sync.syncLibrary(LIB);

  expect(only()).toMatchObject({ file_path: 'Trip 2019/a.arw', deleted_from_path: 'Trip 2019/a.arw', is_deleted: 1 });
});

// A frame deleted out of a folder that was renamed in the same window: the
// relocation moves the row by prefix, so a `setMissing` keyed on the path the
// scan saw matches nothing and silently does nothing.
test('a file deleted from a folder renamed in the same window is still marked missing', async () => {
  makeLibrary();
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  copyFileSync(FIXTURE, abs('Trip/b.arw'));
  await sync.syncLibrary(LIB);

  renameSync(abs('Trip'), abs('Trip 2019'));
  unlinkSync(abs('Trip 2019/b.arw'));
  const status = await sync.syncLibrary(LIB);

  expect(rows().find((r) => r.file_path === 'Trip 2019/a.arw')).toMatchObject({ is_missing: 0 });
  expect(rows().find((r) => r.file_path === 'Trip 2019/b.arw')).toMatchObject({ is_missing: 1 });
  expect(status.photos_removed).toBe(1);
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
// it: "the folder is not there" is the state a bin rename (§4.1) hands the channel for repair as much
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

// Both writes are path-guarded, and they disagree about which path: after a
// followed rename the scan's paths are the new ones while the rows still hold the
// old, so a `setMissing` issued before the prefix rewrite matches nothing and
// silently does nothing - a guard written to absorb a race quietly absorbing a
// correct write.
test('a followed bin rename that also loses a file does both, not just the rename', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  copyFileSync(FIXTURE, abs('b.arw'));
  await sync.syncLibrary(LIB);
  const kept = rows().find((r) => r.file_path === 'a.arw')!.id;
  const lost = rows().find((r) => r.file_path === 'b.arw')!.id;
  await service.delete([kept, lost]);

  // Renamed and emptied of one frame in the same window.
  renameSync(abs('Bin'), abs('Rubbish'));
  unlinkSync(abs('Rubbish/b.arw'));
  await sync.syncLibrary(LIB);

  expect(libraries.getById(LIB)!.bin_name).toBe('Rubbish');
  expect(rows().find((r) => r.id === kept)).toMatchObject({ file_path: 'Rubbish/a.arw', is_missing: 0 });
  expect(rows().find((r) => r.id === lost)).toMatchObject({ file_path: 'Rubbish/b.arw', is_missing: 1 });
});

// A Finder rename of a root-level folder *is* delivered by the watcher, so the
// detection runs on a scoped sync even though the bin's walk and diff do not -
// without it the bin's files are unclaimed live additions and every binned RAW
// gets a second, live row.
test('a bin rename the watcher reports is followed on a scoped sync', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);
  await service.delete([only().id]);

  renameSync(abs('Bin'), abs('Rubbish'));
  await sync.syncLibrary(LIB, ['Rubbish']);

  expect(libraries.getById(LIB)!.bin_name).toBe('Rubbish');
  expect(only()).toMatchObject({ file_path: 'Rubbish/a.arw', is_deleted: 1, is_missing: 0 });
});

// The identity has to be re-recorded when the folder is remade, or the next
// rename of it can never be followed - and the freed inode is the likeliest to
// be handed to something else.
test('recreating a deleted bin records the new folder identity', async () => {
  makeLibrary();
  copyFileSync(FIXTURE, abs('a.arw'));
  await sync.syncLibrary(LIB);
  const before = libraries.getBinIdentity(LIB)!;

  rmSync(abs('Bin'), { recursive: true });
  await sync.syncLibrary(LIB);

  expect(existsSync(abs('Bin'))).toBe(true);
  const after = libraries.getBinIdentity(LIB)!;
  expect(after.ino).toBe(statSync(abs('Bin')).ino);
  expect(after.ino).not.toBe(before.ino);
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
