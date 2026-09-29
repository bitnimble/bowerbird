import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../db/migrate';
import type { Library } from '../../../schemas/libraries';
import { dataPathForLibraryId, getRenditionPath } from '../../../utils/paths';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { renditionVariant, type Rendition } from '../../processing/renditions/renditions';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { RenditionCache } from '../rendition_cache';

// The cap on renditions a device fetched rather than built (§7.9): it cannot
// rebuild one, so nothing but browsing decides how many there are.

let libraryIds = 0;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function library(db: Database): Library {
  const id = `library-cache-${++libraryIds}`;
  const root = mkdtempSync(path.join(tmpdir(), 'bb-cache-'));
  dirs.push(root, dataPathForLibraryId(id));
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, ?, 'Trip')").run(id, root);
  const found = new LibrariesRepository(db).getById(id);
  if (found == null) throw new Error('library not found');
  return found;
}

function catalogue(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** A fetched rendition of `bytes` bytes, on disk where the cache will look for it. */
function fetched(
  db: Database,
  lib: Library,
  photoId: string,
  rendition: Rendition,
  bytes: number,
): string {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(photoId, lib.id, `${photoId}.arw`);
  const file = getRenditionPath(lib, photoId, rendition, false);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'x'.repeat(bytes));
  new RenditionsRepository(db).markBuilt(
    photoId,
    renditionVariant(rendition, false),
    '2026-01-01T00:00:00.000Z',
    null,
    null,
  );
  return file;
}

describe('the fetched-rendition cache', () => {
  it('gives back the least recently used once the library is over its cap', async () => {
    const db = catalogue();
    const lib = library(db);
    // A clock the test drives: real opens are seconds apart, and these are not.
    let tick = 0;
    // Room for three of these, so the fourth is what forces a choice.
    const cache = new RenditionCache(db, 350, () =>
      new Date(1_700_000_000_000 + ++tick * 1000).toISOString(),
    );
    const files = new Map<string, string>();
    for (const id of ['p1', 'p2', 'p3']) {
      files.set(id, fetched(db, lib, id, 'grid', 100));
      await cache.keep(lib, id, 'grid', false, files.get(id)!);
    }
    expect(cache.bytesHeld(lib.id)).toBe(300);
    // p1 is wanted again, which makes p2 the oldest.
    cache.touch(lib.id, 'p1', 'grid', false);

    const p4 = fetched(db, lib, 'p4', 'grid', 100);
    await cache.keep(lib, 'p4', 'grid', false, p4);

    expect(existsSync(files.get('p2')!)).toBe(false);
    expect(existsSync(files.get('p1')!)).toBe(true);
    expect(existsSync(files.get('p3')!)).toBe(true);
    expect(existsSync(p4)).toBe(true);
    expect(cache.bytesHeld(lib.id)).toBe(300);
    expect(new LibrariesRepository(db).getById(lib.id)?.rendered_photo_count).toBe(0);
    expect(new RenditionsRepository(db).stamps('p2', 'grid')).toEqual({
      built_at: null,
      built_from: null,
    });
  });

  it('counts nothing for a library still under its cap', async () => {
    const db = catalogue();
    const lib = library(db);
    const cache = new RenditionCache(db, 10_000);
    const file = fetched(db, lib, 'p1', 'grid', 100);

    await cache.keep(lib, 'p1', 'grid', false, file);

    expect(existsSync(file)).toBe(true);
    expect(cache.bytesHeld(lib.id)).toBe(100);
  });

  it('stops counting a file somebody else swept, rather than evicting for it forever', async () => {
    const db = catalogue();
    const lib = library(db);
    const cache = new RenditionCache(db, 10_000);
    const file = fetched(db, lib, 'p1', 'grid', 100);
    await cache.keep(lib, 'p1', 'grid', false, file);

    rmSync(file);
    cache.forget(lib.id, 'p1', 'grid', false);

    expect(cache.bytesHeld(lib.id)).toBe(0);
    expect(new LibrariesRepository(db).getById(lib.id)?.rendered_photo_count).toBe(0);
  });

  it('forgets only the absent variant and preserves its queued work', async () => {
    const db = catalogue();
    const lib = library(db);
    const cache = new RenditionCache(db, 10_000);
    const file = fetched(db, lib, 'p1', 'grid', 100);
    const renditions = new RenditionsRepository(db);
    const full = getRenditionPath(lib, 'p1', 'full', true);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, 'full');
    const at = '2026-09-01T00:00:00.000Z';
    renditions.markBuilt('p1', 'grid', at, 'grid-edits', { from: 'render', matched: true });
    renditions.markBuilt('p1', 'full-hdr', at, 'full-edits', { from: 'render', matched: true });
    renditions.queue('p1', ['grid']);
    await cache.keep(lib, 'p1', 'grid', false, file);

    rmSync(file);
    cache.forget(lib.id, 'p1', 'grid', false);

    expect(
      db
        .query(
          'SELECT needs_build, built_at, built_from, source, matched FROM renditions WHERE photo_id = ? AND variant = ?',
        )
        .get('p1', 'grid'),
    ).toEqual({ needs_build: 1, built_at: null, built_from: null, source: null, matched: null });
    expect(existsSync(full)).toBe(true);
    expect(renditions.stamps('p1', 'full-hdr')).toEqual({ built_at: at, built_from: 'full-edits' });
    cache.forget(lib.id, 'p1', 'full', true);
    expect(renditions.stamps('p1', 'full-hdr')).toEqual({ built_at: at, built_from: 'full-edits' });
    expect(new LibrariesRepository(db).getById(lib.id)?.rendered_photo_count).toBe(1);
  });
});
