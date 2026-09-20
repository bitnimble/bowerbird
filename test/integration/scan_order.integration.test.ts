// A scan opens its files in inode order, not the order the directory listed them: on a
// hard disk that is the difference between a seek per photograph and a seek per shoot.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import type { FileMetadata } from '../../src/services/processing/analysis/metadata';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { photoMetadata, photoPaths, photoProcessing, photoScan } from './helpers/photo_repositories';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';

const LIB = 'lib000d0';
const NAMES = ['m.arw', 'c.arw', 'z.arw', 'a.arw', 'q.arw', 'f.arw', 'x.arw', 'j.arw'];

let root: string;
let db: ReturnType<typeof createDatabase>;

function blank(size: number): FileMetadata {
  return {
    width: 100,
    height: 100,
    colorSpace: 'sRGB',
    orientation: 0,
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
    mtime: new Date().toISOString(),
    fileSize: size,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-order-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  for (const name of NAMES) writeFileSync(path.join(root, name), name);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('the files are opened in inode order', async () => {
  const opened: string[] = [];
  const photoProcessingRepo = photoProcessing(db);
  await new ScanService(
    photoScan(db, photoProcessingRepo),
    photoPaths(db),
    photoMetadata(db, photoProcessingRepo),
    photoProcessingRepo,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    (absPath) => {
      opened.push(path.basename(absPath));
      return Promise.resolve(blank(5));
    },
    // One at a time, so what is recorded is an order rather than a race.
    undefined,
    () => 1,
  ).scanLibrary(LIB);

  const byInode = [...NAMES].sort((a, b) => statSync(path.join(root, a)).ino - statSync(path.join(root, b)).ino);
  expect(opened).toEqual(byInode);
});
