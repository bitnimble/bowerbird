// Mirroring folders into shoots, the folder rules that overrule it, and the
// inode-based relocation that survives a rename. Needs LibRaw, so it runs under
// Bun inside the container, NOT host jest:
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { photoMetadata, photoPaths, photoProcessing, photoScan, photoState } from './helpers/photo_repositories';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ShootsService } from '../../src/services/shoots/shoots_service';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = 'lib000a1';

let root: string;
let db: ReturnType<typeof createDatabase>;
let scan: ScanService;
let rules: FolderRulesRepository;
let shoots: ShootsRepository;

const abs = (rel: string) => path.join(root, rel);
const shootPaths = () => shoots.listByLibrary(LIB).map((s) => s.folder_path).sort();
const shootOf = (filePath: string) =>
  (db.query(`SELECT shoot_id FROM photos WHERE json_extract(recipe, '$.path') = ?`).get(filePath) as { shoot_id: string | null } | null)
    ?.shoot_id ?? null;
const photoCount = () => (db.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n;

function put(rel: string): void {
  mkdirSync(path.dirname(abs(rel)), { recursive: true });
  copyFileSync(FIXTURE, abs(rel));
}

function shootsService(folderRules: FolderRulesRepository): ShootsService {
  return new ShootsService(shoots, photoPaths(db), photoState(db), new LibrariesRepository(db), folderRules);
}

function makeLibrary(over: { include_subfolders?: number } = {}): void {
  db.query('INSERT INTO libraries (id, root_path, name, ordering, include_subfolders) VALUES (?, ?, ?, ?, ?)').run(
    LIB,
    root,
    'lib',
    'taken_desc',
    over.include_subfolders ?? 1,
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-mirror-'));
  db = createDatabase(':memory:');
  rules = new FolderRulesRepository(db);
  shoots = new ShootsRepository(db);
  const processing = photoProcessing(db);
  scan = new ScanService(
    photoScan(db, processing),
    photoPaths(db),
    photoMetadata(db, processing),
    processing,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    shoots,
    rules,
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A shoot's claim covers its whole subtree, so a parent's is a superset of its
// child's rather than a duplicate: the photographs sitting directly in the parent
// are the ones only the parent's claim reaches, and nothing later repairs them.
test('a parent folder keeps its own photos when a child folder is a shoot too', async () => {
  makeLibrary();
  put('Trip/top.arw');
  put('Trip/Day1/a.arw');
  put('Trip/Day1/Selects/b.arw');

  await scan.scanLibrary(LIB);

  const byPath = new Map(shoots.listByLibrary(LIB).map((s) => [s.folder_path, s]));
  expect([...byPath.keys()].sort()).toEqual(['Trip', 'Trip/Day1', 'Trip/Day1/Selects']);
  expect(shootOf('Trip/top.arw')).toBe(byPath.get('Trip')!.id);
  expect(shootOf('Trip/Day1/a.arw')).toBe(byPath.get('Trip/Day1')!.id);
  expect(shootOf('Trip/Day1/Selects/b.arw')).toBe(byPath.get('Trip/Day1/Selects')!.id);
  // The counts the Shoots page and the delete dialog are read from.
  expect(byPath.get('Trip')!.photo_count).toBe(1);
  expect(byPath.get('Trip/Day1')!.photo_count).toBe(1);
});

test('a folder holding photos becomes a shoot, and the photos belong to it', async () => {
  makeLibrary();
  put('root.arw');
  put('Weddings/Smith/a.arw');

  await scan.scanLibrary(LIB);

  // Weddings holds no photographs of its own: it is structure, and the tree on
  // screen is drawn from the shoots' own paths.
  expect(shootPaths()).toEqual(['Weddings/Smith']);
  expect(shootOf('Weddings/Smith/a.arw')).not.toBeNull();
  expect(shootOf('root.arw')).toBeNull();
});

// The constraint that made shoot names unique library-wide would have refused this.
test('mirrors two folders of the same name under different parents', async () => {
  makeLibrary();
  put('NYC/Day1/a.arw');
  put('LA/Day1/b.arw');

  await scan.scanLibrary(LIB);

  expect(shootPaths()).toEqual(['LA/Day1', 'NYC/Day1']);
  expect(shoots.listByLibrary(LIB).map((s) => s.name)).toEqual(['Day1', 'Day1']);
});

test('a deeper folder appearing later takes its own photos from the shallower shoot', async () => {
  makeLibrary();
  put('Trip/a.arw');
  await scan.scanLibrary(LIB);
  const trip = shoots.listByLibrary(LIB)[0]!;
  expect(shootOf('Trip/a.arw')).toBe(trip.id);

  put('Trip/Selects/b.arw');
  await scan.scanLibrary(LIB);

  expect(shootPaths()).toEqual(['Trip', 'Trip/Selects']);
  expect(shootOf('Trip/a.arw')).toBe(trip.id);
  expect(shootOf('Trip/Selects/b.arw')).not.toBe(trip.id);
});

// What "delete the shoot, keep the photos" writes, and the reason it has to.
test('a plain folder keeps its photos and never becomes a shoot again', async () => {
  makeLibrary();
  put('Snapshots/a.arw');
  rules.set(LIB, 'Snapshots', 'plain');

  await scan.scanLibrary(LIB);

  expect(shootPaths()).toEqual([]);
  expect(photoCount()).toBe(1);
});

test('an excluded folder is not scanned at all', async () => {
  makeLibrary();
  put('keep.arw');
  put('Rejects/2019/old.arw');
  rules.set(LIB, 'Rejects', 'excluded');

  await scan.scanLibrary(LIB);

  expect(photoCount()).toBe(1);
  expect(shootPaths()).toEqual([]);
});

test('a root-only library imports neither the subfolder photos nor their shoots', async () => {
  makeLibrary({ include_subfolders: 0 });
  put('top.arw');
  put('Trip/deep.arw');

  await scan.scanLibrary(LIB);

  expect(photoCount()).toBe(1);
  expect(shootPaths()).toEqual([]);
});

// parent_id cascades, so deleting a shoot would take its descendants with it -
// and mirroring would then rebuild those folders as brand-new shoots with default
// names, which is exactly what the dialog promises will not happen.
test('deleting a shoot and keeping its photos leaves the shoots beneath it alone', async () => {
  makeLibrary();
  put('Trip/Day1/a.arw');
  await scan.scanLibrary(LIB);
  const service = shootsService(rules);
  await service.create({ library_id: LIB, parent_path: '', name: 'Trip', ordering: 'taken_desc' });
  const day1 = shoots.listByLibrary(LIB).find((s) => s.folder_path === 'Trip/Day1')!;
  shoots.updateFields(day1.id, { name: 'Day One, Reykjavik', description: 'the good one' });
  const trip = shoots.listByLibrary(LIB).find((s) => s.folder_path === 'Trip')!;

  await service.delete(trip.id, 'keep');

  const after = shoots.listByLibrary(LIB);
  expect(after.map((s) => s.folder_path)).toEqual(['Trip/Day1']);
  expect(after[0]!.id).toBe(day1.id); // the same shoot, not a rebuilt one
  expect(after[0]!.name).toBe('Day One, Reykjavik');
  expect(after[0]!.description).toBe('the good one');
  expect(shootOf('Trip/Day1/a.arw')).toBe(day1.id);

  // And the next scan leaves it alone rather than mirroring a duplicate beside it.
  await scan.scanLibrary(LIB);
  expect(shoots.listByLibrary(LIB).map((s) => s.folder_path)).toEqual(['Trip/Day1']);
});

// `_` is a LIKE wildcard, and folder_path is the user's own folder names.
test('a folder with an underscore does not adopt an unrelated shoot', async () => {
  makeLibrary();
  mkdirSync(abs('Old'));
  mkdirSync(abs('2024xJapan/Day1'), { recursive: true });
  const service = shootsService(rules);
  const old = await service.create({ library_id: LIB, parent_path: '', name: 'Old', ordering: 'taken_desc' });
  const unrelated = await service.create({ library_id: LIB, parent_path: '2024xJapan', name: 'Day1', ordering: 'taken_desc' });

  renameSync(abs('Old'), abs('2024_Japan'));
  await scan.scanLibrary(LIB); // relocates Old -> 2024_Japan and re-derives parents

  await service.delete(old.id, 'keep');

  // Not swept up by the cascade: '2024xJapan/Day1' is not under '2024_Japan/'.
  expect(shoots.getById(unrelated.id)?.folder_path).toBe('2024xJapan/Day1');
});

// parent_id cascades, so discarding a folder that still holds a shoot would take
// that shoot's label, its banner and its photos' membership with it - and those
// photos are only "missing" in the sense that the whole subtree moved.
test('never drops a shoot that still holds a shoot, however empty it is itself', async () => {
  makeLibrary();
  put('Trip/Day1/a.arw');
  await scan.scanLibrary(LIB);
  const day1 = shoots.listByLibrary(LIB).find((s) => s.folder_path === 'Trip/Day1')!;
  shoots.updateFields(day1.id, { name: 'Day One, Reykjavik' });
  // Trip holds no photographs of its own, so it is a pass-through folder with a
  // shoot only because the user made one.
  await shootsService(rules).create({ library_id: LIB, parent_path: '', name: 'Trip', ordering: 'taken_desc' });

  renameSync(abs('Trip'), abs('Elsewhere'));
  rmSync(abs('Elsewhere'), { recursive: true });
  await scan.scanLibrary(LIB);

  const after = shoots.listByLibrary(LIB);
  expect(after.map((s) => s.name).sort()).toEqual(['Day One, Reykjavik', 'Trip']);
  expect(shootOf('Trip/Day1/a.arw')).toBe(day1.id);
});

// Rename a folder and its child in one window: applying the parent first moves
// the child's photos to a path the child's own rewrite then fails to match,
// leaving rows pointing at a file that is not there while is_missing reads 0.
test('follows a folder and its child renamed in the same scan', async () => {
  makeLibrary();
  put('X/top.arw');
  put('X/W/a.arw');
  await scan.scanLibrary(LIB);
  expect(shootPaths()).toEqual(['X', 'X/W']);

  renameSync(abs('X/W'), abs('X/V'));
  renameSync(abs('X'), abs('Y'));
  await scan.scanLibrary(LIB);

  expect(shootPaths()).toEqual(['Y', 'Y/V']);
  expect(shootOf('Y/V/a.arw')).not.toBeNull();
  const orphans = db
    .query(
      `SELECT json_extract(recipe, '$.path') AS file_path FROM photos
         WHERE is_missing = 0 AND json_extract(recipe, '$.path') NOT IN ('Y/top.arw', 'Y/V/a.arw')`,
    )
    .all() as { file_path: string }[];
  expect(orphans).toEqual([]);
});

test('drops a mirrored shoot whose folder is gone and which holds nothing', async () => {
  makeLibrary();
  put('Trip/a.arw');
  await scan.scanLibrary(LIB);
  expect(shootPaths()).toEqual(['Trip']);

  rmSync(abs('Trip'), { recursive: true });
  await scan.scanLibrary(LIB);

  // The photo went missing rather than moving, so the shoot still has rows and
  // stays: a library whose files vanished is not a shoot to discard.
  expect(shootPaths()).toEqual(['Trip']);

  db.query('DELETE FROM photos').run();
  await scan.scanLibrary(LIB);
  expect(shootPaths()).toEqual([]);
});

/**
 * A shoot that arrived by replication and whose folder this device has never made.
 *
 * The scan's mirroring reads a missing folder as the photographer removing it, and
 * a shoot's deletion is replicated and *final* - so a clone scanning before its
 * originals have landed would tombstone the shoot back to the device it came from,
 * taking the name, description, ordering and banner everywhere, unrecoverably. Its
 * photographs are the only thing that would make the folder here, so a shoot
 * holding none is exposed to this on every scan and not just the first.
 */
test('leaves a replicated shoot alone when its folder was never here to remove', async () => {
  makeLibrary();
  db.query('INSERT INTO shoots (id, library_id, name, folder_path) VALUES (?, ?, ?, ?)').run(
    'sh_remote',
    LIB,
    'Iceland',
    'Iceland',
  );

  await scan.scanLibrary(LIB);

  expect(shootPaths()).toEqual(['Iceland']);
});

test('follows a renamed folder by its inode, keeping the shoot and its photos', async () => {
  makeLibrary();
  put('Trip/a.arw');
  await scan.scanLibrary(LIB);
  const before = shoots.listByLibrary(LIB)[0]!;

  renameSync(abs('Trip'), abs('Trip-2024'));
  await scan.scanLibrary(LIB);

  const after = shoots.listByLibrary(LIB);
  expect(after).toHaveLength(1);
  expect(after[0]!.id).toBe(before.id); // the same shoot, not a new one beside it
  expect(after[0]!.folder_path).toBe('Trip-2024');
  expect(shootOf('Trip-2024/a.arw')).toBe(before.id);
});

// The case photo evidence structurally cannot see: nothing moved, so a rename
// leaves no other trace.
test('follows a renamed folder that holds no photos', async () => {
  makeLibrary();
  mkdirSync(abs('Planned'));
  const shootsService = new ShootsService(shoots, photoPaths(db), photoState(db), new LibrariesRepository(db), rules);
  const { id } = await shootsService.create({ library_id: LIB, parent_path: '', name: 'Planned', ordering: 'taken_desc' });

  renameSync(abs('Planned'), abs('Booked'));
  await scan.scanLibrary(LIB);

  expect(shoots.getById(id)?.folder_path).toBe('Booked');
});

test('keeps the label a renamed shoot was given', async () => {
  makeLibrary();
  put('Trip/a.arw');
  await scan.scanLibrary(LIB);
  const shoot = shoots.listByLibrary(LIB)[0]!;
  shoots.updateFields(shoot.id, { name: 'Iceland, March' });

  renameSync(abs('Trip'), abs('Trip-Iceland'));
  await scan.scanLibrary(LIB);

  const after = shoots.listByLibrary(LIB);
  expect(after).toHaveLength(1); // matched by folder_path, never by name
  expect(after[0]!.name).toBe('Iceland, March');
  expect(after[0]!.folder_path).toBe('Trip-Iceland');
});
