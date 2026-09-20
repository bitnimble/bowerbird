import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { StackMembership } from '../../../stacks/stack_membership';
import { RenditionsRepository } from '../../../processing/renditions/renditions_repository';
import { PhotoListingRepository } from '../../listing/photo_listing_repository';
import { PhotoProcessingRepository } from '../../renditions/photo_processing_repository';
import { PhotoStateRepository } from '../photo_state_repository';
import type { PhotoListFilters } from '../../listing/photo_listing_repository';

// A binned photo's file_path points into the bin at the library root, and only
// `deleted_from_path` still says which folder it came from (§12.3). Both queries
// here are keyed on a folder prefix, so both have to read the right column - and
// which one that is depends on whether the row is deleted.
const LIB = 'lib';

let db: Database;
let repo: PhotoStateRepository;
let listing: PhotoListingRepository;
let processing: PhotoProcessingRepository;

function insert(id: string, filePath: string, deletedFrom?: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted, deleted_from_path)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
  ).run(id, LIB, filePath, deletedFrom == null ? 0 : 1, deletedFrom ?? null);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new PhotoStateRepository(db, new StackMembership(db));
  listing = new PhotoListingRepository(db);
  processing = new PhotoProcessingRepository(db, new RenditionsRepository(db));
  insert('live', 'Trip/a.arw');
  insert('binned', 'Bin/Trip/b.arw', 'Trip/b.arw');
  insert('elsewhere', 'Bin/Other/c.arw', 'Other/c.arw');
});

