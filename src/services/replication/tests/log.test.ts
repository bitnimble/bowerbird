// The replication log, which the database maintains rather than the code that
// writes the row (docs/replication.md §4). What these pin is that moving a stamp
// is the whole of what a write site has to do, and that a catalogue nobody
// replicates pays nothing for the machinery.
import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { stamp } from '../stamps';

const LIB = 'lib';

let db: Database;

interface LogRow {
  entity: string;
  row_id: string;
  stamp: string;
  deleted: number;
}

function log(): LogRow[] {
  return db
    .query('SELECT entity, row_id, stamp, deleted FROM replication_log ORDER BY entity, row_id')
    .all() as LogRow[];
}

function replicate(libraryId: string): void {
  db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(libraryId);
}

function insertPhoto(id: string, stamps: Record<string, string> = {}): void {
  const columns = Object.keys(stamps);
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added${columns.map((c) => `, ${c}`).join('')})
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z'${columns.map(() => ', ?').join('')})`,
  ).run(id, libraryId(), `${id}.arw`, ...columns.map((c) => stamps[c]!));
}

let libraryId = (): string => LIB;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, '/photos', 'Trip')").run(LIB);
  libraryId = () => LIB;
});

describe('the replication log', () => {
  it('is not written at all for a library nobody replicates', () => {
    insertPhoto('p1', { stamp_imported: stamp(db), stamp_triage: stamp(db) });
    db.query('UPDATE photos SET rating = 4, stamp_triage = ? WHERE id = ?').run(stamp(db), 'p1');

    expect(log()).toEqual([]);
  });

  it('records the unit a write moved, and only that unit', () => {
    replicate(LIB);
    insertPhoto('p1', { stamp_imported: stamp(db) });
    expect(log().map((row) => row.entity)).toEqual(['photo.imported']);

    const triage = stamp(db);
    db.query('UPDATE photos SET rating = 4, stamp_triage = ? WHERE id = ?').run(triage, 'p1');

    expect(log()).toEqual([
      { entity: 'photo.imported', row_id: 'p1', stamp: expect.any(String), deleted: 0 },
      { entity: 'photo.triage', row_id: 'p1', stamp: triage, deleted: 0 },
    ]);
  });

  it('keeps one row per unit, holding the stamp it carries now', () => {
    replicate(LIB);
    insertPhoto('p1', { stamp_triage: stamp(db) });
    const second = stamp(db);
    db.query('UPDATE photos SET rating = 5, stamp_triage = ? WHERE id = ?').run(second, 'p1');

    expect(log()).toEqual([{ entity: 'photo.triage', row_id: 'p1', stamp: second, deleted: 0 }]);
  });

  // A merge applies whichever side is newer, so an older stamp arriving late must
  // not drag the log backwards - the entry would then claim a peer still needs to
  // be sent work it already has.
  it('never moves a unit backwards', () => {
    replicate(LIB);
    const newer = stamp(db);
    insertPhoto('p1', { stamp_triage: newer });
    db.query('UPDATE photos SET stamp_triage = ? WHERE id = ?').run('000000000000000000000000aaaaaaaa', 'p1');

    expect(log()[0]!.stamp).toBe(newer);
  });

  it('separates the units of one photograph, so each carries its own origin', () => {
    replicate(LIB);
    insertPhoto('p1', {
      stamp_imported: stamp(db),
      stamp_triage: stamp(db),
      stamp_placement: stamp(db),
      stamp_bin: stamp(db),
      stamp_stack: stamp(db),
    });

    expect(log().map((row) => row.entity)).toEqual([
      'photo.bin',
      'photo.imported',
      'photo.placement',
      'photo.stack',
      'photo.triage',
    ]);
  });

  it('follows a shoot, a stack and a library to the library they belong to', () => {
    replicate(LIB);
    db.query('INSERT INTO shoots (id, library_id, folder_path, name, stamp) VALUES (?, ?, ?, ?, ?)').run(
      's1',
      LIB,
      'Trip',
      'Trip',
      stamp(db),
    );
    db.query(
      "INSERT INTO stacks (id, library_id, origin, date_created, stamp) VALUES (?, ?, 'auto', '2026-01-01', ?)",
    ).run('st1', LIB, stamp(db));
    db.query('UPDATE libraries SET name = ?, stamp = ? WHERE id = ?').run('Renamed', stamp(db), LIB);

    expect(log().map((row) => `${row.entity}:${row.row_id}`).sort()).toEqual([
      `library:${LIB}`,
      'shoot:s1',
      'stack:st1',
    ]);
  });

  // photo_edits and shoot_banners hold no library of their own, so their triggers
  // have to reach the one their parent names.
  it('reaches through a photograph to find the library of its edits', () => {
    replicate(LIB);
    insertPhoto('p1');
    db.query(
      "INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp) VALUES (?, '{}', 0, 1, '2026-01-01', ?)",
    ).run('p1', stamp(db));

    expect(log()).toEqual([{ entity: 'photo_edits', row_id: 'p1', stamp: expect.any(String), deleted: 0 }]);
  });

  it('names a stack membership by the pair, so one photograph can sit in two', () => {
    replicate(LIB);
    insertPhoto('p1');
    db.query(
      "INSERT INTO stacks (id, library_id, origin, date_created) VALUES ('st1', ?, 'auto', '2026-01-01')",
    ).run(LIB);
    db.query(
      "INSERT INTO stacks (id, library_id, origin, date_created) VALUES ('st2', ?, 'auto', '2026-01-01')",
    ).run(LIB);
    db.query('INSERT INTO stack_members (library_id, stack_id, photo_id, stamp) VALUES (?, ?, ?, ?)').run(
      LIB,
      'st1',
      'p1',
      stamp(db),
    );
    db.query('INSERT INTO stack_members (library_id, stack_id, photo_id, stamp) VALUES (?, ?, ?, ?)').run(
      LIB,
      'st2',
      'p1',
      stamp(db),
    );

    expect(log().filter((row) => row.entity === 'stack_member').map((row) => row.row_id)).toEqual([
      'st1/p1',
      'st2/p1',
    ]);
  });
});
