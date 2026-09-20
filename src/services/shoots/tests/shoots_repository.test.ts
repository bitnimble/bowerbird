import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { ShootsRepository } from '../shoots_repository';

const LIB = 'lib';

let db: Database;
let repo: ShootsRepository;

function shoot(id: string, folderPath: string): void {
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run(id, LIB, folderPath, id);
}

function photo(id: string, folderPath: string, shootId: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, recipe, width, height, date_added)
       VALUES (?, ?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(id, LIB, shootId, `${folderPath}/${id}.arw`);
}

function hiddenIds(): string[] {
  return (db.query('SELECT id FROM shoots WHERE is_hidden = 1 ORDER BY id').all() as { id: string }[]).map((r) => r.id);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new ShootsRepository(db);
});

describe('ShootsRepository.setHidden', () => {
  /** Which shoots are out of sight, by the derived answer a listing and a client both read. */
  const outOfSight = (): string[] =>
    repo
      .listByLibrary(LIB)
      .filter((s) => s.is_hidden)
      .map((s) => s.id)
      .sort();

  // The subtree goes out of sight with it, but by derivation - so the flag itself lands on one row.
  it('takes the subtree out of sight while writing only its own row', () => {
    shoot('trip', 'Trip');
    shoot('day', 'Trip/Day one');
    shoot('deep', 'Trip/Day one/Morning');
    shoot('other', 'Other');

    repo.setHidden('trip', true);
    expect(outOfSight()).toEqual(['day', 'deep', 'trip']);
    expect(hiddenIds()).toEqual(['trip']);

    repo.setHidden('trip', false);
    expect(outOfSight()).toEqual([]);
  });

  /**
   * The whole reason the subtree is derived rather than cascaded.
   *
   * A cascade cannot tell a shoot hidden by its parent from one hidden on its own, so unhiding the
   * parent discards the child's own hiding - silently, and with nothing left to restore it from.
   */
  it('keeps a shoot hidden on its own when the ancestor that also hid it is brought back', () => {
    shoot('trip', 'Trip');
    shoot('day', 'Trip/Day one');

    repo.setHidden('day', true);
    repo.setHidden('trip', true);
    expect(outOfSight()).toEqual(['day', 'trip']);

    repo.setHidden('trip', false);
    expect(outOfSight()).toEqual(['day']);
  });

  // Nothing re-cascades on a rename, so a shoot carried into a hidden subtree has to read as hidden
  // off its new path alone - and one carried out of it has to stop.
  it('follows a folder rename in both directions without being told', () => {
    shoot('trip', 'Trip');
    shoot('loose', 'Loose');
    repo.setHidden('trip', true);
    expect(outOfSight()).toEqual(['trip']);

    repo.relocate('loose', 'Loose', 'Trip/Loose');
    expect(outOfSight()).toEqual(['loose', 'trip']);

    repo.relocate('loose', 'Trip/Loose', 'Loose');
    expect(outOfSight()).toEqual(['trip']);
  });

  // Likewise for one that did not exist when the ancestor was hidden.
  it('covers a shoot created under a hidden ancestor afterwards', () => {
    shoot('trip', 'Trip');
    repo.setHidden('trip', true);

    shoot('day', 'Trip/Day one');
    expect(outOfSight()).toEqual(['day', 'trip']);
  });

  // The range is [P || '/', P || '0'), not a LIKE: folder names are the photographer's own, and `_`
  // is a LIKE wildcard, so `Trip_2` would match `TripX2` and a sibling would be hidden by name.
  it('does not reach a sibling whose name starts the same', () => {
    shoot('trip', 'Trip');
    shoot('trip2', 'Trip2');
    shoot('underscore', 'Trip_2');

    repo.setHidden('trip', true);
    expect(outOfSight()).toEqual(['trip']);
  });

  // Folder paths only mean anything inside one library, so a matching path in another must not match.
  it('does not reach a shoot at the same path in another library', () => {
    shoot('trip', 'Trip');
    db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run(
      'elsewhere',
      'other-lib',
      'Trip/Day one',
      'Day one',
    );

    repo.setHidden('trip', true);
    expect(repo.listByLibrary('other-lib').map((s) => [s.id, s.is_hidden])).toEqual([['elsewhere', false]]);
  });

  it('moves a stamp of its own, so a folder rename cannot carry a stale flag over it', () => {
    shoot('trip', 'Trip');
    repo.setHidden('trip', true);

    const row = db.query('SELECT stamp, stamp_hidden FROM shoots WHERE id = ?').get('trip') as {
      stamp: string | null;
      stamp_hidden: string | null;
    };
    expect(row.stamp_hidden).not.toBeNull();
    expect(row.stamp).toBeNull();
  });

  // `is_hidden` is what a client greys and filters on; only `hidden_directly` can be undone, so the
  // row that offers to bring a shoot back has to be able to tell them apart.
  it('reports being out of sight apart from having been the one put away', () => {
    shoot('trip', 'Trip');
    shoot('day', 'Trip/Day one');
    repo.setHidden('trip', true);

    const byId = new Map(repo.listByLibrary(LIB).map((s) => [s.id, s]));
    expect([byId.get('trip')?.is_hidden, byId.get('trip')?.hidden_directly]).toEqual([true, true]);
    expect([byId.get('day')?.is_hidden, byId.get('day')?.hidden_directly]).toEqual([true, false]);
  });
});

