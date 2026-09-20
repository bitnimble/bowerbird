import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../db/driver';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../../db/migrate';
import type { FileMetadata } from '../../../processing/analysis/metadata';
import { AlbumsRepository } from '../../../albums/albums_repository';
import { LibrariesRepository } from '../../../libraries/libraries_repository';
import { PhotoMetadataRepository } from '../../../photos/metadata/photo_metadata_repository';
import { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../../photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../../processing/renditions/renditions_repository';
import { StackMembership } from '../../../stacks/stack_membership';
import { FolderRulesRepository } from '../../../shoots/folder_rules_repository';
import { ShootsRepository } from '../../../shoots/shoots_repository';
import { ScanService } from '../scan_service';
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
    mtime: '2026-01-01T00:00:00.000Z',
    fileSize: statSync(absPath).size,
  });

function makeLibrary(over: { include_subfolders?: number; bin_name?: string | null } = {}): Peer {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), 'bb-scan-'));
  roots.push(root);
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

describe('what the bin walk is allowed to import', () => {
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

  it('drops one whose folder it walked before and cannot find now', async () => {
    const peer = makeLibrary();
    put(peer, 'Trip/a.arw');
    await peer.scan.scanLibrary(LIB);
    expect(shootPaths(peer)).toEqual(['Trip']);

    rmSync(path.join(peer.root, 'Trip'), { recursive: true });
    peer.db.query('DELETE FROM photos').run();
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
