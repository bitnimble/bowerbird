import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../db/migrations';
import { AppError } from '../../../errors';
import { neutralEdits } from '../../../schemas/photo_edits';
import { PhotosRepository } from '../../photos/photos_repository';
import { PhotoEditsRepository } from '../photo_edits_repository';
import { PhotoEditsService } from '../photo_edits_service';

const PHOTO = 'photo';

let db: Database;
let queueRebuild: ReturnType<typeof jest.fn>;
let service: PhotoEditsService;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(`INSERT INTO libraries (id, root_path, name) VALUES ('lib', '/photos', 'Library')`).run();
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added)
       VALUES (?, 'lib', 'a.arw', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(PHOTO);

  queueRebuild = jest.fn();
  const photos = {
    getById: jest.fn((id: string) => (id === PHOTO ? { id } : null)),
  } as unknown as PhotosRepository;
  service = new PhotoEditsService(new PhotoEditsRepository(db), photos, queueRebuild);
});

describe('PhotoEditsService', () => {
  it('renders nothing while the reader is still editing', () => {
    const saved = service.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    const back = service.undo(PHOTO, saved.rev);
    service.redo(PHOTO, back.rev);

    // A slider release says nothing about whether they are finished. Rebuilding on one
    // spends seconds of GPU on a frame they are about to change again, and does it once
    // more on the next release - all of it thrown away.
    expect(queueRebuild).not.toHaveBeenCalled();
  });

  it('renders when the editor says it has closed', () => {
    service.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);

    service.finish(PHOTO);

    // The one moment the reader has said they are done with the picture.
    expect(queueRebuild).toHaveBeenCalledWith([PHOTO]);
  });

  it('queues exactly the photos whose edits are newer than their renders', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = new PhotosRepository(db);
    // A second photo, already rendered *after* its last edit, and a third with no edits.
    for (const id of ['rendered', 'untouched']) {
      db.query(
        `INSERT INTO photos (id, library_id, file_path, width, height, date_added, needs_tile, needs_renditions)
           VALUES (?, 'lib', ?, 100, 100, '2026-01-01T00:00:00.000Z', 0, 0)`,
      ).run(id, `${id}.arw`);
    }
    repo.save('rendered', { ...neutralEdits(), exposure: 1 }, 0);
    db.query(`UPDATE photos SET renditions_built_at = '2099-01-01T00:00:00.000Z' WHERE id = 'rendered'`).run();

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    db.query('UPDATE photos SET needs_tile = 0, needs_renditions = 0 WHERE id = ?').run(PHOTO);

    expect(photos.queueEditedSince()).toBe(1);

    // The predicate is the mechanism rather than a filter on one: it is true however
    // the photo got that way, which is what lets the sweep at startup catch an editor
    // that never got to say it had closed. And it clears itself - `rendered` was built
    // after its edit, so it does not match.
    const queued = db
      .query('SELECT id FROM photos WHERE needs_renditions = 1')
      .all() as { id: string }[];
    expect(queued.map((r) => r.id)).toEqual([PHOTO]);
  });

  it('marks the photo as edited, which is what stops the viewer opening at the camera JPEG', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = new PhotosRepository(db);
    expect(photos.getById(PHOTO)?.is_edited).toBe(false);

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);

    // `photos_service` reads this to pick `default_rendition`: an embedded library
    // serves the camera's own JPEG, which cannot carry an edit, so a photo that has one
    // has to open at the rendition instead.
    expect(photos.getById(PHOTO)?.is_edited).toBe(true);
  });

  it('refuses a photo that does not exist before touching the edits at all', () => {
    expect(() => service.get('nope')).toThrow(AppError);
    // Otherwise the foreign key reports it, on the way in, as a 500 for what is a 404.
    expect(() => service.save('nope', neutralEdits(), 0)).toThrow(AppError);
    expect(() => service.finish('nope')).toThrow(AppError);
    expect(queueRebuild).not.toHaveBeenCalled();
  });
});
