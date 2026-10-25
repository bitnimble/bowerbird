import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { LabelsRepository } from '../../../labels/labels_repository';
import { reconcileLinks } from '../linked_photos';

function openMigrated(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertShot(db: Database, id: string, path: string, taken: string | null = null): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, format, width, height, date_added, date_taken, camera_make, camera_model)
       VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), ?, 6000, 4000, '2026-01-01', ?, 'Sony', 'ILCE-7M4')`,
  ).run(
    id,
    path,
    path.endsWith('.JPG') ? 'jpeg' : path.endsWith('.HIF') ? 'heif' : 'arw',
    taken ?? '2026-03-04T05:06:07.000Z',
  );
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

function label(db: Database, id: string, at: string): void {
  db.query(
    "INSERT INTO photo_labels (library_id, label_id, photo_id, stamp) VALUES ('lib', 'l1', ?, ?)",
  ).run(id, at);
}

function stack(db: Database, id: string, origin: string, members: string[]): void {
  db.query(
    "INSERT INTO stacks (id, library_id, origin, date_created, stamp) VALUES (?, 'lib', ?, '2026-01-01', '0001')",
  ).run(id, origin);
  for (const [index, photoId] of members.entries()) {
    db.query(
      "INSERT INTO stack_members (library_id, stack_id, photo_id, stamp) VALUES ('lib', ?, ?, '0001')",
    ).run(id, photoId);
    db.query(
      "UPDATE photos SET stack_id = ?, stack_state = 'stacked', is_representative = ? WHERE id = ?",
    ).run(id, index === 0 ? 1 : 0, photoId);
  }
}

const stackOf = (db: Database, id: string): string | null =>
  (db.query('SELECT stack_id FROM photos WHERE id = ?').get(id) as { stack_id: string | null })
    .stack_id;

const membersOf = (db: Database, stackId: string): string[] =>
  (
    db
      .query('SELECT photo_id FROM stack_members WHERE stack_id = ? ORDER BY photo_id')
      .all(stackId) as { photo_id: string }[]
  ).map((row) => row.photo_id);

const labelled = (db: Database, id: string): boolean =>
  db.query("SELECT 1 FROM photo_labels WHERE label_id = 'l1' AND photo_id = ?").get(id) != null;

describe('reconcileLinks', () => {
  it('gives a RAW arriving late the marks its camera file was given first', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    mark(db, 'jpeg', 4, '0002');
    db.query("UPDATE photos SET is_hidden = 1, stamp_hidden = '0002' WHERE id = 'jpeg'").run();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    reconcileLinks(db);
    expect(marksOf(db, 'raw')).toEqual({
      rating: 4,
      triage: 'picked',
      notes: 'jpeg notes',
      is_hidden: 1,
    });
  });

  it('keeps the later marks of the two when a pair links', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW', '2026-03-04T05:06:08.000Z');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    mark(db, 'jpeg', 2, '0001');
    mark(db, 'raw', 5, '0003');
    db.query("UPDATE photos SET date_taken = '2026-03-04T05:06:07.000Z' WHERE id = 'raw'").run();
    reconcileLinks(db);
    expect(marksOf(db, 'jpeg')).toMatchObject({ rating: 5, notes: 'raw notes' });
    expect(marksOf(db, 'raw')).toMatchObject({ rating: 5, notes: 'raw notes' });
  });

  it('carries a mark on either half to the other, under a stamp of its own', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    reconcileLinks(db);
    mark(db, 'raw', 3, '0001');
    reconcileLinks(db, ['raw']);
    expect(marksOf(db, 'jpeg')).toMatchObject({ rating: 3, triage: 'picked' });
    const copied = db.query("SELECT stamp_triage FROM photos WHERE id = 'jpeg'").get() as {
      stamp_triage: string;
    };
    expect(copied.stamp_triage > '0001').toBe(true);
    mark(db, 'jpeg', 1, '9999');
    reconcileLinks(db, ['jpeg']);
    expect(marksOf(db, 'raw')).toMatchObject({ rating: 1, notes: 'jpeg notes' });
  });

  it("carries a mark on one camera file to its RAW's other", () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'heif', 'Trip/DSC01234.HIF');
    reconcileLinks(db);
    mark(db, 'jpeg', 4, '9999');
    reconcileLinks(db, ['jpeg']);
    expect(marksOf(db, 'heif')).toMatchObject({ rating: 4, notes: 'jpeg notes' });
  });

  it('gives a RAW and both its camera files the latest of their marks, whatever order they link in', () => {
    for (const order of [
      ['jpeg', 'heif'],
      ['heif', 'jpeg'],
    ] as const) {
      const db = openMigrated();
      const path = (id: string): string => `Trip/DSC01234.${id === 'jpeg' ? 'JPG' : 'HIF'}`;
      const [first, second] = order;
      insertShot(db, 'raw', 'Trip/DSC01234.ARW');
      insertShot(db, first, path(first));
      mark(db, first, 2, '0001');
      reconcileLinks(db);
      insertShot(db, second, path(second));
      mark(db, second, 5, '9999');
      reconcileLinks(db);
      for (const id of ['raw', 'jpeg', 'heif'])
        expect(marksOf(db, id)).toMatchObject({ rating: 5, notes: `${second} notes` });
    }
  });

  it('takes a label off every member of a group when its removal is the latest', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'heif', 'Trip/DSC01234.HIF');
    label(db, 'jpeg', '0001');
    label(db, 'heif', '0001');
    db.query(
      `INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted)
         VALUES ('lib', 'photo_label', 'l1/raw', '0002', 1)`,
    ).run();
    reconcileLinks(db);
    for (const id of ['raw', 'jpeg', 'heif']) expect(labelled(db, id)).toBe(false);
  });

  it("gives each half the other's labels when the pair links", () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    label(db, 'jpeg', '0001');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    reconcileLinks(db);
    expect(labelled(db, 'raw')).toBe(true);
  });

  it('takes a label off both halves where its removal from one is the later', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    label(db, 'jpeg', '0001');
    db.query(
      `INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted)
         VALUES ('lib', 'photo_label', 'l1/raw', '0002', 1)`,
    ).run();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    reconcileLinks(db);
    expect(labelled(db, 'raw')).toBe(false);
    expect(labelled(db, 'jpeg')).toBe(false);
  });

  it("puts a RAW arriving late in its camera file's place in a stack", () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'other', 'Trip/DSC01235.ARW');
    stack(db, 'chosen', 'manual', ['jpeg', 'other']);
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    reconcileLinks(db);
    expect(membersOf(db, 'chosen')).toEqual(['other', 'raw']);
    expect(stackOf(db, 'raw')).toBe('chosen');
    expect(stackOf(db, 'jpeg')).toBeNull();
  });

  it('moves a RAW out of a detected stack into the stack a person put its camera file in', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'other', 'Trip/DSC01235.ARW');
    insertShot(db, 'burst', 'Trip/DSC01236.ARW');
    stack(db, 'chosen', 'manual', ['jpeg', 'other']);
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    db.query('UPDATE photo_links SET pending = 0').run();
    stack(db, 'detected', 'auto', ['raw', 'burst']);
    db.query('UPDATE photo_links SET pending = 1').run();
    reconcileLinks(db);
    expect(membersOf(db, 'chosen')).toEqual(['other', 'raw']);
    expect(stackOf(db, 'burst')).toBeNull();
  });

  it('dissolves a stack holding only a RAW and its camera file', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    db.query('UPDATE photo_links SET pending = 0').run();
    stack(db, 'pair', 'manual', ['raw', 'jpeg']);
    db.query('UPDATE photo_links SET pending = 1').run();
    reconcileLinks(db);
    expect(stackOf(db, 'raw')).toBeNull();
    expect(db.query("SELECT 1 FROM stacks WHERE id = 'pair'").get()).toBeNull();
  });

  it('keeps a RAW in the stack a person put it in, taking its camera file out of another', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    for (const id of ['a', 'b', 'c']) insertShot(db, id, `Trip/DSC0123${id}.ARW`);
    db.query('UPDATE photo_links SET pending = 0').run();
    stack(db, 'mine', 'manual', ['raw', 'a']);
    stack(db, 'theirs', 'manual', ['jpeg', 'b', 'c']);
    db.query('UPDATE photo_links SET pending = 1').run();
    reconcileLinks(db);
    expect(membersOf(db, 'mine')).toEqual(['a', 'raw']);
    expect(membersOf(db, 'theirs')).toEqual(['b', 'c']);
    expect(stackOf(db, 'jpeg')).toBeNull();
  });

  it('puts a RAW once in the stack holding both its camera files', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'heif', 'Trip/DSC01234.HIF');
    insertShot(db, 'other', 'Trip/DSC01235.ARW');
    stack(db, 'chosen', 'manual', ['jpeg', 'heif', 'other']);
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    reconcileLinks(db);
    expect(membersOf(db, 'chosen')).toEqual(['other', 'raw']);
    expect(stackOf(db, 'raw')).toBe('chosen');
  });

  it('keeps a RAW a person took out of a stack out when its camera file leaves one', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    for (const id of ['a', 'b']) insertShot(db, id, `Trip/DSC0123${id}.ARW`);
    stack(db, 'chosen', 'manual', ['jpeg', 'a', 'b']);
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    db.query("UPDATE photos SET stack_state = 'unstacked' WHERE id = 'raw'").run();
    reconcileLinks(db);
    expect(membersOf(db, 'chosen')).toEqual(['a', 'b']);
    expect(stackOf(db, 'raw')).toBeNull();
  });

  it('takes a label off a camera file for good once its RAW is gone', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    label(db, 'raw', '0001');
    reconcileLinks(db);
    db.query("UPDATE photos SET is_missing = 1 WHERE id = 'raw'").run();
    new LabelsRepository(db).removePhotos('l1', 'lib', ['jpeg']);
    mark(db, 'jpeg', 3, '9999');
    reconcileLinks(db, ['jpeg']);
    expect(labelled(db, 'jpeg')).toBe(false);
    expect(labelled(db, 'raw')).toBe(false);
  });

  it('leaves a camera file put in a stack after its link formed', () => {
    const db = openMigrated();
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'other', 'Trip/DSC01235.ARW');
    reconcileLinks(db);
    stack(db, 'chosen', 'manual', ['jpeg', 'other']);
    mark(db, 'jpeg', 3, '9999');
    reconcileLinks(db, ['jpeg']);
    expect(membersOf(db, 'chosen')).toEqual(['jpeg', 'other']);
  });

  it('settles a pair a folder rename relinked without writing to it', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    mark(db, 'raw', 3, '0001');
    reconcileLinks(db);
    db.query(
      "UPDATE photos SET recipe = json_set(recipe, '$.path', replace(json_extract(recipe, '$.path'), 'Trip/', 'Away/'))",
    ).run();
    expect(db.query('SELECT pending FROM photo_links').all()).toEqual([{ pending: 1 }]);
    const before = db.query('SELECT id, stamp_triage FROM photos ORDER BY id').all();
    reconcileLinks(db);
    expect(db.query('SELECT pending FROM photo_links').all()).toEqual([{ pending: 0 }]);
    expect(db.query('SELECT id, stamp_triage FROM photos ORDER BY id').all()).toEqual(before);
  });

  it('has nothing to write once both halves agree', () => {
    const db = openMigrated();
    insertShot(db, 'raw', 'Trip/DSC01234.ARW');
    insertShot(db, 'jpeg', 'Trip/DSC01234.JPG');
    mark(db, 'raw', 3, '0001');
    reconcileLinks(db);
    const before = db.query('SELECT id, stamp_triage FROM photos ORDER BY id').all();
    reconcileLinks(db, ['raw', 'jpeg']);
    expect(db.query('SELECT id, stamp_triage FROM photos ORDER BY id').all()).toEqual(before);
  });
});