// What a client is served leaves the hidden out, so nothing downstream has to remember to filter
// them - while the catalogue's own questions still see every shoot, a hidden one being a shoot.
describe('which shoots a listing answers with', () => {
  beforeEach(() => {
    shoot('trip', 'Trip');
    shoot('away', 'Away');
    repo.setHidden('away', true);
  });

  it('holds every shoot by default, which is what the tree is derived from', () => {
    expect(repo.listByLibrary(LIB).map((s) => s.id)).toEqual(['away', 'trip']);
  });

  it('leaves the hidden out when asked to', () => {
    expect(repo.listByLibrary(LIB, false).map((s) => s.id)).toEqual(['trip']);
  });

  // The folder tree is read off the disk, where nothing says a folder is put away, so the paths have
  // to travel separately for it to drop them.
  // Only the shoots put away themselves. The caller drops every path at or under one, so naming a
  // descendant as well would be the same folders twice - and a descendant hidden on its own is named
  // here in its own right, which is what keeps it dropped when its ancestor comes back.
  it('answers which folders went with them', () => {
    shoot('deep', 'Away/Day one');
    repo.setHidden('away', true);
    expect(repo.hiddenFolders(LIB).sort()).toEqual(['Away']);

    repo.setHidden('deep', true);
    repo.setHidden('away', false);
    expect(repo.hiddenFolders(LIB).sort()).toEqual(['Away/Day one']);
  });
});

// The row's count and its thumbnail are what its own page lists, so a photograph put away by hand
// is out of both - and a hidden shoot still reports what it holds rather than zero, or there is
// nothing on the row to judge whether to bring it back by.
describe('what a shoot row says it holds', () => {
  beforeEach(() => {
    shoot('trip', 'Trip');
    photo('first', 'Trip', 'trip');
    photo('second', 'Trip', 'trip');
  });

  it('leaves out a photograph put away, banner and count alike', () => {
    expect(repo.getById('trip')).toMatchObject({ photo_count: 2, banner_photo_id: 'first' });

    db.query("UPDATE photos SET is_hidden = 1 WHERE id = 'first'").run();
    expect(repo.getById('trip')).toMatchObject({ photo_count: 1, banner_photo_id: 'second' });
  });

  it('still counts them when the shoot itself is the thing hidden', () => {
    repo.setHidden('trip', true);
    expect(repo.getById('trip')).toMatchObject({ photo_count: 2, banner_photo_id: 'first', is_hidden: true });
  });
});
