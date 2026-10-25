import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { Database } from '../driver';
import { runMigrations } from '../migrate';
import { linkedPair, photoInputTriggers, triggers } from '../triggers';
import { RecipeSchema } from '../../schemas/recipes';

function openMigrated(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertPhoto(db: Database, id: string, recipe: string): void {
  db.query(
    "INSERT INTO photos (id, library_id, recipe, width, height, date_added) VALUES (?, 'lib', ?, 6000, 4000, '2026-01-01')",
  ).run(id, recipe);
}

function sourcesOfRow(db: Database, id: string): string[] {
  return (
    db.query('SELECT photo_id FROM photo_sources WHERE composed_id = ? ORDER BY at').all(id) as {
      photo_id: string;
    }[]
  ).map((row) => row.photo_id);
}

interface Shot {
  taken?: string | null;
  make?: string | null;
  model?: string | null;
}

function insertShot(db: Database, id: string, path: string, shot: Shot = {}): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, format, width, height, date_added, date_taken, camera_make, camera_model)
       VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), ?, 6000, 4000, '2026-01-01', ?, ?, ?)`,
  ).run(
    id,
    path,
    path.toLowerCase().endsWith('.jpg')
      ? 'jpeg'
      : path.toLowerCase().endsWith('.hif')
        ? 'heif'
        : 'arw',
    shot.taken === undefined ? '2026-03-04T05:06:07.000Z' : shot.taken,
    shot.make === undefined ? 'Sony' : shot.make,
    shot.model === undefined ? 'ILCE-7M4' : shot.model,
  );
}

function links(db: Database): [string, string][] {
  return (
    db
      .query('SELECT raw_id, camera_file_id FROM photo_links ORDER BY raw_id, camera_file_id')
      .all() as {
      raw_id: string;
      camera_file_id: string;
    }[]
  ).map((row) => [row.raw_id, row.camera_file_id]);
}

function inAlbum(db: Database, id: string): void {
  db.query("INSERT OR IGNORE INTO albums (id, name) VALUES ('a1', 'Trip')").run();
  db.query(
    "INSERT INTO album_photos (album_id, photo_id, date_added) VALUES ('a1', ?, '2026-01-02')",
  ).run(id);
}

function albumsOf(db: Database, id: string): string[] {
  return (
    db.query('SELECT album_id FROM album_photos WHERE photo_id = ?').all(id) as {
      album_id: string;
    }[]
  ).map((row) => row.album_id);
}

describe('photoLinkTriggers', () => {
  it('links a RAW and the camera JPEG of the same shot, whichever lands first', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'other', 'Trip/DSC01235.JPG');
    expect(links(db)).toEqual([['raw', 'jpeg']]);
    expect(db.query('SELECT pending FROM photo_links').all()).toEqual([{ pending: 1 }]);
  });

  it("links a camera's HEIF the way it links a JPEG", () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'heif', 'Trip/DSC01234.HIF');
    expect(links(db)).toEqual([['raw', 'heif']]);
  });

  it("gives each half the other's albums when the pair links", () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    inAlbum(db, 'jpeg');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    expect(albumsOf(db, 'raw')).toEqual(['a1']);
  });

  it('keeps a link a rename still matches, without forming it again', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    inAlbum(db, 'jpeg');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    db.query("DELETE FROM album_photos WHERE photo_id = 'raw'").run();
    db.exec(
      `UPDATE photos SET recipe = json_object('kind', 'file', 'path', 'Trip/dsc01234.arw') WHERE id = 'raw'`,
    );
    expect(links(db)).toEqual([['raw', 'jpeg']]);
    expect(albumsOf(db, 'raw')).toEqual([]);
  });

  it('leaves a pair alone when a scan writes back the header it already had', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    inAlbum(db, 'jpeg');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    db.query("DELETE FROM album_photos WHERE photo_id = 'raw'").run();
    db.query(
      "UPDATE photos SET date_taken = date_taken, camera_make = camera_make WHERE id = 'raw'",
    ).run();
    expect(links(db)).toEqual([['raw', 'jpeg']]);
    expect(albumsOf(db, 'raw')).toEqual([]);
  });

  it('links only within one folder, whatever case the names are in', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'export', 'Exports/DSC01234.JPG');
    insertShot(db, 'jpeg', 'Trip/dsc01234.jpg');
    expect(links(db)).toEqual([['raw', 'jpeg']]);
  });

  it('leaves apart a counter that wrapped and a second body with the same names', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'A/DSC01234.ARW');
    insertShot(db, 'wrapped', 'A/DSC01234.JPG', { taken: '2027-01-01T00:00:00.000Z' });
    insertShot(db, 'body', 'A/DSC01234.jpg', { model: 'ILCE-7RM5' });
    expect(links(db)).toEqual([]);
  });

  it('waits for both headers, and links once the second one is read', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW', { taken: null, make: null, model: null });
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    expect(links(db)).toEqual([]);
    db.exec(
      `UPDATE photos SET date_taken = '2026-03-04T05:06:07.000Z', camera_make = 'Sony',
         camera_model = 'ILCE-7M4' WHERE id = 'raw'`,
    );
    expect(links(db)).toEqual([['raw', 'jpeg']]);
  });

  it('follows a rename and forgets a deleted row', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    db.exec(
      `UPDATE photos SET recipe = json_object('kind', 'file', 'path', 'Trip/renamed.JPG') WHERE id = 'jpeg'`,
    );
    expect(links(db)).toEqual([]);
    db.exec(
      `UPDATE photos SET recipe = json_object('kind', 'file', 'path', 'Elsewhere/DSC01234.JPG') WHERE id = 'jpeg'`,
    );
    expect(links(db)).toEqual([]);
    db.exec(
      `UPDATE photos SET recipe = json_object('kind', 'file', 'path', 'Trip/DSC01234.JPG') WHERE id = 'jpeg'`,
    );
    expect(links(db)).toEqual([['raw', 'jpeg']]);
    db.exec("DELETE FROM photos WHERE id = 'raw'");
    expect(links(db)).toEqual([]);
  });

  it('finds the other half by a seek on the capture second', () => {
    const db = openMigrated();
    const plan = (
      db
        .query(
          `EXPLAIN QUERY PLAN SELECT jpeg.id FROM photos raw, photos jpeg
            WHERE raw.id = 'x' AND ${linkedPair('raw', 'jpeg', 'jpeg')}`,
        )
        .all() as { detail: string }[]
    ).map((row) => row.detail);
    expect(plan.some((step) => /SCAN jpeg\b/.test(step))).toBe(false);
  });
});

describe('photoInputTriggers', () => {
  it('indexes no sources for an unknown composite kind', () => {
    const db = openMigrated();
    insertPhoto(db, 'p1', JSON.stringify({ kind: 'mosaic', sources: [{ photoId: 'f1' }] }));
    expect(sourcesOfRow(db, 'p1')).toEqual([]);
  });

  it("indexes an assembly recipe's sources", () => {
    const db = openMigrated();
    insertPhoto(
      db,
      'p1',
      JSON.stringify({ kind: 'assembly', sources: [{ photoId: 'f1' }, { photoId: 'f2' }] }),
    );
    expect(sourcesOfRow(db, 'p1')).toEqual(['f1', 'f2']);
  });

  it('lists every composite kind in the union', () => {
    const kinds = RecipeSchema.options
      .map((option) => option.shape.kind.value)
      .filter((kind) => kind !== 'file');
    expect(kinds.length).toBeGreaterThan(1);
    for (const kind of kinds) expect(photoInputTriggers()).toContain(`'${kind}'`);
  });

  it('a library created before the allowlist takes the new trigger body', () => {
    const db = openMigrated();
    // The body a library shipped with before 'assembly' was a kind: the gate on 'panorama' alone.
    db.exec('DROP TRIGGER photos_index_inputs_ins');
    db.exec(photoInputTriggers().replace("IN ('panorama', 'assembly')", "= 'panorama'"));
    // Only the migration, then only what migrate.ts does after one.
    db.exec(
      readFileSync(new URL('../migrations/0004_composite_sources.sql', import.meta.url), 'utf8'),
    );
    db.exec(triggers());
    insertPhoto(db, 'p1', JSON.stringify({ kind: 'assembly', sources: [{ photoId: 'f1' }] }));
    expect(sourcesOfRow(db, 'p1')).toEqual(['f1']);
  });
});
