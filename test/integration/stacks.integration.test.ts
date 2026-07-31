import { expect, test, describe, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/migrations';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { StacksRepository } from '../../src/services/stacks/stacks_repository';
import { StacksService } from '../../src/services/stacks/stacks_service';

const LIBRARY = '00000000-0000-4000-8000-000000000001';
const OTHER_LIBRARY = '00000000-0000-4000-8000-000000000002';
const SHOOT = '00000000-0000-4000-8000-000000000010';
const ALBUM = '00000000-0000-4000-8000-000000000020';

function photoId(n: number): string {
  return `00000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`;
}

function setUp(): { db: Database; stacks: StacksService; photos: PhotosRepository; repo: StacksRepository } {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  for (const id of [LIBRARY, OTHER_LIBRARY]) {
    db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(id, `/tmp/${id}`, 'taken_desc');
  }
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run(SHOOT, LIBRARY, 'Day1', 'Day1');
  db.query('INSERT INTO albums (id, name) VALUES (?, ?)').run(ALBUM, 'Picks');

  const photos = new PhotosRepository(db);
  const repo = new StacksRepository(db);
  const stacks = new StacksService(repo, photos, new LibrariesRepository(db));
  return { db, stacks, photos, repo };
}

/** A photo whose capture time is `minute` minutes past a fixed epoch. */
function insertPhoto(
  db: Database,
  n: number,
  options: { minute: number; libraryId?: string; shootId?: string | null } = { minute: 0 },
): string {
  const id = photoId(n);
  const taken = new Date(Date.UTC(2026, 0, 1, 0, options.minute)).toISOString();
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, file_path, width, height, date_taken, date_added)
     VALUES (?, ?, ?, ?, 3000, 2000, ?, ?)`,
  ).run(id, options.libraryId ?? LIBRARY, options.shootId ?? null, `IMG_${n}.ARW`, taken, taken);
  return id;
}

const NO_FILTERS = { includeDeleted: false } as const;

describe('stacks', () => {
  let context: ReturnType<typeof setUp>;
  beforeEach(() => {
    context = setUp();
  });

  test('a manual stack collapses its members into one row of the listing', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    insertPhoto(db, 9, { minute: 30 });

    stacks.create(ids);

    const listed = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, NO_FILTERS);
    expect(listed.total).toBe(2);
    expect(listed.photos).toHaveLength(2);
    // Newest first, so the stack's representative is the last frame of it.
    expect(listed.photos[1]!.id).toBe(ids[2]!);
    expect(listed.photos[1]!.stack_size).toBe(3);
    expect(listed.photos[0]!.stack_size).toBe(1);
  });

  test('selecting the stack row resolves to every member', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    insertPhoto(db, 9, { minute: 30 });
    stacks.create(ids);

    // Position 1 is the stack; the client never sees a member id.
    const resolved = photos.idsInLibrary(LIBRARY, 'taken_desc', [{ start: 1, end: 1 }], NO_FILTERS);
    expect(resolved.sort()).toEqual([...ids].sort());
  });

  test('selecting a stack in an album resolves only to the members that album holds', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    // Two of the three are in the album; the third is in the stack but not here.
    for (const id of [ids[0]!, ids[1]!]) {
      db.query('INSERT INTO album_photos (album_id, photo_id, date_added) VALUES (?, ?, ?)').run(ALBUM, id, 'x');
    }

    const resolved = photos.idsInAlbum(ALBUM, 'taken_desc', [{ start: 0, end: 0 }], NO_FILTERS);
    // An album is strict, so acting on the stack here acts on what the album
    // shows and counts, never on the member it does not hold.
    expect(resolved.sort()).toEqual([ids[0]!, ids[1]!].sort());
  });

  test('a selection in the Bin still resolves, where every row is deleted', () => {
    const { db, photos } = context;
    const id = insertPhoto(db, 1, { minute: 1 });
    db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run(id);

    // The Bin is the library under include_deleted + is_deleted, so a member set
    // that assumed undeleted rows would resolve this to nothing and a restore
    // would quietly do nothing.
    const binFilters = { includeDeleted: true, isDeleted: true };
    expect(photos.idsInLibrary(LIBRARY, 'taken_desc', [{ start: 0, end: 0 }], binFilters)).toEqual([id]);
  });

  test('selecting a stack never resolves to its binned members', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run(ids[0]!);

    const resolved = photos.idsInLibrary(LIBRARY, 'taken_desc', [{ start: 0, end: 0 }], NO_FILTERS);
    // The tile counts two, so the action takes two: what is on screen and what
    // is acted upon have to be the same set.
    expect(resolved.sort()).toEqual([ids[1]!, ids[2]!].sort());
  });

  test('a shoot shows the whole stack, an album only what it holds', () => {
    const { db, stacks, photos } = context;
    const inShoot = [1, 2].map((n) => insertPhoto(db, n, { minute: n, shootId: SHOOT }));
    const outside = insertPhoto(db, 3, { minute: 3 });
    stacks.create([...inShoot, outside]);
    db.query('INSERT INTO album_photos (album_id, photo_id, date_added) VALUES (?, ?, ?)').run(ALBUM, inShoot[0]!, 'x');

    const shootListing = photos.listByShoot(SHOOT, 'taken_desc', 0, 100, NO_FILTERS);
    expect(shootListing.photos).toHaveLength(1);
    // The full membership, because the shoot dims the outsider rather than
    // pretending it is not there.
    expect(shootListing.photos[0]!.stack_size).toBe(3);
    // ...and the representative is in the shoot, never the outsider.
    expect(inShoot).toContain(shootListing.photos[0]!.id);

    const albumListing = photos.listByAlbum(ALBUM, 'taken_desc', 0, 100, NO_FILTERS);
    expect(albumListing.photos).toHaveLength(1);
    expect(albumListing.photos[0]!.stack_size).toBe(1);
  });

  test('a filter promotes the next survivor rather than hiding the stack', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    // Reject the newest, which is the representative.
    db.query("UPDATE photos SET triage = 'rejected' WHERE id = ?").run(ids[2]!);

    const listed = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, { includeDeleted: false, triage: ['untriaged'] });
    expect(listed.photos).toHaveLength(1);
    expect(listed.photos[0]!.id).toBe(ids[1]!);
  });

  test('unstacking releases the photos and detection never reclaims them', () => {
    const { db, stacks, repo, photos } = context;
    const ids = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const stack = stacks.create(ids);

    stacks.unstack(stack.id);

    expect(repo.get(stack.id)).toBeNull();
    expect(photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, NO_FILTERS).total).toBe(2);
    // 'unstacked' is what keeps a later detection pass from putting them back.
    expect(repo.candidates(LIBRARY)).toHaveLength(0);
  });

  test('removing all but one member deletes the stack, since a stack of one is a photo', () => {
    const { db, stacks, repo } = context;
    const ids = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const stack = stacks.create(ids);

    stacks.removePhotos(stack.id, [ids[0]!]);

    expect(repo.get(stack.id)).toBeNull();
  });

  // Regression: a listing shows a photo with no stack on `is_representative`
  // alone, and only the newest member of a stack carries that flag. Removing any
  // of the others left it at 0, so the photograph disappeared from every listing
  // - for good, and while `total` went on counting it - with nothing on screen to
  // say where it had gone. Three members, because with two the only one you can
  // remove and still leave a stack behind is the representative.
  test('a member taken out of a stack is still in the listing it came from', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    const stack = stacks.create(ids);

    // The oldest, which is never the one standing for the stack.
    stacks.removePhotos(stack.id, [ids[0]!]);

    const listing = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, NO_FILTERS);
    // The stack's remaining two collapse to one row, and the one that left is a
    // photograph again beside it.
    expect(listing.photos.map((photo) => photo.id)).toContain(ids[0]!);
    expect(listing.photos).toHaveLength(2);
    expect(listing.total).toBe(2);
  });

  // What a triage session does to the gallery behind it (§20.2): it rejects
  // members, and the newest of them is the one the stack's tile stands for. The
  // flag is not moved - a rejected photo is still a member - so this is the
  // listing's second arm doing the promoting, and it is the interaction the flag
  // is a hint rather than a truth for.
  test('rejecting the member a stack stands for promotes the next one', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    // The newest is the representative, and it is the one triage rejected.
    const active = { includeDeleted: false, triage: ['untriaged' as const, 'picked' as const] };
    db.query("UPDATE photos SET triage = 'rejected' WHERE id = ?").run(ids[2]!);

    const listing = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, active);

    // Still one tile for the stack, standing for its newest surviving member,
    // and saying it holds two rather than three.
    expect(listing.photos).toHaveLength(1);
    expect(listing.photos[0]!.id).toBe(ids[1]!);
    expect(listing.photos[0]!.stack_size).toBe(2);
    expect(listing.total).toBe(1);
  });

  // The stored flag, not just what the listing manages to show: the second arm
  // would cope either way, so this is what says the stack stopped paying for it.
  test('rejecting the member a stack stands for moves the flag itself', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    const flagged = (): string | null =>
      (db.query('SELECT id FROM photos WHERE stack_id IS NOT NULL AND is_representative = 1').get() as { id: string } | null)?.id ??
      null;
    expect(flagged()).toBe(ids[2]!);

    photos.update(ids[2]!, { triage: 'rejected' });
    expect(flagged()).toBe(ids[1]!);

    // And back again when the verdict is taken back, which is what undo does.
    photos.update(ids[2]!, { triage: 'untriaged' });
    expect(flagged()).toBe(ids[2]!);
  });

  test('a stack whose members are all rejected still has exactly one flagged member', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);

    for (const id of ids) photos.update(id, { triage: 'rejected' });

    // Deprioritised, never excluded: leaving a stack with no flagged member at
    // all would put every listing on the slow arm for good.
    const flagged = db.query('SELECT id FROM photos WHERE stack_id IS NOT NULL AND is_representative = 1').all() as { id: string }[];
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.id).toBe(ids[2]!);
  });

  test('an untriaged member does not outrank a newer picked one', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);

    // The newest is picked and the rest are untriaged, which is stored as NULL.
    // `triage = 'rejected'` is then NULL rather than 0 for those rows, and SQLite
    // sorts NULL first - so without the null-safe comparison the *oldest*
    // untriaged frame outranks the keeper on nothing but its NULL.
    photos.update(ids[2]!, { triage: 'picked' });

    const flagged = (db.query('SELECT id FROM photos WHERE stack_id IS NOT NULL AND is_representative = 1').get() as { id: string })
      .id;
    expect(flagged).toBe(ids[2]!);
  });

  test('a stack whose every member is rejected leaves the gallery entirely', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    const active = { includeDeleted: false, triage: ['untriaged' as const, 'picked' as const] };

    for (const id of ids) photos.update(id, { triage: 'rejected' });

    // No tile and nothing to count: the flag is still set on one of them, and it
    // is still not enough, because the verdict filter excludes that row before
    // the representative question is ever asked.
    const gallery = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, active);
    expect(gallery.photos).toHaveLength(0);
    expect(gallery.total).toBe(0);

    // And it is all there again when the filter is the one that asks for it,
    // still as one tile standing for three.
    const rejected = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, { includeDeleted: false, triage: ['rejected'] });
    expect(rejected.photos).toHaveLength(1);
    expect(rejected.photos[0]!.stack_size).toBe(3);
  });

  test('a stack whose every member is binned leaves the gallery entirely', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);

    db.query('UPDATE photos SET is_deleted = 1 WHERE stack_id IS NOT NULL').run();

    expect(photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, NO_FILTERS).photos).toHaveLength(0);
    // The Bin is a listing like any other, so it collapses them the same way.
    const bin = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, { includeDeleted: true, isDeleted: true });
    expect(bin.photos).toHaveLength(1);
    expect(bin.photos[0]!.stack_size).toBe(3);
  });

  test('a stack rejected down to one survivor is an ordinary tile', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    const active = { includeDeleted: false, triage: ['untriaged' as const, 'picked' as const] };
    db.query("UPDATE photos SET triage = 'rejected' WHERE id IN (?, ?)").run(ids[1]!, ids[2]!);

    const listing = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, active);

    // Which is the usual outcome of a decisive session: one keeper, and a badge
    // saying "1" would be claiming a stack that is now a photograph.
    expect(listing.photos).toHaveLength(1);
    expect(listing.photos[0]!.id).toBe(ids[0]!);
    expect(listing.photos[0]!.stack_size).toBe(1);
  });

  test('stacking photos already in a stack moves them and cleans up behind them', () => {
    const { db, stacks, repo } = context;
    const first = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const second = [3, 4].map((n) => insertPhoto(db, n, { minute: n }));
    const original = stacks.create(first);
    stacks.create(second);

    // Takes one photo out of the first stack, which leaves it holding one.
    const merged = stacks.create([first[0]!, ...second]);

    expect(repo.get(original.id)).toBeNull();
    expect(repo.memberIds(merged.id).sort()).toEqual([first[0]!, ...second].sort());
  });

  test('removing a photo that belongs to another stack leaves it where it is', () => {
    const { db, stacks, repo } = context;
    const mine = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const theirs = [3, 4].map((n) => insertPhoto(db, n, { minute: n }));
    const target = stacks.create(mine);
    const other = stacks.create(theirs);

    stacks.removePhotos(target.id, [theirs[0]!]);

    // Named a photo it does not hold, so nothing moved out of the other stack.
    expect(repo.memberIds(other.id).sort()).toEqual([...theirs].sort());
  });

  test('the same photo twice is not two photos', () => {
    const { db, stacks } = context;
    const only = insertPhoto(db, 1, { minute: 1 });
    // Counting the array rather than the photographs would make a stack of one:
    // a badge claiming a stack that is not there, which nothing later prunes.
    expect(() => stacks.create([only, only])).toThrow(/at least two/);
  });

  test('an id that is not a photo does not make up the numbers', () => {
    const { db, stacks } = context;
    const only = insertPhoto(db, 1, { minute: 1 });
    expect(() => stacks.create([only, '00000000-0000-4000-8000-9999deadbeef'])).toThrow(/at least two/);
  });

  test('removing nothing leaves an automatic stack in detection hands', () => {
    const { db, stacks, repo } = context;
    const mine = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    // Hours later, so the window keeps it out of the stack entirely.
    const elsewhere = insertPhoto(db, 3, { minute: 600 });
    db.query('UPDATE photos SET descriptor = ? WHERE library_id = ?').run(Buffer.alloc(2600), LIBRARY);
    stacks.detect(LIBRARY);
    const auto = repo.autoStackIds(LIBRARY);
    expect(auto).toHaveLength(1);
    expect(repo.memberIds(auto[0]!).sort()).toEqual([...mine].sort());

    // Names a photo the stack does not hold, so nothing left it.
    stacks.removePhotos(auto[0]!, [elsewhere]);

    // Still detection's to manage: freezing it would put it out of reach of the
    // similarity setting for good, over a request that changed nothing.
    expect(repo.get(auto[0]!)?.origin).toBe('auto');
    expect(mine).toHaveLength(2);
  });

  test('the photo left behind by a remove is not re-stacked automatically', () => {
    const { db, stacks, repo } = context;
    const ids = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const stack = stacks.create(ids);

    stacks.removePhotos(stack.id, [ids[0]!]);

    // The stack is gone, and neither photo is detection's again: one was taken
    // out by hand and the other is only alone because of that.
    expect(repo.get(stack.id)).toBeNull();
    db.query('UPDATE photos SET descriptor = ? WHERE library_id = ?').run(Buffer.alloc(2600), LIBRARY);
    expect(repo.candidates(LIBRARY)).toHaveLength(0);
  });

  test('a band in the Bin shows the binned members, not the live ones', () => {
    const { db, stacks } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    const stack = stacks.create(ids);
    db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run(ids[0]!);

    // The band has to agree with the listing it was opened from: in the Bin the
    // tile stands for the binned frame, so returning the live members would show
    // photographs that are not in the Bin under a tile that counts the ones that
    // are.
    expect(stacks.photosOf(stack.id, { deleted: true }).map((photo) => photo.id)).toEqual([ids[0]!]);
    expect(stacks.photosOf(stack.id, {}).map((photo) => photo.id).sort()).toEqual([ids[1]!, ids[2]!].sort());
  });

  test('exactly one member of a stack is ever flagged as its representative', () => {
    const { db, stacks } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    const stack = stacks.create(ids);

    const flagged = () =>
      (db.query('SELECT COUNT(*) AS n FROM photos WHERE stack_id = ? AND is_representative = 1').get(stack.id) as {
        n: number;
      }).n;
    // The listing shows one row per flagged member, so two would show the stack
    // twice. A unique index makes that an error rather than a duplicate tile, and
    // this is the invariant it guards.
    expect(flagged()).toBe(1);
    // ...through every way membership changes.
    stacks.removePhotos(stack.id, [ids[2]!]);
    expect(flagged()).toBe(1);
  });

  test('the flag follows the newest member when one is added', () => {
    const { db, stacks, photos } = context;
    const older = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const newest = insertPhoto(db, 3, { minute: 30 });
    stacks.create([...older, newest]);

    // The tile is the newest photograph in the stack, which is what the flag has
    // to point at for the fast path to agree with the promotion path.
    const listed = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, NO_FILTERS);
    expect(listed.photos).toHaveLength(1);
    expect(listed.photos[0]!.id).toBe(newest);
  });

  test('a stack whose representative is filtered out still shows, promoted', () => {
    const { db, stacks, photos } = context;
    const ids = [1, 2, 3].map((n) => insertPhoto(db, n, { minute: n }));
    stacks.create(ids);
    // Reject the newest, which is the one the flag points at.
    db.query("UPDATE photos SET triage = 'rejected' WHERE id = ?").run(ids[2]!);

    const listed = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, {
      includeDeleted: false,
      triage: ['untriaged'],
    });
    // The flagged row is hidden, so the next survivor stands for the stack rather
    // than the stack vanishing from the collection.
    expect(listed.photos).toHaveLength(1);
    expect(listed.photos[0]!.id).toBe(ids[1]!);
    expect(listed.total).toBe(1);
  });

  test('a stack cannot span libraries', () => {
    const { db, stacks } = context;
    const here = insertPhoto(db, 1, { minute: 1 });
    const there = insertPhoto(db, 2, { minute: 2, libraryId: OTHER_LIBRARY });
    expect(() => stacks.create([here, there])).toThrow(/span libraries/);
  });

  test('a manual stack survives a detection pass', () => {
    const { db, stacks, repo } = context;
    // Deliberately unlike each other and far apart, so detection would never
    // group them: the point is that it does not take them apart either.
    const ids = [1, 2].map((n) => insertPhoto(db, n, { minute: n * 90 }));
    const stack = stacks.create(ids);
    db.query('UPDATE photos SET descriptor = ? WHERE library_id = ?').run(Buffer.alloc(2600), LIBRARY);

    stacks.detect(LIBRARY);

    expect(repo.get(stack.id)).not.toBeNull();
    expect(repo.memberIds(stack.id).sort()).toEqual([...ids].sort());
  });

  test('detection groups identical frames, and only within the window', () => {
    const { db, stacks, repo, photos } = context;
    // Two pairs of byte-identical descriptors: the first pair a minute apart, the
    // second an hour after them. Detection walks candidates in runs split at
    // gaps wider than the window, so this pins that the split changes no
    // grouping - two stacks, not one, and not none.
    const near = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const later = [3, 4].map((n) => insertPhoto(db, n, { minute: 60 + n }));
    db.query('UPDATE photos SET descriptor = ? WHERE library_id = ?').run(Buffer.alloc(2600), LIBRARY);

    expect(stacks.detect(LIBRARY)).toBe(2);

    const listed = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, NO_FILTERS);
    expect(listed.total).toBe(2);
    expect(listed.photos.every((photo) => photo.stack_size === 2)).toBe(true);
    // Each pair is its own stack rather than all four in one.
    const stackIds = new Set(listed.photos.map((photo) => photo.stack_id));
    expect(stackIds.size).toBe(2);
    expect(repo.memberIds([...stackIds][0]!)).toHaveLength(2);
    expect([...near, ...later]).toHaveLength(4);
  });

  test('a descriptor of the wrong size is skipped rather than read past', () => {
    const { db, stacks, photos } = context;
    const good = [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    const truncated = insertPhoto(db, 3, { minute: 3 });
    db.query('UPDATE photos SET descriptor = ? WHERE library_id = ?').run(Buffer.alloc(2600), LIBRARY);
    // A blob from another version of the format. The grouping reads
    // count * size bytes in one go, so this must never reach it.
    db.query('UPDATE photos SET descriptor = ? WHERE id = ?').run(Buffer.alloc(64), truncated);

    expect(stacks.detect(LIBRARY)).toBe(1);

    const listed = photos.listByLibrary(LIBRARY, 'taken_desc', 0, 100, NO_FILTERS);
    // The two sound frames stack; the odd one out is left alone rather than
    // taking the whole pass down with it.
    expect(listed.total).toBe(2);
    expect(listed.photos.find((photo) => photo.stack_id != null)?.stack_size).toBe(2);
    expect(good).toHaveLength(2);
  });

  test('detection does nothing when the library has it switched off', () => {
    const { db, stacks } = context;
    [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    db.query('UPDATE photos SET descriptor = ? WHERE library_id = ?').run(Buffer.alloc(2600), LIBRARY);
    db.query('UPDATE libraries SET auto_stack = 0 WHERE id = ?').run(LIBRARY);

    expect(stacks.detect(LIBRARY)).toBe(0);
  });

  test('photos with no descriptor are never candidates', () => {
    const { db, repo } = context;
    [1, 2].map((n) => insertPhoto(db, n, { minute: n }));
    expect(repo.candidates(LIBRARY)).toHaveLength(0);
  });

  test('positions are reported against the collapsed listing', () => {
    const { db, stacks, photos } = context;
    const older = insertPhoto(db, 1, { minute: 1 });
    const stacked = [2, 3].map((n) => insertPhoto(db, n, { minute: n + 10 }));
    const newest = insertPhoto(db, 4, { minute: 40 });
    const stack = stacks.create(stacked);

    const positions = photos.positionsInLibrary(LIBRARY, 'taken_desc', [newest, stack.id, older], NO_FILTERS);
    expect(positions.get(newest)).toBe(0);
    // The stack occupies one position, keyed by the stack rather than by any
    // photograph in it.
    expect(positions.get(stack.id)).toBe(1);
    expect(positions.get(older)).toBe(2);
  });

  test('a key that has left the collection is simply absent', () => {
    const { db, photos } = context;
    const id = insertPhoto(db, 1, { minute: 1 });
    const positions = photos.positionsInLibrary(LIBRARY, 'taken_desc', [id, 'gone'], NO_FILTERS);
    expect(positions.has('gone')).toBe(false);
  });
});