describe('a photograph put away', () => {
  function shoot(id: string, folderPath: string, hidden = false): void {
    db.query('INSERT INTO shoots (id, library_id, folder_path, name, is_hidden) VALUES (?, ?, ?, ?, ?)').run(
      id,
      LIB,
      folderPath,
      folderPath,
      hidden ? 1 : 0,
    );
  }

  const ids = (filters: PhotoListFilters): string[] =>
    listing.listByLibrary(LIB, 'added_asc', 0, 10, filters).photos.map((p) => p.id).sort();

  // The chip is a chip: ticked beside another it unions, so one grid holds the put-away and the live
  // together. Asked for alone it is the hidden on their own, which is the same rule with one arm.
  it('joins the grid rather than replacing it, when asked for beside another chip', () => {
    insert('picked', 'Trip/d.arw');
    insert('rejected', 'Trip/e.arw');
    db.query("UPDATE photos SET triage = 'picked' WHERE id = 'picked'").run();
    db.query("UPDATE photos SET triage = 'rejected' WHERE id = 'rejected'").run();
    repo.setHidden(['live'], true);

    // Hidden or picked, which is what the filter panel sends: both, and not the hidden picks.
    expect(ids({ includeDeleted: false, isHidden: true, triage: ['picked'], match: 'any' })).toEqual(['live', 'picked']);
    // The rejected one is in neither arm, so the union does not widen to everything.
    expect(ids({ includeDeleted: false, isHidden: true, triage: ['picked'], match: 'any' })).not.toContain('rejected');
    // And untouched, the default still leaves the hidden one out.
    expect(ids({ includeDeleted: false })).toEqual(['picked', 'rejected']);
  });

  it('leaves every listing but the one asking for it', () => {
    repo.setHidden(['live'], true);
    insert('shown', 'Trip/d.arw');

    expect(ids({ includeDeleted: false })).toEqual(['shown']);
    expect(ids({ includeDeleted: false, isHidden: true })).toEqual(['live']);
    // The row says so itself, so a grid can label what it is showing without asking twice.
    expect(listing.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: false, isHidden: true }).photos[0]?.is_hidden).toBe(
      true,
    );
    // And it comes back, having had nothing done to it but the flag.
    repo.setHidden(['live'], false);
    expect(ids({ includeDeleted: false })).toEqual(['live', 'shown']);
  });

  // The flag is never written onto the members, so this is the whole of what makes them hidden -
  // and the whole of what unhiding the shoot has to undo.
  it('is hidden by its shoot without its own flag being set', () => {
    shoot('s1', 'Trip', true);
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id = 'live'").run();
    insert('loose', 'Other/d.arw');

    expect(ids({ includeDeleted: false })).toEqual(['loose']);
    expect(ids({ includeDeleted: false, isHidden: true })).toEqual(['live']);
    // A photograph in no shoot at all still lists: `NULL NOT IN (a non-empty set)` is NULL, so the
    // clause needs its own IS NULL arm and this is what says it has one.
    expect(ids({ includeDeleted: false }).includes('loose')).toBe(true);

    db.query("UPDATE shoots SET is_hidden = 0 WHERE id = 's1'").run();
    expect(ids({ includeDeleted: false })).toEqual(['live', 'loose']);
  });

  // The one listing a hidden shoot does not empty: the reader asked this shoot what it holds. Its
  // own flag still applies there, which is the half `ownShoot` must not exempt.
  it('still lists on its own hidden shoot’s page, unless put away by hand', () => {
    shoot('s1', 'Trip', true);
    insert('also', 'Trip/d.arw');
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id IN ('live', 'also')").run();

    const inShoot = (): string[] =>
      listing.listByShoot('s1', 'added_asc', 0, 10, { includeDeleted: false }).photos.map((p) => p.id).sort();
    expect(inShoot()).toEqual(['also', 'live']);

    repo.setHidden(['live'], true);
    expect(inShoot()).toEqual(['also']);
  });

  // A shoot's hiding and a photograph's own are two flags, and unhiding the shoot may only undo the
  // one it set. Written as a cascade onto the members, this is the case that loses the hand-hiding.
  it('stays hidden after its shoot is unhidden, if it was hidden by hand too', () => {
    shoot('s1', 'Trip', true);
    insert('also', 'Trip/d.arw');
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id IN ('live', 'also')").run();
    repo.setHidden(['live'], true);

    db.query("UPDATE shoots SET is_hidden = 0 WHERE id = 's1'").run();
    expect(ids({ includeDeleted: false })).toEqual(['also']);
    expect(ids({ includeDeleted: false, isHidden: true })).toEqual(['live']);
  });

  // A stack straddling a hidden shoot and a visible one: the visible shoot's page counts and opens
  // onto its own half, and no reading of it drags the hidden half into view.
  it('counts a stack on a visible shoot’s page without the hidden shoot’s half', () => {
    shoot('open', 'Open', false);
    shoot('away', 'Away', true);
    insert('shown-a', 'Open/a.arw');
    insert('hidden-b', 'Away/b.arw');
    db.query("UPDATE photos SET shoot_id = 'open' WHERE id = 'shown-a'").run();
    db.query("UPDATE photos SET shoot_id = 'away' WHERE id = 'hidden-b'").run();
    db.query("UPDATE photos SET stack_id = 'st1', is_representative = 0 WHERE id IN ('shown-a', 'hidden-b')").run();
    db.query("UPDATE photos SET is_representative = 1 WHERE id = 'shown-a'").run();

    const row = listing.listByShoot('open', 'added_asc', 0, 10, { includeDeleted: false }).photos[0];
    expect([row?.id, row?.stack_size]).toEqual(['shown-a', 1]);
  });

  it('is passed over by the rendition queue, and queued again when it comes back', () => {
    db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, '/r', 'lib')").run(LIB);

    expect(processing.listPendingProcessing(LIB).map((p) => p.photo_id)).toEqual(['live']);
    repo.setHidden(['live'], true);
    expect(processing.listPendingProcessing(LIB)).toEqual([]);
    expect(processing.countPendingProcessing(LIB)).toBe(0);
    // Passed over rather than un-queued, so nothing has to go looking for what was skipped.
    repo.setHidden(['live'], false);
    expect(processing.listPendingProcessing(LIB).map((p) => p.photo_id)).toEqual(['live']);
  });

  // Otherwise a photograph binned out of the hidden view is in no listing at all: gone from the
  // hidden one, which lists live rows, and gone from the Bin too.
  it('is in the Bin once binned, hidden or not', () => {
    repo.setHidden(['binned'], true);
    const bin = listing.listByLibrary(LIB, 'added_asc', 0, 10, { includeDeleted: true, isDeleted: true });
    expect(bin.photos.map((p) => p.id).sort()).toEqual(['binned', 'elsewhere']);
  });

  /**
   * The badge is the absolute answer, and stays so on the one page that lists these anyway.
   *
   * The listing's own clause exempts the shoot being read, or the page would open onto nothing. The
   * *column* deliberately does not: threading the exemption into it too - which reads like the
   * consistent thing to do - takes the badge off every tile on a hidden shoot's page, which is the
   * one place a reader most needs telling that the whole shoot is put away.
   */
  it('still reports itself hidden on its own hidden shoot’s page', () => {
    shoot('s1', 'Trip', true);
    db.query("UPDATE photos SET shoot_id = 's1' WHERE id = 'live'").run();

    const rows = listing.listByShoot('s1', 'added_asc', 0, 10, { includeDeleted: false }).photos;
    expect(rows.map((p) => [p.id, p.is_hidden])).toEqual([['live', true]]);
  });

  // Hiding is a third way the member a stack's tile stands for stops being one any listing shows, so
  // it re-ranks like a binning and a verdict do. Left flagged, every later query for that stack falls
  // through to the promotion subquery the flag exists to avoid.
  it('hands the stack’s flag to a member that is still shown', () => {
    insert('other', 'Trip/d.arw');
    db.query("UPDATE photos SET stack_id = 'st1', is_representative = 0 WHERE id IN ('live', 'other')").run();
    db.query("UPDATE photos SET is_representative = 1 WHERE id = 'live'").run();

    repo.setHidden(['live'], true);

    const flagged = db
      .query("SELECT id FROM photos WHERE stack_id = 'st1' AND is_representative = 1")
      .all() as { id: string }[];
    expect(flagged.map((r) => r.id)).toEqual(['other']);
  });

  it('moves a stamp of its own, so a rating arriving from a peer cannot bring it back', () => {
    const stampsOf = (): { stamp_hidden: string | null; stamp_triage: string | null } =>
      db.query('SELECT stamp_hidden, stamp_triage FROM photos WHERE id = ?').get('live') as {
        stamp_hidden: string | null;
        stamp_triage: string | null;
      };

    repo.setHidden(['live'], true);
    expect(stampsOf().stamp_hidden).not.toBeNull();
    expect(stampsOf().stamp_triage).toBeNull();
  });
});

