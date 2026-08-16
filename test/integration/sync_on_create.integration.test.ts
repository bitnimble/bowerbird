// A library imports itself the moment it is added (§9.8): creating one through
// LibrariesService starts a full sync through the lifecycle listener, without the
// create request waiting for the scan. Needs bun:sqlite:
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { LibrariesService } from '../../src/services/libraries/libraries_service';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import type { FileMetadata } from '../../src/services/processing/metadata';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';
import { dataPathForLibraryId } from '../../src/utils/paths';

// No LibRaw here: what is under test is that the scan runs at all, so the files
// are stubs and the header read is one too.
const stubExtract = async (): Promise<FileMetadata> => ({
  width: 100,
  height: 100,
  colorSpace: 'sRGB',
  orientation: 0,
  dateTaken: '2026-01-01T00:00:00.000Z',
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
  fileSize: 3,
});

let root: string;
let db: ReturnType<typeof createDatabase>;
let libraryId: string | null;

function buildServices(): { sync: SyncService; service: LibrariesService } {
  const photos = new PhotosRepository(db);
  const sync = new SyncService(
    photos,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    stubExtract,
  );
  const service = new LibrariesService(new LibrariesRepository(db), photos);
  service.addLifecycleListener(sync);
  return { sync, service };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-oncreate-'));
  db = createDatabase(':memory:');
  libraryId = null;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  if (libraryId != null) rmSync(dataPathForLibraryId(libraryId), { recursive: true, force: true });
});

test('creating a library imports its photographs without a second request', async () => {
  const { sync, service } = buildServices();
  writeFileSync(path.join(root, 'photo.arw'), 'raw');

  const settled = new Promise<void>((resolve) => sync.onSettled(() => resolve()));
  const library = await service.create({
    root_path: root,
    name: 'lib',
    bin_name: 'Bin',
    read_only: false,
    ordering: 'taken_desc',
    include_subfolders: true,
    mirror_shoots: false,
    rendition_source: 'render',
    auto_stack: true,
  });
  libraryId = library.id;
  await settled;

  const photo = db.query('SELECT file_path FROM photos WHERE library_id = ?').get(library.id) as { file_path: string } | null;
  expect(photo?.file_path).toBe('photo.arw');
  expect(new LibrariesRepository(db).getById(library.id)?.last_synced_at).not.toBeNull();
});

// A root that already keeps a folder of the bin name has it adopted (§12.3), and
// the import that follows is the whole point of adopting rather than refusing:
// what was inside arrives in the catalogue, in the Bin rather than the grid.
test('creating a library over a folder already at the bin name imports its photographs as binned', async () => {
  const { sync, service } = buildServices();
  mkdirSync(path.join(root, 'Bin', 'Trip'), { recursive: true });
  writeFileSync(path.join(root, 'Bin', 'Trip', 'old.arw'), 'raw');
  writeFileSync(path.join(root, 'live.arw'), 'raw');

  const settled = new Promise<void>((resolve) => sync.onSettled(() => resolve()));
  const library = await service.create({
    root_path: root,
    name: 'lib',
    bin_name: 'Bin',
    read_only: false,
    ordering: 'taken_desc',
    include_subfolders: true,
    mirror_shoots: false,
    rendition_source: 'render',
    auto_stack: true,
  });
  libraryId = library.id;
  await settled;

  const rows = db
    .query('SELECT file_path, deleted_from_path, is_deleted FROM photos WHERE library_id = ? ORDER BY file_path')
    .all(library.id) as { file_path: string; deleted_from_path: string | null; is_deleted: number }[];
  expect(rows).toEqual([
    // Where it would restore to, read off the mirrored layout rather than guessed.
    { file_path: 'Bin/Trip/old.arw', deleted_from_path: 'Trip/old.arw', is_deleted: 1 },
    { file_path: 'live.arw', deleted_from_path: null, is_deleted: 0 },
  ]);
});
