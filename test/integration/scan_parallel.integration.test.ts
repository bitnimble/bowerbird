// A scan reading its headers on worker threads has to import exactly what a scan
// reading them here does, and in the same order: the batches a first scan writes are
// defined by the order files were dealt with, not by the order the disk answered.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { photoMetadata, photoPaths, photoProcessing, photoScan } from './helpers/photo_repositories';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import type { MetadataExtractor } from '../../src/services/sync/scan/scan_file_reader';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';
import { ScanPool } from '../../src/services/sync/scan/scan_pool';
import { extractMetadata } from '../../src/services/processing/analysis/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const COPIES = 6;

// One root, read twice: the hash covers mtime, so two sets of copies would differ for
// reasons that have nothing to do with which thread read them.
let root: string;
const opened: ReturnType<typeof createDatabase>[] = [];

function catalogue(): ReturnType<typeof createDatabase> {
  const db = createDatabase(':memory:');
  opened.push(db);
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(
    'lib000fa',
    root,
    'lib',
    'taken_desc',
  );
  return db;
}

function scan(db: ReturnType<typeof createDatabase>, extract: MetadataExtractor, width: number): Promise<unknown> {
  const photoProcessingRepo = photoProcessing(db);
  return new ScanService(
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
    extract,
    undefined,
    () => width,
  ).scanLibrary('lib000fa');
}

function rows(db: ReturnType<typeof createDatabase>): { file_path: string; width: number; file_hash: string }[] {
  return db
    .query(
      `SELECT json_extract(recipe, '$.path') AS file_path, width, file_hash FROM photos
         ORDER BY json_extract(recipe, '$.path')`,
    )
    .all() as never;
}

let onThreads: ReturnType<typeof createDatabase>;
let here: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-scan-'));
  for (let i = 0; i < COPIES; i++) copyFileSync(FIXTURE, path.join(root, `p${i}.arw`));

  onThreads = catalogue();
  here = catalogue();
  await scan(onThreads, new ScanPool(() => 4).read, 4);
  await scan(here, extractMetadata, 1);
});

afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a scan on worker threads imports every file', () => {
  const imported = rows(onThreads);
  expect(imported).toHaveLength(COPIES);
  expect(imported.every((row) => row.width > 0)).toBe(true);
});

test('it reads the same headers the main thread does', () => {
  // Hashes as well as paths, since the hash is computed here from what the thread sent
  // back - a field lost in the crossing would leave the row looking fine and the hash
  // quietly different.
  expect(rows(onThreads)).toEqual(rows(here));
});

// One at a time is a supported setting, and it is the case where the queue is empty between
// every pair of files - so it is the one that will spawn a thread per photograph if the pool
// retires on an empty queue rather than on having been idle for a while.
test('one at a time reuses its thread rather than spawning one per file', async () => {
  let spawned = 0;
  const madeWorkers = globalThis.Worker;
  globalThis.Worker = class extends madeWorkers {
    constructor(...args: ConstructorParameters<typeof madeWorkers>) {
      spawned++;
      super(...args);
    }
  };
  try {
    const db = catalogue();
    await scan(db, new ScanPool(() => 1).read, 1);
    expect(rows(db)).toHaveLength(COPIES);
  } finally {
    globalThis.Worker = madeWorkers;
  }
  expect(spawned).toBe(1);
});
