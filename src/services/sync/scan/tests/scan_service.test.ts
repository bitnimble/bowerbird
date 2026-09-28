import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from '../../../../db/driver';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../../db/migrate';
import type { FileMetadata } from '../../../processing/analysis/metadata';
import { AlbumsRepository } from '../../../albums/albums_repository';
import { LibrariesRepository } from '../../../libraries/libraries_repository';
import { ensureBinFolder } from '../../../libraries/bin_folder';
import { PhotoMetadataRepository } from '../../../photos/metadata/photo_metadata_repository';
import { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../../photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../../processing/renditions/renditions_repository';
import { StackMembership } from '../../../stacks/stack_membership';
import { FolderRulesRepository } from '../../../shoots/folder_rules_repository';
import { ShootsRepository } from '../../../shoots/shoots_repository';
import { ScanService } from '../scan_service';
import { ScanLeases } from '../scan_leases';
import { SyncLocksRepository } from '../../coordination/sync_locks_repository';

/**
 * What `ScanService` itself decides, over a real tree and a real catalogue.
 *
 * The guards in the diff, scope, and relocation modules are pinned there; this file
 * exercises service decisions about bin ownership, shoot removal, and unclaimed files: no
 * RAW decode (`extract` is a stub, as its own doc says it is a seam for), no GPU,
 * no worker, milliseconds a case.
 */
const LIB = 'lib00sync';

interface Peer {
  db: Database;
  root: string;
  scan: ScanService;
  photoPaths: PhotoPathsRepository;
  photoMetadata: PhotoMetadataRepository;
  photoProcessing: PhotoProcessingRepository;
  photoScan: PhotoScanRepository;
  shoots: ShootsRepository;
  rules: FolderRulesRepository;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A stub, so a scan test is not also a test about reading a RAW header - which is
 * exactly what the `extract` seam's own doc says it is there for.
 *
 * The dimensions are the only fields the scan itself reads; the rest is carried
 * through to the row untouched.
 */
const meta = (absPath: string): Promise<FileMetadata> =>
  Promise.resolve({
    width: 100,
    height: 100,
    colorSpace: 'sRGB',
    orientation: 1,
    dateTaken: null,
    dateTakenOffset: null,
    latitude: null,
    longitude: null,
    iso: null,
    shutterSpeed: null,
    aperture: null,
    focalLength: null,
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    sequence: null,
    mtime: '2026-01-01T00:00:00.000Z',
    fileSize: statSync(absPath).size,
  });

function makeLibrary(over: {
  include_subfolders?: number;
  bin_name?: string | null;
  pendingMoves?: ConstructorParameters<typeof ScanService>[14];
} = {}): Peer {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-scan-'));
  roots.push(dir);
  const root = path.join(dir, 'library');
  mkdirSync(root);
  db.query(
    `INSERT INTO libraries (id, root_path, name, ordering, bin_name, include_subfolders)
       VALUES (?, ?, 'Trip', 'taken_desc', ?, ?)`,
  ).run(LIB, root, over.bin_name === undefined ? 'Bin' : over.bin_name, over.include_subfolders ?? 1);

  const photoProcessing = new PhotoProcessingRepository(db, new RenditionsRepository(db));
  const photoPaths = new PhotoPathsRepository(db, new StackMembership(db));
  const photoMetadata = new PhotoMetadataRepository(db, photoProcessing);
  const photoScan = new PhotoScanRepository(db, photoProcessing);
  const shoots = new ShootsRepository(db);
  const rules = new FolderRulesRepository(db);
  const scan = new ScanService(
    photoScan,
    photoPaths,
    photoMetadata,
    photoProcessing,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    shoots,
    rules,
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    meta,
    undefined,
    undefined,
    undefined,
    over.pendingMoves,
  );
  return { db, root, scan, photoPaths, photoMetadata, photoProcessing, photoScan, shoots, rules };
}

function put(peer: Peer, rel: string, bytes = 'RAW'): void {
  mkdirSync(path.dirname(path.join(peer.root, rel)), { recursive: true });
  writeFileSync(path.join(peer.root, rel), bytes);
}

const livePaths = (peer: Peer): string[] =>
  (peer.db.query(`SELECT json_extract(recipe, '$.path') AS file_path FROM photos WHERE is_deleted = 0 ORDER BY file_path`).all() as {
    file_path: string;
  }[]).map((row) => row.file_path);

const binnedPaths = (peer: Peer): string[] =>
  (peer.db.query(`SELECT json_extract(recipe, '$.path') AS file_path FROM photos WHERE is_deleted = 1 ORDER BY file_path`).all() as {
    file_path: string;
  }[]).map((row) => row.file_path);

describe('a missing library root', () => {
  it('lets concurrent bin repairs share the directory they create', async () => {
    const peer = makeLibrary();
    const libraries = new LibrariesRepository(peer.db);
    const library = libraries.getById(LIB);
    if (library == null) throw new Error('library was not created');

    const repaired = await Promise.all([ensureBinFolder(library, libraries), ensureBinFolder(library, libraries)]);

    expect(repaired).toEqual([path.join(peer.root, 'Bin'), path.join(peer.root, 'Bin')]);
    expect(statSync(path.join(peer.root, 'Bin')).isDirectory()).toBe(true);
  });

  it('refuses to recreate the library root when repairing its bin', async () => {
    const peer = makeLibrary();
    const libraries = new LibrariesRepository(peer.db);
    const library = libraries.getById(LIB);
    if (library == null) throw new Error('library was not created');
    rmSync(peer.root, { recursive: true });

    await expect(ensureBinFolder(library, libraries)).rejects.toMatchObject({ code: 'IO_ERROR' });

    expect(existsSync(peer.root)).toBe(false);
  });

  it('keeps every shoot when the root disappears during the walk and returns', async () => {
    let restore = (): void => {};
    const peer = makeLibrary({ pendingMoves: () => { restore(); return []; } });
    put(peer, 'A/a.arw', 'A');
    put(peer, 'B/b.arw', 'B');
    await peer.scan.scanLibrary(LIB);
    for (const original of peer.photoScan.listForScan(LIB)) {
      peer.photoPaths.markDeleted(original.id, original.file_path);
    }
    const before = peer.shoots.listIdentities(LIB);
    expect(before).toHaveLength(2);
    const renamed = `${peer.root}-renamed`;
    roots.push(renamed);
    restore = () => {
      renameSync(renamed, peer.root);
      restore = () => {};
    };
    const keeper = ScanLeases.prototype.keeper;
    const duringWalk = spyOn(ScanLeases.prototype, 'keeper').mockImplementation(function(this: ScanLeases, libraryId, owner) {
      const keepLease = keeper.call(this, libraryId, owner);
      let entered = 0;
      return () => {
        keepLease();
        if (++entered === 2) renameSync(peer.root, renamed);
      };
    });
    try {
      await peer.scan.scanLibrary(LIB);
    } finally {
      duringWalk.mockRestore();
      if (existsSync(renamed) && !existsSync(peer.root)) renameSync(renamed, peer.root);
    }

    expect(existsSync(peer.root)).toBe(true);
    expect(peer.shoots.listIdentities(LIB)).toEqual(before);
  });

  it('keeps shoots when the root returns after the live walk', async () => {
    let restore = (): void => {};
    const peer = makeLibrary({ pendingMoves: () => { restore(); return []; } });
    put(peer, 'Trip/a.arw');
    await peer.scan.scanLibrary(LIB);
    const original = peer.photoScan.listForScan(LIB)[0];
    if (original == null) throw new Error('scan did not import the original');
    peer.photoPaths.markDeleted(original.id, original.file_path);
    const before = peer.shoots.listIdentities(LIB);
    expect(before).toHaveLength(1);
    const renamed = `${peer.root}-renamed`;
    roots.push(renamed);
    renameSync(peer.root, renamed);
    restore = () => {
      renameSync(renamed, peer.root);
      restore = () => {};
    };

    await peer.scan.scanLibrary(LIB);

    expect(existsSync(peer.root)).toBe(true);
    expect(peer.shoots.listIdentities(LIB)).toEqual(before);
    await peer.scan.scanLibrary(LIB);
    expect(peer.shoots.listIdentities(LIB)).toEqual(before);
    expect(peer.photoScan.listBinnedForScan(LIB)[0]?.id).toBe(original.id);
    expect(peer.photoScan.listBinnedForScan(LIB)[0]?.is_missing).toBe(false);
  });

  it('marks live and binned originals missing after a rename, then recognises their return', async () => {
    const peer = makeLibrary();
    put(peer, 'top.arw', 'top');
    put(peer, 'Trip/live.arw', 'live');
    put(peer, 'Binned/in-place.arw', 'in-place');
    put(peer, 'Bin/Trip/binned.arw', 'binned');
    await peer.scan.scanLibrary(LIB);
    const inPlace = peer.photoScan.listForScan(LIB).find((photo) => photo.file_path === 'Binned/in-place.arw');
    if (inPlace == null) throw new Error('scan did not import the in-place original');
    peer.photoPaths.markDeleted(inPlace.id, inPlace.file_path);
    mkdirSync(path.join(peer.root, 'Empty'));
    const emptyFolder = statSync(path.join(peer.root, 'Empty'));
    peer.db.query(
      "INSERT INTO shoots (id, library_id, name, folder_path, folder_dev, folder_ino, folder_birthtime) VALUES ('empty001', ?, 'Empty', 'Empty', ?, ?, ?)",
    ).run(LIB, emptyFolder.dev, emptyFolder.ino, emptyFolder.birthtimeMs);
    const before = peer.db.query('SELECT id, recipe, shoot_id, is_deleted, deleted_from_path FROM photos ORDER BY id').all();
    const shootsBefore = peer.shoots.listIdentities(LIB);
    const renamed = `${peer.root}-renamed`;
    roots.push(renamed);
    renameSync(peer.root, renamed);

    const missing = await peer.scan.scanLibrary(LIB);

    expect(missing.photos_removed).toBe(2);
    expect(missing.photos_modified).toBe(2);
    expect(peer.db.query('SELECT is_missing FROM photos ORDER BY id').all()).toEqual([
      { is_missing: 1 }, { is_missing: 1 }, { is_missing: 1 }, { is_missing: 1 },
    ]);
    expect(peer.db.query('SELECT id, recipe, shoot_id, is_deleted, deleted_from_path FROM photos ORDER BY id').all()).toEqual(before);
    expect(existsSync(peer.root)).toBe(false);
    expect(peer.shoots.listIdentities(LIB)).toEqual(shootsBefore);

    const repeated = await peer.scan.scanLibrary(LIB);
    expect(repeated.photos_removed).toBe(0);
    expect(repeated.photos_modified).toBe(0);
    expect(existsSync(peer.root)).toBe(false);

    renameSync(renamed, peer.root);
    const restored = await peer.scan.scanLibrary(LIB);
    expect(restored.photos_added).toBe(0);
    expect(peer.db.query('SELECT is_missing FROM photos ORDER BY id').all()).toEqual([
      { is_missing: 0 }, { is_missing: 0 }, { is_missing: 0 }, { is_missing: 0 },
    ]);
    expect(peer.db.query('SELECT id, recipe, shoot_id, is_deleted, deleted_from_path FROM photos ORDER BY id').all()).toEqual(before);
    expect(peer.shoots.listIdentities(LIB)).toEqual(shootsBefore);
  });

  it('marks originals missing when the root has become a file', async () => {
    const peer = makeLibrary();
    put(peer, 'top.arw');
    await peer.scan.scanLibrary(LIB);
    rmSync(peer.root, { recursive: true });
    writeFileSync(peer.root, 'not a directory');

    const missing = await peer.scan.scanLibrary(LIB);

    expect(missing.photos_removed).toBe(1);
    expect(peer.db.query('SELECT is_missing FROM photos').all()).toEqual([{ is_missing: 1 }]);
    expect(statSync(peer.root).isFile()).toBe(true);
  });

  it('leaves originals unchanged when the root cannot be read', async () => {
    const peer = makeLibrary();
    put(peer, 'top.arw');
    await peer.scan.scanLibrary(LIB);
    rmSync(peer.root, { recursive: true });
    symlinkSync(peer.root, peer.root);

    await expect(peer.scan.scanLibrary(LIB)).rejects.toThrow('ELOOP');

    expect(peer.db.query('SELECT is_missing FROM photos').all()).toEqual([{ is_missing: 0 }]);
    expect(peer.scan.getScanStatus(LIB).status).toBe('idle');
  });

  it('marks originals missing when an ancestor of the root has become a file', async () => {
    const peer = makeLibrary();
    put(peer, 'top.arw', 'top');
    put(peer, 'Bin/binned.arw', 'binned');
    await peer.scan.scanLibrary(LIB);
    const ancestor = path.dirname(peer.root);
    rmSync(ancestor, { recursive: true });
    writeFileSync(ancestor, 'not a directory');

    const missing = await peer.scan.scanLibrary(LIB);

    expect(missing.photos_removed).toBe(1);
    expect(missing.photos_modified).toBe(1);
    expect(peer.db.query('SELECT is_missing FROM photos ORDER BY id').all()).toEqual([
      { is_missing: 1 }, { is_missing: 1 },
    ]);
    expect(statSync(ancestor).isFile()).toBe(true);
  });
});

describe('what the bin walk is allowed to import', () => {
  it('keeps an in-place binned original as one row when it returns', async () => {
    const peer = makeLibrary();
    put(peer, 'Trip/a.arw');
    await peer.scan.scanLibrary(LIB);
    const original = peer.photoScan.listForScan(LIB)[0];
    if (original == null) throw new Error('scan did not import the original');
    peer.photoPaths.markDeleted(original.id, original.file_path);
    rmSync(path.join(peer.root, original.file_path));
    await peer.scan.scanLibrary(LIB);
    expect(peer.photoScan.listBinnedForScan(LIB)[0]?.is_missing).toBe(true);

    put(peer, original.file_path);
    const returned = await peer.scan.scanLibrary(LIB);

    expect(returned.photos_added).toBe(0);
    expect(livePaths(peer)).toEqual([]);
    expect(binnedPaths(peer)).toEqual([original.file_path]);
    expect(peer.photoScan.listBinnedForScan(LIB)[0]?.id).toBe(original.id);
    expect(peer.photoScan.listBinnedForScan(LIB)[0]?.is_missing).toBe(false);
  });

  /**
   * The bin is walked with no exclusions at all, deliberately - an excluded
   * folder's binned frames are still binned, and their rows still have to be
   * matched against their files. But an *unclaimed* file whose restore path the
   * library no longer covers is a frame from a folder somebody removed, and
   * importing it brings that folder back as new photographs under new ids.
   */
  it('leaves an unclaimed bin file alone when its restore path is out of scope', async () => {
    const peer = makeLibrary();
    put(peer, 'Trip/live.arw');
    put(peer, 'Bin/Trip/old.arw');
    peer.rules.set(LIB, 'Trip', 'excluded');

    await peer.scan.scanLibrary(LIB);

    expect(binnedPaths(peer)).toEqual([]);
    expect(livePaths(peer)).toEqual([]);
    expect(existsSync(path.join(peer.root, 'Bin/Trip/old.arw'))).toBe(true);
  });

  it('imports one whose restore path the library still covers', async () => {
    const peer = makeLibrary();
    put(peer, 'Bin/Trip/old.arw');

    await peer.scan.scanLibrary(LIB);

    expect(binnedPaths(peer)).toEqual(['Bin/Trip/old.arw']);
    const row = peer.db.query('SELECT deleted_from_path FROM photos').get() as { deleted_from_path: string };
    expect(row.deleted_from_path).toBe('Trip/old.arw');
  });
});

describe('which shoots a full scan removes', () => {
  const shootPaths = (peer: Peer): string[] => peer.shoots.listByLibrary(LIB).map((s) => s.folder_path).sort();

  it.each(['.cache', 'Excluded'])('drops a removed shoot beside a dangling out-of-scope link named %s', async (link) => {
    const peer = makeLibrary();
    put(peer, 'Trip/a.arw');
    await peer.scan.scanLibrary(LIB);
    expect(shootPaths(peer)).toEqual(['Trip']);

    rmSync(path.join(peer.root, 'Trip'), { recursive: true });
    peer.db.query('DELETE FROM photos').run();
    peer.rules.set(LIB, 'Excluded', 'excluded');
    symlinkSync(path.join(peer.root, 'Absent'), path.join(peer.root, link));
    await peer.scan.scanLibrary(LIB);

    expect(shootPaths(peer)).toEqual([]);
  });

  /**
   * An `excluded` rule is settable on any folder from the settings page. The walk
   * skips it, so it is absent from the scan exactly as a deleted folder is - and
   * deleting the shoot replicates and cannot be undone, while the same absence
   * makes its photographs merely `is_missing`.
   */
  it('keeps one the walk was told to skip', async () => {
    const peer = makeLibrary();
    put(peer, 'Trip/a.arw');
    await peer.scan.scanLibrary(LIB);
    peer.db.query('DELETE FROM photos').run();
    peer.rules.set(LIB, 'Trip', 'excluded');

    await peer.scan.scanLibrary(LIB);

    expect(shootPaths(peer)).toEqual(['Trip']);
  });

  it('keeps one whose folder this device has never walked', async () => {
    const peer = makeLibrary();
    peer.db
      .query("INSERT INTO shoots (id, library_id, name, folder_path) VALUES ('sh1', ?, 'Iceland', 'Iceland')")
      .run(LIB);

    await peer.scan.scanLibrary(LIB);

    expect(shootPaths(peer)).toEqual(['Iceland']);
  });
});

describe('a photograph whose row and file disagree on purpose', () => {
  /**
   * The scan must read neither half. Held out, the row says one path and the file
   * is at another, which taken as evidence is the photographer moving it - stamped
   * here and replicated, undoing on every peer a move this device merely has not
   * made yet.
   */
  it('is neither moved nor marked missing while the move is still owed', async () => {
    const peer = makeLibrary();
    put(peer, 'Day1/a.arw');
    await peer.scan.scanLibrary(LIB);
    const id = (peer.db.query('SELECT id FROM photos').get() as { id: string }).id;

    // What a merge leaves: the row moved on, the file has not.
    peer.photoPaths.setFilePath(id, 'Day2/a.arw');
    const stalled = new ScanService(
      peer.photoScan,
      peer.photoPaths,
      peer.photoMetadata,
      peer.photoProcessing,
      new LibrariesRepository(peer.db),
      new AlbumsRepository(peer.db),
      peer.shoots,
      peer.rules,
      new SyncLocksRepository(peer.db),
      { processUnprocessed() {} },
      meta,
      undefined,
      undefined,
      undefined,
      () => [{ photoId: id, wasAt: 'Day1/a.arw' }],
    );

    await stalled.scanLibrary(LIB);

    expect(livePaths(peer)).toEqual(['Day2/a.arw']);
    const row = peer.db.query('SELECT is_missing FROM photos WHERE id = ?').get(id) as { is_missing: number };
    expect(row.is_missing).toBe(0);
  });
});
