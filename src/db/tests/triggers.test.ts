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

interface Marks {
  rating: number;
  triage: string | null;
  notes: string | null;
  is_hidden: number;
}

function marksOf(db: Database, id: string): Marks {
  return db
    .query('SELECT rating, triage, notes, is_hidden FROM photos WHERE id = ?')
    .get(id) as Marks;
}

function mark(db: Database, id: string, rating: number, at: string): void {
  db.query(
    "UPDATE photos SET rating = ?, triage = 'picked', notes = ?, stamp_triage = ? WHERE id = ?",
  ).run(rating, `${id} notes`, at, id);
}

describe('photoLinkTriggers', () => {
  it('links a RAW and the camera JPEG of the same shot, whichever lands first', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'other', 'Trip/DSC01235.JPG');
    expect(links(db)).toEqual([['raw', 'jpeg']]);
  });

  it("links a camera's HEIF the way it links a JPEG", () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'heif', 'Trip/DSC01234.HIF');
    expect(links(db)).toEqual([['raw', 'heif']]);
  });

  it('gives a RAW arriving late the marks its camera file was given first', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    mark(db, 'jpeg', 4, '0002');
    db.query("UPDATE photos SET is_hidden = 1, stamp_hidden = '0002' WHERE id = 'jpeg'").run();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    expect(marksOf(db, 'raw')).toEqual({
      rating: 4,
      triage: 'picked',
      notes: 'jpeg notes',
      is_hidden: 1,
    });
  });

  it('keeps the later marks of the two when a pair links', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW', { taken: null });
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    mark(db, 'jpeg', 2, '0001');
    mark(db, 'raw', 5, '0003');
    db.query("UPDATE photos SET date_taken = '2026-03-04T05:06:07.000Z' WHERE id = 'raw'").run();
    expect(marksOf(db, 'jpeg')).toMatchObject({ rating: 5, notes: 'raw notes' });
    expect(marksOf(db, 'raw')).toMatchObject({ rating: 5, notes: 'raw notes' });
  });

  it('carries a mark on either half to the other', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    mark(db, 'raw', 3, '0001');
    expect(marksOf(db, 'jpeg')).toMatchObject({ rating: 3, triage: 'picked' });
    mark(db, 'jpeg', 1, '0002');
    expect(marksOf(db, 'raw')).toMatchObject({ rating: 1, notes: 'jpeg notes' });
    db.query("UPDATE photos SET is_hidden = 1, stamp_hidden = '0003' WHERE id = 'raw'").run();
    expect(marksOf(db, 'jpeg').is_hidden).toBe(1);
  });

  it("carries a mark on one camera file to its RAW's other", () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'heif', 'Trip/DSC01234.HIF');
    mark(db, 'jpeg', 4, '0001');
    expect(marksOf(db, 'heif')).toMatchObject({ rating: 4, notes: 'jpeg notes' });
  });

  it('gives no half a label whose removal from it is later than the label', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    db.query(
      "INSERT INTO photo_labels (library_id, label_id, photo_id, stamp) VALUES ('lib', 'l1', 'jpeg', '0001')",
    ).run();
    db.query(
      `INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted)
         VALUES ('lib', 'photo_label', 'l1/raw', '0002', 1)`,
    ).run();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    expect(links(db)).toEqual([['raw', 'jpeg']]);
    expect(db.query("SELECT 1 FROM photo_labels WHERE photo_id = 'raw'").all()).toEqual([]);
  });

  it('keeps a link a rename still matches, without forming it again', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    db.query(
      "INSERT INTO photo_labels (library_id, label_id, photo_id, stamp) VALUES ('lib', 'l1', 'jpeg', '0001')",
    ).run();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    db.query("DELETE FROM photo_labels WHERE photo_id = 'raw'").run();
    db.exec(
      `UPDATE photos SET recipe = json_object('kind', 'file', 'path', 'Moved/DSC01234.ARW') WHERE id = 'raw'`,
    );
    expect(links(db)).toEqual([['raw', 'jpeg']]);
    expect(db.query("SELECT 1 FROM photo_labels WHERE photo_id = 'raw'").all()).toEqual([]);
  });

  it('leaves a pair alone when a scan writes back the header it already had', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    db.query(
      "INSERT INTO photo_labels (library_id, label_id, photo_id, stamp) VALUES ('lib', 'l1', 'jpeg', '0001')",
    ).run();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    db.query("DELETE FROM photo_labels WHERE photo_id = 'raw'").run();
    db.query(
      "UPDATE photos SET date_taken = date_taken, camera_make = camera_make WHERE id = 'raw'",
    ).run();
    expect(db.query("SELECT 1 FROM photo_labels WHERE photo_id = 'raw'").all()).toEqual([]);
    expect(links(db)).toEqual([['raw', 'jpeg']]);
  });

  it("gives each half the other's labels and albums when the pair links", () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    db.query(
      "INSERT INTO photo_labels (library_id, label_id, photo_id, stamp) VALUES ('lib', 'l1', 'jpeg', '0001')",
    ).run();
    db.query("INSERT INTO albums (id, name) VALUES ('a1', 'Trip')").run();
    db.query(
      "INSERT INTO album_photos (album_id, photo_id, date_added) VALUES ('a1', 'jpeg', '2026-01-02')",
    ).run();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    expect(
      db.query("SELECT label_id, stamp FROM photo_labels WHERE photo_id = 'raw'").all(),
    ).toEqual([{ label_id: 'l1', stamp: '0001' }]);
    expect(db.query("SELECT album_id FROM album_photos WHERE photo_id = 'raw'").all()).toEqual([
      { album_id: 'a1' },
    ]);
  });

  it('links across folders, as a card split between two slots lands', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Slot 1/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Slot 2/dsc01234.jpg');
    expect(links(db)).toEqual([['raw', 'jpeg']]);
  });

  it('leaves apart a counter that wrapped and a second body with the same names', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'A/DSC01234.ARW');
    insertShot(db, 'wrapped', 'B/DSC01234.JPG', { taken: '2027-01-01T00:00:00.000Z' });
    insertShot(db, 'body', 'C/DSC01234.JPG', { model: 'ILCE-7RM5' });
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
