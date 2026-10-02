import { afterEach, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { dataPathForLibraryId, renditionPathFor } from '../../../utils/paths';
import { RenditionCache } from '../../blobs/rendition_cache';
import { renditionVariant, type Rendition } from '../../processing/renditions/renditions';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { DiskSpaceLimit } from '../disk_space_limit';
import { StorageUsageService } from '../storage_usage_service';

export let db: Database;
export let renditions: RenditionsRepository;
export let limit: DiskSpaceLimit;
let library: string;
let root: string;

export function usingDiskSpaceLimit(libraryId: string): void {
  beforeEach(() => {
    library = libraryId;
    root = mkdtempSync(path.join(tmpdir(), 'bb-disk-limit-'));
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, ?, 'Trip')").run(
      library,
      root,
    );
    renditions = new RenditionsRepository(db);
    limit = new DiskSpaceLimit(
      renditions,
      new RenditionCache(db),
      new StorageUsageService({
        dataDir: dataPathForLibraryId(library),
        dbPath: path.join(root, 'catalogue.db'),
      }),
    );
  });

  afterEach(() => {
    limit.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataPathForLibraryId(library), { recursive: true, force: true });
  });
}

export function photo(id: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(id, library, `${id}.arw`);
}

export function built(
  id: string,
  rendition: Rendition,
  bytes: number,
  at: string,
  hdr = false,
): string {
  const file = renditionPathFor(dataPathForLibraryId(library), id, rendition, hdr);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes));
  renditions.markBuilt(id, renditionVariant(rendition, hdr), at, `${id}-edits`, null);
  return file;
}

export function usedAt(id: string, variant: string): string | null {
  const row = db
    .query('SELECT used_at FROM renditions WHERE photo_id = ? AND variant = ?')
    .get(id, variant) as { used_at: string | null } | null;
  return row?.used_at ?? null;
}
