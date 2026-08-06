// A read-only library over a fixture tree with the directory permissions actually
// dropped, so a stray write fails the test rather than passing unnoticed. Sync,
// bin, restore, undo, rate and album all have to work without one byte moving.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { AlbumsService } from '../../src/services/albums/albums_service';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { PhotosService } from '../../src/services/photos/photos_service';
import type { ProcessingService } from '../../src/services/processing/processing_service';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ShootsService } from '../../src/services/shoots/shoots_service';
import { StacksRepository } from '../../src/services/stacks/stacks_repository';
import { StacksService } from '../../src/services/stacks/stacks_service';
import { SyncService } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = '00000000-0000-4000-8000-0000000000d4';

let root: string;
let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;
let sync: SyncService;
let service: PhotosService;
let shootsService: ShootsService;
let albumsService: AlbumsService;
let stacksService: StacksService;

const abs = (rel: string) => path.join(root, rel);

// Every file under the root, with its size and mtime, so "nothing was touched"
// is an assertion rather than a hope.
function tree(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, tree(path.join(dir, entry.name), rel));
    else {
      const stats = statSync(path.join(dir, entry.name));
      out[rel] = `${stats.size}@${stats.mtimeMs}`;
    }
  }
  return out;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-ro-'));
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/a.arw'));
  copyFileSync(FIXTURE, abs('b.arw'));

  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering, bin_name, read_only) VALUES (?, ?, ?, ?, NULL, 1)').run(
    LIB,
    root,
    'archive',
    'taken_desc',
  );
  photos = new PhotosRepository(db);
  const libraries = new LibrariesRepository(db);
  const albums = new AlbumsRepository(db);
  const shoots = new ShootsRepository(db);
  sync = new SyncService(
    photos,
    libraries,
    albums,
    shoots,
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    extractMetadata,
  );
  service = new PhotosService(photos, albums, shoots, libraries, {
    renderLossless: async () => {},
  } as unknown as ProcessingService);
  shootsService = new ShootsService(shoots, photos, libraries, new FolderRulesRepository(db));
  albumsService = new AlbumsService(albums, photos);
  stacksService = new StacksService(new StacksRepository(db), photos, libraries);

  await sync.syncLibrary(LIB);
  // Only after the import, so the scan could read the tree: from here the app
  // cannot create, rename or delete anything under the root.
  chmodSync(abs('Trip'), 0o500);
  chmodSync(root, 0o500);
});

afterEach(() => {
  db.close();
  chmodSync(root, 0o700);
  chmodSync(abs('Trip'), 0o700);
  rmSync(root, { recursive: true, force: true });
});

const ids = (): string[] => (db.query('SELECT id FROM photos ORDER BY file_path').all() as { id: string }[]).map((r) => r.id);

test('everything the catalogue owns still works, and the tree is byte-identical afterwards', async () => {
  const before = tree(root);
  const [first, second] = ids();
  expect(ids()).toHaveLength(2);

  // Binning: the flag moves, the file does not.
  await service.delete([first!], 'batch-1');
  const binned = db.query('SELECT file_path, deleted_from_path, is_deleted FROM photos WHERE id = ?').get(first!) as {
    file_path: string;
    deleted_from_path: string;
    is_deleted: number;
  };
  expect(binned).toEqual({ file_path: 'Trip/a.arw', deleted_from_path: 'Trip/a.arw', is_deleted: 1 });

  // And the undo of it, which also moves nothing - and must not rename the file
  // to `a_1.arw` by claiming a name it already holds.
  await service.restore([first!]);
  expect(photos.isBinned(first!)).toBe(false);
  expect(readdirSync(abs('Trip'))).toEqual(['a.arw']);

  // Ratings, triage, notes, albums and stacks are rows, so none of them is in
  // question - which is the whole claim: what a read-only library gives up is
  // short, and none of the catalogue's own work is in it.
  photos.update(second!, { rating: 4, triage: 'picked', notes: 'keep' });
  const album = albumsService.create({ name: 'Keepers', ordering: 'taken_asc' });
  albumsService.addPhotos(album.id, [second!]);
  expect(new AlbumsRepository(db).getAlbumIdsForPhoto(second!)).toEqual([album.id]);

  const stack = stacksService.create([first!, second!]);
  expect(
    stacksService
      .photosOf(stack.id)
      .map((p) => p.id)
      .sort(),
  ).toEqual([first!, second!].sort());

  // A second sync sees exactly what the first left.
  const status = await sync.syncLibrary(LIB);
  expect(status.photos_added).toBe(0);
  expect(status.photos_removed).toBe(0);
  expect(ids()).toHaveLength(2);

  expect(tree(root)).toEqual(before);
});

test('a shoot has to be a folder that already exists, and photographs cannot be moved into one', async () => {
  await expect(
    shootsService.create({ library_id: LIB, parent_path: '', name: 'New Shoot', ordering: 'taken_asc' }),
  ).rejects.toMatchObject({ code: 'READ_ONLY' });

  // The folder that is there is fine: mirroring already made it a shoot, without
  // the library having to be written to.
  const trip = shootsService.list(LIB).find((s) => s.folder_path === 'Trip');
  expect(trip).toBeDefined();

  await expect(shootsService.addPhotos(trip!.id, [ids()[1]!])).rejects.toMatchObject({ code: 'READ_ONLY' });
});

// A library flipped to read-only keeps the RAWs the app already put in its bin,
// and taking one back out is a move it may no longer make. Refused for the whole
// batch before any row is restored: a half-landed undo is worse than none.
test('a restore out of a flipped library\'s bin is refused before anything is restored', async () => {
  chmodSync(root, 0o700);
  mkdirSync(abs('Bin'), { recursive: true });
  const [first, second] = ids();
  db.query('UPDATE libraries SET bin_name = ? WHERE id = ?').run('Bin', LIB);
  // One row binned into the bin, one binned in place, as a flipped library holds.
  db.query('UPDATE photos SET is_deleted = 1, deleted_from_path = ?, file_path = ? WHERE id = ?').run(
    'Trip/a.arw',
    'Bin/Trip/a.arw',
    first!,
  );
  db.query('UPDATE photos SET is_deleted = 1, deleted_from_path = file_path WHERE id = ?').run(second!);
  chmodSync(root, 0o500);

  await expect(service.restore([first!, second!])).rejects.toMatchObject({ code: 'READ_ONLY' });
  // Neither of them, not just the one inside the bin.
  expect(photos.isBinned(first!)).toBe(true);
  expect(photos.isBinned(second!)).toBe(true);
});
