import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { PhotoListingRepository } from '../photo_listing_repository';
import { PhotoNavigationRepository } from '../photo_navigation_repository';
import type { PhotoListFilters } from '../photo_listing_repository';

// A binned photo's file_path points into the bin at the library root, and only
// `deleted_from_path` still says which folder it came from (§12.3). Both queries
// here are keyed on a folder prefix, so both have to read the right column - and
// which one that is depends on whether the row is deleted.
const LIB = 'lib';

let db: Database;
let repo: PhotoListingRepository;
let navigation: PhotoNavigationRepository;

function insert(id: string, filePath: string, deletedFrom?: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted, deleted_from_path)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
  ).run(id, LIB, filePath, deletedFrom == null ? 0 : 1, deletedFrom ?? null);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new PhotoListingRepository(db);
  navigation = new PhotoNavigationRepository(db);
  insert('live', 'Trip/a.arw');
  insert('binned', 'Bin/Trip/b.arw', 'Trip/b.arw');
  insert('elsewhere', 'Bin/Other/c.arw', 'Other/c.arw');
});

describe('PhotoListingRepository.listByLibrary', () => {
  it('narrows to the photographs no shoot has claimed', () => {
    insert('claimed', 'Trip/d.arw');
    db.query('UPDATE photos SET shoot_id = ? WHERE id = ?').run('s1', 'claimed');

    const ids = (filters: PhotoListFilters): string[] =>
      repo.listByLibrary(LIB, 'added_asc', 0, 10, filters).photos.map((p) => p.id).sort();

    expect(ids({ includeDeleted: false })).toEqual(['claimed', 'live']);
    expect(ids({ includeDeleted: false, noShoot: true })).toEqual(['live']);
  });

  it('promotes and counts inside the filter when a stack straddles a shoot', () => {
    insert('claimed', 'Trip/d.arw');
    insert('loose-b', 'Trip/e.arw');
    insert('loose-c', 'Trip/f.arw');
    db.query("UPDATE photos SET stack_id = 'st1', is_representative = 0 WHERE id IN ('claimed', 'loose-b', 'loose-c')").run();
    db.query("UPDATE photos SET is_representative = 1, shoot_id = 's1' WHERE id = 'claimed'").run();

    const stack = (filters: PhotoListFilters): [string, number][] =>
      repo
        .listByLibrary(LIB, 'added_asc', 0, 10, filters)
        .photos.filter((p) => p.stack_id === 'st1')
        .map((p) => [p.id, p.stack_size]);

    expect(stack({ includeDeleted: false })).toEqual([['claimed', 3]]);
    // The flagged member is in a shoot, so the stack stands on the newest member
    // that is not - and stands for two photographs rather than three.
    expect(stack({ includeDeleted: false, noShoot: true })).toEqual([['loose-c', 2]]);
  });

  it('counts the entries of a collapsed listing and the photographs behind them', () => {
    insert('member-b', 'Trip/e.arw');
    insert('member-c', 'Trip/f.arw');
    db.query("UPDATE photos SET stack_id = 'st1', is_representative = 0 WHERE id IN ('live', 'member-b', 'member-c')").run();
    db.query("UPDATE photos SET is_representative = 1 WHERE id = 'live'").run();

    const collapsed = repo.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false });
    expect([collapsed.total, collapsed.photoTotal]).toEqual([1, 3]);

    const expanded = repo.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false, expandStacks: true });
    expect([expanded.total, expanded.photoTotal]).toEqual([3, 3]);

    // A cull that leaves one member in the filter takes the stack down to an
    // ordinary entry, and the count follows it rather than the membership.
    db.query("UPDATE photos SET triage = 'rejected' WHERE id IN ('member-b', 'member-c')").run();
    const culled = repo.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false, triage: ['untriaged'] });
    expect([culled.total, culled.photoTotal]).toEqual([1, 1]);
  });
});

describe('PhotoListingRepository summary rows', () => {
  it('says which photographs have develop settings, on every listing that carries a row', () => {
    db.query(
      `INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at)
         VALUES ('live', '{}', 0, 1, '2026-01-01T00:00:00.000Z')`,
    ).run();

    const edited = (rows: { id: string; is_edited: boolean }[]): string[] =>
      rows.filter((row) => row.is_edited).map((row) => row.id);

    expect(edited(repo.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false }).photos)).toEqual(['live']);
    expect(edited(navigation.neighboursInLibrary(LIB, 'added_asc', 'live', 2, { includeDeleted: false }))).toEqual(['live']);
  });
});

