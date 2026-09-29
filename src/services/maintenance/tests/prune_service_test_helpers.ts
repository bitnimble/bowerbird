import { afterEach, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { LibraryActivity } from '../../activity/library_activity';

export const LIB = 'prune-service-test';

export let db: Database;
let root: string;
export let prune: PruneService;
export let activity: LibraryActivity;

export function usingPruneService(): void {
  beforeEach(() => {
    activity = new LibraryActivity();
    root = mkdtempSync(path.join(tmpdir(), 'bb-prune-'));
    db = new Database(':memory:');
    runMigrations(db);
    db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(LIB, root, 'Trip');
    prune = new PruneService(
      new LibrariesRepository(db),
      new PhotoMetadataRepository(
        db,
        new PhotoProcessingRepository(db, new RenditionsRepository(db)),
      ),
      activity,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
  });
}

export function draft(key: string): string {
  const dataPath = dataPathForLibraryId(LIB);
  mkdirSync(path.dirname(draftLayerPath(dataPath, key, 0)), { recursive: true });
  writeFileSync(draftLayerPath(dataPath, key, 0), 'x');
  writeFileSync(draftVolumePath(dataPath, key), 'volume');
  return path.dirname(draftLayerPath(dataPath, key, 0));
}