describe('PhotoStateRepository.updateMany', () => {
  const markOf = (id: string): { rating: number; triage: string | null; stamp_triage: string | null } =>
    db.query('SELECT rating, triage, stamp_triage FROM photos WHERE id = ?').get(id) as {
      rating: number;
      triage: string | null;
      stamp_triage: string | null;
    };

  it('sets the fields it was given on every row, under one stamp', () => {
    expect(repo.updateMany(['live', 'binned'], { rating: 4, triage: 'picked' })).toBe(2);

    expect(markOf('live')).toMatchObject({ rating: 4, triage: 'picked' });
    expect(markOf('binned')).toMatchObject({ rating: 4, triage: 'picked' });
    expect(markOf('live').stamp_triage).toBe(markOf('binned').stamp_triage!);
    // Untouched, so its own fields are where they were.
    expect(markOf('elsewhere')).toMatchObject({ rating: 0, triage: null, stamp_triage: null });
  });

  it('leaves the field it was not given alone', () => {
    repo.updateMany(['live'], { rating: 3 });
    repo.updateMany(['live'], { triage: 'rejected' });
    expect(markOf('live')).toMatchObject({ rating: 3, triage: 'rejected' });
  });

  // 'untriaged' is NULL in the column, so clearing a verdict has to be a real
  // write rather than a field left out.
  it('clears a verdict', () => {
    repo.updateMany(['live'], { triage: 'picked' });
    repo.updateMany(['live'], { triage: 'untriaged' });
    expect(markOf('live').triage).toBeNull();
  });

  it('does nothing when there is nothing to set', () => {
    expect(repo.updateMany(['live'], {})).toBe(0);
    expect(repo.updateMany([], { rating: 1 })).toBe(0);
    expect(markOf('live')).toMatchObject({ rating: 0, stamp_triage: null });
  });

  // Past `IN_CHUNK`, which is the whole reason this exists: rating a shoot names
  // more ids than SQLite will bind in one statement, and the batch still has to
  // land as one thing.
  it('marks a selection larger than one chunk of bindings', () => {
    const many = Array.from({ length: 2000 }, (_, n) => `bulk${n}`);
    for (const id of many) insert(id, `Trip/${id}.arw`);

    expect(repo.updateMany(many, { rating: 5, triage: 'rejected' })).toBe(many.length);

    const marked = db.query("SELECT COUNT(*) AS n FROM photos WHERE rating = 5 AND triage = 'rejected'").get() as {
      n: number;
    };
    expect(marked.n).toBe(many.length);
    // One stamp across every chunk, not one per statement.
    const stamps = db.query('SELECT COUNT(DISTINCT stamp_triage) AS n FROM photos WHERE id LIKE ?').get('bulk%') as {
      n: number;
    };
    expect(stamps.n).toBe(1);
  });
});