describe('PhotoListingRepository days', () => {
  function taken(id: string, at: string | null): void {
    insert(id, `Trip/${id}.arw`);
    db.query('UPDATE photos SET date_taken = ? WHERE id = ?').run(at, id);
  }

  it('counts the photographs on each day the collection holds any, and no day it holds none', () => {
    taken('dawn', '2024-03-09T05:12:00.000Z');
    taken('dusk', '2024-03-09T19:40:00.000Z');
    taken('later', '2024-03-11T09:00:00.000Z');

    const { days } = repo.daysInLibrary(LIB, { includeDeleted: false });

    // The outer suite's one live row carries no capture date, so it falls on the day
    // it was added: the same date the grid orders and labels it by.
    expect(days).toEqual([
      { day: '2024-03-09', count: 2 },
      { day: '2024-03-11', count: 1 },
      { day: '2026-01-01', count: 1 },
    ]);
  });

  it('counts the view it is asked for, so a binned day is the Bin’s and not the gallery’s', () => {
    taken('gone', '2024-03-09T05:12:00.000Z');
    db.query("UPDATE photos SET is_deleted = 1 WHERE id = 'gone'").run();

    expect(repo.daysInLibrary(LIB, { includeDeleted: false }).days.map((d) => d.day)).toEqual(['2026-01-01']);
    expect(repo.daysInLibrary(LIB, { includeDeleted: true, isDeleted: true }).days).toEqual([
      { day: '2024-03-09', count: 1 },
      { day: '2026-01-01', count: 2 },
    ]);
  });
});

describe('PhotoListingRepository models', () => {
  function shot(id: string, camera: string | null, lens: string | null): void {
    insert(id, `Trip/${id}.arw`);
    db.query('UPDATE photos SET camera_model = ?, lens_model = ? WHERE id = ?').run(camera, lens, id);
  }

  beforeEach(() => {
    shot('a7-24', 'ILCE-7RM5', 'FE 24-70mm F2.8 GM II');
    shot('a7-85', 'ILCE-7RM5', 'FE 85mm F1.4 GM');
    shot('r5-24', 'Canon EOS R5', 'RF24-105mm F4 L IS USM');
    shot('phone', 'iPhone 17 Pro', null);
  });

  it('answers with the pairings the collection holds, so a lens knows which bodies it was on', () => {
    const { pairs } = repo.modelsInLibrary(LIB, { includeDeleted: false });

    expect(pairs).toContainEqual({ camera_model: 'ILCE-7RM5', lens_model: 'FE 85mm F1.4 GM' });
    // A fixed-lens body records no lens, and is still a body worth filtering by.
    expect(pairs).toContainEqual({ camera_model: 'iPhone 17 Pro', lens_model: null });
    // The rows of the outer suite carry neither, and are no pairing at all.
    expect(pairs).toHaveLength(4);
  });

  it('offers a body only where the view it is asked for holds one', () => {
    db.query("UPDATE photos SET is_deleted = 1 WHERE id IN ('r5-24')").run();
    const bodies = (filters: PhotoListFilters): (string | null)[] =>
      repo.modelsInLibrary(LIB, filters).pairs.map((p) => p.camera_model).sort();

    // Binned, so the gallery cannot be narrowed to it - offering it there is a tick
    // that empties the grid.
    expect(bodies({ includeDeleted: false })).toEqual(['ILCE-7RM5', 'ILCE-7RM5', 'iPhone 17 Pro']);
    // And the Bin is only that body, for the same reason the other way round.
    expect(bodies({ includeDeleted: true, isDeleted: true })).toEqual(['Canon EOS R5']);
  });

  it('narrows a listing to the models asked for, unioned within each list and intersected across them', () => {
    const ids = (filters: PhotoListFilters): string[] =>
      repo.listByLibrary(LIB, 'added_asc', 0, 10, filters).photos.map((p) => p.id).sort();

    expect(ids({ includeDeleted: false, cameraModels: ['ILCE-7RM5'] })).toEqual(['a7-24', 'a7-85']);
    expect(ids({ includeDeleted: false, cameraModels: ['ILCE-7RM5', 'Canon EOS R5'] })).toEqual(['a7-24', 'a7-85', 'r5-24']);
    expect(ids({ includeDeleted: false, lensModels: ['FE 85mm F1.4 GM'] })).toEqual(['a7-85']);
    expect(ids({ includeDeleted: false, cameraModels: ['ILCE-7RM5'], lensModels: ['FE 85mm F1.4 GM'] })).toEqual(['a7-85']);
    // Scope rather than a chip: `match: 'any'` unions the chips, and a body still
    // narrows whatever set they describe.
    expect(ids({ includeDeleted: false, cameraModels: ['ILCE-7RM5'], rated: false, match: 'any' })).toEqual([
      'a7-24',
      'a7-85',
    ]);
  });
});
