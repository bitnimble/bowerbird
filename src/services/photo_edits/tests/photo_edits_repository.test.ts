import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../db/migrations';
import { PhotoEditsRepository } from '../photo_edits_repository';
import { neutralEdits, type EditDoc } from '../../../schemas/photo_edits';

const PHOTO = 'photo';

let db: Database;
let repo: PhotoEditsRepository;

/** The neutral document with some fields moved, which is what a client PUTs. */
function edited(over: Partial<EditDoc>): EditDoc {
  return { ...neutralEdits(), ...over };
}

/** Save at whatever revision is current, for a test that is not about conflicts. */
function save(over: Partial<EditDoc>): ReturnType<PhotoEditsRepository['save']> {
  const { doc, rev } = repo.get(PHOTO);
  return repo.save(PHOTO, { ...doc, ...over }, rev);
}

beforeEach(() => {
  db = new Database(':memory:');
  // As `db/connection.ts` opens it. Enforcement is off by default in bun:sqlite
  // and is per connection, so without this the cascade these tables rely on never
  // fires and a test asserting it would pass against nothing.
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(`INSERT INTO libraries (id, root_path, name) VALUES ('lib', '/photos', 'Library')`).run();
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added)
       VALUES (?, 'lib', 'a.arw', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(PHOTO);
  repo = new PhotoEditsRepository(db);
});

describe('PhotoEditsRepository.get', () => {
  it('answers with the neutral document at revision zero for a photo nobody has edited', () => {
    const state = repo.get(PHOTO);

    expect(state.doc).toEqual(neutralEdits());
    expect(state.rev).toBe(0);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    // The editor's open needs a document either way, so this must not be a miss:
    // nothing is written until the first edit.
    expect(db.query('SELECT COUNT(*) AS n FROM photo_edits').get()).toEqual({ n: 0 });
  });
});

describe('PhotoEditsRepository.save', () => {
  it('stores the document, bumps the revision and leaves a step to undo', () => {
    const state = save({ exposure: 1.5 });

    expect(state.doc.exposure).toBe(1.5);
    expect(state.rev).toBe(1);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it('writes nothing at all when the document has not moved', () => {
    save({ exposure: 1.5 });
    const again = repo.save(PHOTO, edited({ exposure: 1.5 }), 1);

    // A retried request is a no-op rather than a step that undoes to the same
    // picture it redoes to.
    expect(again.rev).toBe(1);
    expect(again.canUndo).toBe(true);
    expect(again.canRedo).toBe(false);
  });

  it('records one delta covering every field a single commit moved', () => {
    save({ exposure: 1.0, contrast: 20, shadows: -10 });
    const undone = repo.undo(PHOTO, 1);

    // Not three undos through pictures that never existed - an import writes ten
    // fields at once and a crop drag four.
    expect(undone.doc.exposure).toBe(0);
    expect(undone.doc.contrast).toBe(0);
    expect(undone.doc.shadows).toBe(0);
    expect(undone.canUndo).toBe(false);
  });

  it('refuses a save built on a revision that has moved on', () => {
    save({ exposure: 1.0 });

    // Two tabs: the second holds rev 0 and would otherwise have the server diff a
    // stale document, inventing a delta for a change nobody made.
    expect(() => repo.save(PHOTO, edited({ contrast: 30 }), 0)).toThrow(/revision 1, not 0/);
    expect(repo.get(PHOTO).doc.exposure).toBe(1.0);
  });
});

describe('PhotoEditsRepository undo and redo', () => {
  it('steps back and forward over the same array without losing the redo tail', () => {
    save({ exposure: 1.0 });
    save({ contrast: 40 });

    const back = repo.undo(PHOTO, 2);
    expect(back.doc.contrast).toBe(0);
    expect(back.doc.exposure).toBe(1.0);
    expect(back.canUndo).toBe(true);
    expect(back.canRedo).toBe(true);

    const again = repo.undo(PHOTO, back.rev);
    expect(again.doc.exposure).toBe(0);
    expect(again.canUndo).toBe(false);
    expect(again.canRedo).toBe(true);

    const forward = repo.redo(PHOTO, again.rev);
    expect(forward.doc.exposure).toBe(1.0);
    expect(forward.canUndo).toBe(true);
    expect(forward.canRedo).toBe(true);
  });

  it('drops the redo tail when a new edit lands on an undone state', () => {
    save({ exposure: 1.0 });
    save({ contrast: 40 });
    const back = repo.undo(PHOTO, 2);

    repo.save(PHOTO, { ...back.doc, shadows: -25 }, back.rev);
    const state = repo.get(PHOTO);

    // The contrast branch is gone: a new edit after an undo is a new branch, and
    // what it replaced is no longer reachable.
    expect(state.canRedo).toBe(false);
    expect(state.doc.shadows).toBe(-25);
    expect(state.doc.contrast).toBe(0);
  });

  it('does nothing at either end rather than stepping off the array', () => {
    const nothing = repo.undo(PHOTO, 0);
    expect(nothing.rev).toBe(0);
    expect(nothing.canUndo).toBe(false);

    save({ exposure: 1.0 });
    const past = repo.redo(PHOTO, 1);
    expect(past.doc.exposure).toBe(1.0);
    expect(past.canRedo).toBe(false);
  });

  it('refuses a step built on a stale revision', () => {
    save({ exposure: 1.0 });
    save({ contrast: 40 });

    expect(() => repo.undo(PHOTO, 1)).toThrow(/revision 2, not 1/);
  });
});

describe('PhotoEditsRepository durability', () => {
  it('keeps the document readable when the history cannot be parsed', () => {
    save({ exposure: 1.0 });
    db.query('UPDATE photo_edit_history SET deltas = ? WHERE photo_id = ?').run('not json', PHOTO);

    const state = repo.get(PHOTO);

    // Nothing renders a picture from the history, so a corrupt one costs the undo
    // and not the editor's open.
    expect(state.doc.exposure).toBe(1.0);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });

  it('keeps fields a newer build wrote that this one has never heard of', () => {
    save({ exposure: 1.0 });
    const stored = JSON.parse(
      (db.query('SELECT doc FROM photo_edits WHERE photo_id = ?').get(PHOTO) as { doc: string }).doc,
    );
    db.query('UPDATE photo_edits SET doc = ? WHERE photo_id = ?').run(
      JSON.stringify({ ...stored, version: 2, grainAmount: 40 }),
      PHOTO,
    );

    const doc = repo.get(PHOTO).doc as Record<string, unknown>;

    // Stripping would be data loss with nothing raised, on the one path most
    // likely to hit it: an older client opening a newer catalogue.
    expect(doc.grainAmount).toBe(40);
    expect(doc.exposure).toBe(1.0);
  });

  it('goes with the photo on a hard delete, and stays through a soft one', () => {
    save({ exposure: 1.0 });

    db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run(PHOTO);
    expect(repo.get(PHOTO).doc.exposure).toBe(1.0);

    db.query('DELETE FROM photos WHERE id = ?').run(PHOTO);
    expect(repo.get(PHOTO).rev).toBe(0);
    expect(db.query('SELECT COUNT(*) AS n FROM photo_edit_history').get()).toEqual({ n: 0 });
  });
});
