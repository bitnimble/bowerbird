import { expect, test, describe, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/migrations';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { StacksRepository } from '../../src/services/stacks/stacks_repository';
import { StacksService } from '../../src/services/stacks/stacks_service';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import type { Ordering } from '../../src/schemas/common';

// Stepping through the viewer walks the collection *uncollapsed* (§19.5.3): the
// grid shows a stack as one tile, and the arrows visit every frame of it. These
// pin both halves of that - the walk sees every photograph, and the listing it is
// taken from still sees one row per stack.

const LIBRARY = 'lib00001';
const OTHER = 'lib00002';
const SHOOT = 'sht00010';
const NO_FILTERS = { includeDeleted: false } as const;
const ORDERINGS: Ordering[] = ['taken_asc', 'taken_desc', 'added_asc', 'added_desc'];

function photoId(n: number): string {
  return `photo${String(n).padStart(3, '0')}`;
}

function setUp(): { db: Database; photos: PhotosRepository; stacks: StacksService } {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  for (const id of [LIBRARY, OTHER]) {
    db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(id, `/tmp/${id}`, 'lib', 'taken_asc');
  }
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run(SHOOT, LIBRARY, 'Day1', 'Day1');
  const photos = new PhotosRepository(db);
  const stacks = new StacksService(new StacksRepository(db), photos, new LibrariesRepository(db));
  return { db, photos, stacks };
}

function insert(
  db: Database,
  n: number,
  options: { undated?: boolean; libraryId?: string; shootId?: string | null; triage?: string } = {},
): string {
  const id = photoId(n);
  const added = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  const taken = options.undated === true ? null : added;
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, file_path, width, height, date_taken, date_added, triage)
     VALUES (?, ?, ?, ?, 3000, 2000, ?, ?, ?)`,
  ).run(id, options.libraryId ?? LIBRARY, options.shootId ?? null, `IMG_${n}.ARW`, taken, added, options.triage ?? null);
  return id;
}

/** The whole collection as the viewer would step it, by walking one photo at a time. */
function walk(photos: PhotosRepository, ordering: Ordering, from: string): string[] {
  const seen = [from];
  for (let guard = 0; guard < 500; guard++) {
    const current = seen[seen.length - 1]!;
    const run = photos.neighboursInLibrary(LIBRARY, ordering, current, 50, NO_FILTERS);
    const at = run.findIndex((photo) => photo.id === current);
    const next = at < 0 ? undefined : run[at + 1];
    if (next == null) return seen;
    seen.push(next.id);
  }
  throw new Error('walk did not terminate');
}

describe('stepping through a collection', () => {
  let context: ReturnType<typeof setUp>;
  beforeEach(() => {
    context = setUp();
  });

  // The one that would have caught the original bug: the arrows skipped every
  // member a stack did not stand for.
  test('visits every member of a stack, where the listing shows one row for it', () => {
    const { db, photos, stacks } = context;
    const loose = [1, 5].map((n) => insert(db, n));
    stacks.create([2, 3, 4].map((n) => insert(db, n)));
    stacks.create([6, 7, 8].map((n) => insert(db, n)));

    const stepped = walk(photos, 'taken_asc', loose[0]!);

    // Eight photographs stepped through, in capture order.
    expect(stepped).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(photoId));
    // And the grid still shows three tiles: a loose photo, a stack, a loose
    // photo, a stack. Collapsed one way, whole the other, from one fixture.
    const listing = photos.listByLibrary(LIBRARY, 'taken_asc', 0, 100, NO_FILTERS);
    expect(listing.photos).toHaveLength(4);
    expect(listing.total).toBe(4);
  });

  test('a member the stack does not stand for has neighbours either side of it', () => {
    const { db, photos, stacks } = context;
    insert(db, 1);
    const members = [2, 3, 4].map((n) => insert(db, n));
    stacks.create(members);
    insert(db, 5);

    // The middle member, which no listing has a row for.
    const run = photos.neighboursInLibrary(LIBRARY, 'taken_asc', members[1]!, 50, NO_FILTERS);
    const at = run.findIndex((photo) => photo.id === members[1]!);

    expect(at).toBeGreaterThan(0);
    expect(run[at - 1]?.id).toBe(members[0]!);
    expect(run[at + 1]?.id).toBe(members[2]!);
  });

  test('the walk is the listing, in every ordering', () => {
    const { db, photos, stacks } = context;
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) insert(db, n);
    stacks.create([photoId(3), photoId(4)]);

    for (const ordering of ORDERINGS) {
      // The uncollapsed listing, which is what the viewer's sequence has to be.
      const expected = (
        db
          .query(
            `SELECT id FROM photos WHERE library_id = ? AND is_deleted = 0
             ORDER BY ${ordering.startsWith('taken') ? 'date_taken IS NULL, date_taken' : 'date_added'} ${
               ordering.endsWith('asc') ? 'ASC' : 'DESC'
             }, id ${ordering.endsWith('asc') ? 'ASC' : 'DESC'}`,
          )
          .all(LIBRARY) as { id: string }[]
      ).map((row) => row.id);

      expect(walk(photos, ordering, expected[0]!), ordering).toEqual(expected);
      // And backwards from the far end, which exercises the other seek direction.
      const run = photos.neighboursInLibrary(LIBRARY, ordering, expected[expected.length - 1]!, 50, NO_FILTERS);
      expect(run.map((photo) => photo.id), ordering).toEqual(expected);
    }
  });

  // Undated photographs sort last under `taken_*`, so the listing is two groups
  // and the run has to cross between them.
  test('crosses between dated and undated photographs', () => {
    const { db, photos } = context;
    const dated = [1, 2].map((n) => insert(db, n));
    const undated = [3, 4].map((n) => insert(db, n, { undated: true }));

    expect(walk(photos, 'taken_asc', dated[0]!)).toEqual([...dated, ...undated]);

    // Each end of the boundary sees the other side.
    const lastDated = photos.neighboursInLibrary(LIBRARY, 'taken_asc', dated[1]!, 50, NO_FILTERS);
    expect(lastDated[lastDated.findIndex((p) => p.id === dated[1]!) + 1]?.id).toBe(undated[0]!);
    const firstUndated = photos.neighboursInLibrary(LIBRARY, 'taken_asc', undated[0]!, 50, NO_FILTERS);
    expect(firstUndated[firstUndated.findIndex((p) => p.id === undated[0]!) - 1]?.id).toBe(dated[1]!);
  });

  // The commonest case in a cull: the verdict just set on this photo took it out
  // of the view, and the arrows still have to work.
  test('a photo the filter excludes still has neighbours, and they are adjacent to each other', () => {
    const { db, photos } = context;
    const ids = [1, 2, 3].map((n) => insert(db, n));
    db.query("UPDATE photos SET triage = 'rejected' WHERE id = ?").run(ids[1]!);
    const active = { includeDeleted: false, triage: ['untriaged' as const, 'picked' as const] };

    const run = photos.neighboursInLibrary(LIBRARY, 'taken_asc', ids[1]!, 50, active);
    const at = run.findIndex((photo) => photo.id === ids[1]!);
    expect(run[at - 1]?.id).toBe(ids[0]!);
    expect(run[at + 1]?.id).toBe(ids[2]!);
    // The rejected photo is not in the listing itself, so stepping on from it
    // lands where the two survivors meet.
    expect(photos.listByLibrary(LIBRARY, 'taken_asc', 0, 100, active).photos.map((p) => p.id)).toEqual([ids[0]!, ids[2]!]);
  });

  test('a photo outside the collection is a dead end rather than a walk through it', () => {
    const { db, photos } = context;
    insert(db, 1);
    const elsewhere = insert(db, 2, { libraryId: OTHER });
    const outsideShoot = insert(db, 3);
    insert(db, 4, { shootId: SHOOT });

    expect(photos.neighboursInLibrary(LIBRARY, 'taken_asc', elsewhere, 50, NO_FILTERS)).toEqual([]);
    expect(photos.neighboursInShoot(SHOOT, 'taken_asc', outsideShoot, 50, NO_FILTERS)).toEqual([]);
  });

  test('a shoot walks its own photographs and no others', () => {
    const { db, photos } = context;
    insert(db, 1);
    const inShoot = [2, 3].map((n) => insert(db, n, { shootId: SHOOT }));
    insert(db, 4);

    const run = photos.neighboursInShoot(SHOOT, 'taken_asc', inShoot[0]!, 50, NO_FILTERS);
    expect(run.map((photo) => photo.id)).toEqual(inShoot);
  });

  // Asked for by its ends rather than by a middle, for a caller that already knows
  // what sits either side of a run - the photographs a stack lies between - and
  // would otherwise have to know the collection's ordering to say which end of it
  // is "after".
  describe('a range', () => {
    test('is everything between its bounds, in every ordering', () => {
      const { db, photos } = context;
      const ids = [1, 2, 3, 4, 5].map((n) => insert(db, n));

      for (const ordering of ORDERINGS) {
        const whole = photos.rangeInLibrary(LIBRARY, ordering, { from: null, to: null }, NO_FILTERS).map((p) => p.id);
        expect(whole, ordering).toHaveLength(5);

        // Bounded by the two photographs either side of the middle three, given in
        // the collection's own order - which is what a caller reads off a listing.
        const inner = photos
          .rangeInLibrary(LIBRARY, ordering, { from: whole[0]!, to: whole[4]! }, NO_FILTERS)
          .map((p) => p.id);
        expect(inner, ordering).toEqual(whole);

        const middle = photos.rangeInLibrary(LIBRARY, ordering, { from: whole[1]!, to: whole[3]! }, NO_FILTERS).map((p) => p.id);
        expect(middle, ordering).toEqual(whole.slice(1, 4));
      }
      void ids;
    });

    // What the return jump is: the photographs a stack lies between, and the last
    // survivor is the one before the trailing bound.
    test('spans a stack, so the photo before its trailing bound is its last member', () => {
      const { db, photos, stacks } = context;
      const before = insert(db, 1);
      const members = [2, 3, 4].map((n) => insert(db, n));
      stacks.create(members);
      const after = insert(db, 5);

      const run = photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: before, to: after }, NO_FILTERS);
      expect(run.map((p) => p.id)).toEqual([before, ...members, after]);
      expect(run[run.length - 2]?.id).toBe(members[2]!);

      // And under the opposite ordering the bounds swap round, so the caller does
      // not have to know which is which: the last member is still N-1.
      const reversed = photos.rangeInLibrary(LIBRARY, 'taken_desc', { from: after, to: before }, NO_FILTERS);
      expect(reversed.map((p) => p.id)).toEqual([after, ...[...members].reverse(), before]);
      expect(reversed[reversed.length - 2]?.id).toBe(members[0]!);
    });

    test('honours the filters, so a rejected member is not the one jumped to', () => {
      const { db, photos, stacks } = context;
      const before = insert(db, 1);
      const members = [2, 3, 4].map((n) => insert(db, n));
      stacks.create(members);
      const after = insert(db, 5);
      db.query("UPDATE photos SET triage = 'rejected' WHERE id = ?").run(members[2]!);
      const active = { includeDeleted: false, triage: ['untriaged' as const, 'picked' as const] };

      const run = photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: before, to: after }, active);
      expect(run.map((p) => p.id)).toEqual([before, members[0]!, members[1]!, after]);
      expect(run[run.length - 2]?.id).toBe(members[1]!);
    });

    test('crosses the undated boundary from either side', () => {
      const { db, photos } = context;
      const dated = [1, 2].map((n) => insert(db, n));
      const undated = [3, 4].map((n) => insert(db, n, { undated: true }));

      expect(photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: dated[0]!, to: undated[1]! }, NO_FILTERS).map((p) => p.id)).toEqual([
        ...dated,
        ...undated,
      ]);
      expect(photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: dated[1]!, to: undated[0]! }, NO_FILTERS).map((p) => p.id)).toEqual([
        dated[1]!,
        undated[0]!,
      ]);
      // An open end runs to the end of the collection, undated tail included.
      expect(photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: undated[0]!, to: null }, NO_FILTERS).map((p) => p.id)).toEqual(undated);
      // The tail sorts last under `taken_desc` too - the flag leads the ORDER BY
      // and is always ascending - so bounding at the earliest dated photograph
      // stops before it rather than sweeping it in.
      expect(photos.rangeInLibrary(LIBRARY, 'taken_desc', { from: null, to: dated[0]! }, NO_FILTERS).map((p) => p.id)).toEqual([
        dated[1]!,
        dated[0]!,
      ]);
      expect(photos.rangeInLibrary(LIBRARY, 'taken_desc', { from: null, to: undated[0]! }, NO_FILTERS).map((p) => p.id)).toEqual([
        dated[1]!,
        dated[0]!,
        undated[1]!,
        undated[0]!,
      ]);
    });

    // An open bound means "that end of the collection", so the cap has to be read
    // from the bound that exists. Capped from the start instead, a `{from: null}`
    // range answers with the beginning of the collection - rows containing none of
    // what was asked about.
    test('caps from the bound it was given, not from the start of the collection', () => {
      const { db, photos, stacks } = context;
      for (let n = 1; n <= 40; n++) insert(db, n);
      const members = [41, 42].map((n) => insert(db, n));
      stacks.create(members);

      const run = photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: null, to: null }, NO_FILTERS);
      expect(run).toHaveLength(42);

      // Bounded only at the far end: the answer has to reach the stack, which sits
      // at the end, rather than returning the first rows of the library.
      const trailing = photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: null, to: members[1]! }, NO_FILTERS);
      expect(trailing[trailing.length - 1]?.id).toBe(members[1]!);
      expect(trailing.filter((photo) => photo.stack_id != null)).toHaveLength(2);
    });

    test('treats a bound outside the collection as absent rather than failing', () => {
      const { db, photos } = context;
      const ids = [1, 2].map((n) => insert(db, n));
      const elsewhere = insert(db, 3, { libraryId: OTHER });

      expect(photos.rangeInLibrary(LIBRARY, 'taken_asc', { from: elsewhere, to: null }, NO_FILTERS).map((p) => p.id)).toEqual(ids);
    });
  });

  test('the window is bounded, and centred on the photo asked about', () => {
    const { db, photos } = context;
    const ids = Array.from({ length: 40 }, (_, i) => insert(db, i + 1));

    const run = photos.neighboursInLibrary(LIBRARY, 'taken_asc', ids[20]!, 5, NO_FILTERS);
    // Five either side, plus the anchor.
    expect(run).toHaveLength(11);
    expect(run[5]?.id).toBe(ids[20]!);
    expect(run[0]?.id).toBe(ids[15]!);
    expect(run[10]?.id).toBe(ids[25]!);
  });
});
