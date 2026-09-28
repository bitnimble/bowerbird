import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { dataPathForLibraryId, draftLayerPath, draftVolumePath } from '../../../utils/paths';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { PruneService } from '../prune_service';

const LIB = 'prune-service-test';

let db: Database;
let root: string;
let prune: PruneService;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-prune-'));
  db = new Database(':memory:');
  runMigrations(db);
  db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(LIB, root, 'Trip');
  prune = new PruneService(
    new LibrariesRepository(db),
    new PhotoMetadataRepository(db, new PhotoProcessingRepository(db, new RenditionsRepository(db))),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
});

/**
 * §4.4's seven days.
 *
 * A sweep of its own rather than the orphan one: a draft key is the frames it was carved from, so
 * it is never a live photo id and "is this id in the library" answers nothing about one.
 */
describe('PruneService.pruneDrafts', () => {
  function draft(key: string): string {
    const dataPath = dataPathForLibraryId(LIB);
    mkdirSync(path.dirname(draftLayerPath(dataPath, key, 0)), { recursive: true });
    writeFileSync(draftLayerPath(dataPath, key, 0), 'x');
    writeFileSync(draftVolumePath(dataPath, key), 'volume');
    return path.dirname(draftLayerPath(dataPath, key, 0));
  }

  it('reaps a draft past the TTL and leaves a fresh one alone', async () => {
    const old = draft('0123456789abcdef');
    const fresh = draft('fedcba9876543210');
    // A carve that died before its volume was named leaves it loose beside the drafts.
    const loose = path.join(dataPathForLibraryId(LIB), 'drafts', '.volume-abc.bin');
    writeFileSync(loose, 'pending');
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    await utimes(loose, longAgo, longAgo);

    const result = await prune.pruneDrafts(7);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(loose)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result).toEqual({ removed: 2, bytes: 'x'.length + 'volume'.length + 'pending'.length });
  });

  it('says nothing about a library that has never carved anything', async () => {
    expect(await prune.pruneDrafts(7)).toEqual({ removed: 0, bytes: 0 });
  });

  // The ordinary sweep is about ids that are no longer photographs, and a draft key is not one -
  // so a fresh draft must survive it whatever the library holds.
  it('the orphan sweep leaves a draft alone', async () => {
    const dir = draft('0123456789abcdef');

    await prune.prune();

    expect(existsSync(dir)).toBe(true);
  });
});
