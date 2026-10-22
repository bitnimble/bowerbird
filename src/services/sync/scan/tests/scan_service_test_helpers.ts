import { Database } from '../../../../db/driver';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../../db/migrate';
import type { MediaListing } from '../../../libraries/media_listing';
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

export const LIB = 'lib00sync';

export interface Peer {
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

export const roots: string[] = [];

export function makeLibrary(
  over: {
    include_subfolders?: number;
    bin_name?: string | null;
    include_non_raw?: number;
    pendingMoves?: ConstructorParameters<typeof ScanService>[13];
    media?: MediaListing;
  } = {},
): Peer {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-scan-'));
  roots.push(dir);
  const root = path.join(dir, 'library');
  mkdirSync(root);
  db.query(
    `INSERT INTO libraries (id, root_path, name, ordering, bin_name, include_subfolders, include_non_raw)
       VALUES (?, ?, 'Trip', 'taken_desc', ?, ?, ?)`,
  ).run(
    LIB,
    root,
    over.bin_name === undefined ? 'Bin' : over.bin_name,
    over.include_subfolders ?? 1,
    over.include_non_raw ?? 0,
  );

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
    undefined,
    undefined,
    undefined,
    over.pendingMoves,
    over.media ?? null,
  );
  return { db, root, scan, photoPaths, photoMetadata, photoProcessing, photoScan, shoots, rules };
}

export function put(peer: Peer, rel: string, bytes = 'RAW'): void {
  mkdirSync(path.dirname(path.join(peer.root, rel)), { recursive: true });
  writeFileSync(path.join(peer.root, rel), bytes);
}
