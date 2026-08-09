import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../db/migrations';
import { AppError } from '../../../errors';
import { neutralEdits } from '../../../schemas/photo_edits';
import type { PhotosRepository } from '../../photos/photos_repository';
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
  it('requeues both derived stages when a save moves the picture', () => {
    service.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);

    // Both, not just the renditions: the grid tile is the same pixels, and requeuing
    // one leaves the gallery showing the frame as it was.
    expect(queueRebuild).toHaveBeenCalledWith([PHOTO]);
  });

  it('requeues nothing when a save changes nothing', () => {
    const saved = service.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    queueRebuild.mockClear();

    service.save(PHOTO, saved.doc, saved.rev);

    // A retried request rebuilds a frame that is already correct, which at 61MP is
    // seconds of GPU work for a picture nobody changed.
    expect(queueRebuild).not.toHaveBeenCalled();
  });

  it('requeues on undo and redo, which change the picture as surely as a save', () => {
    const saved = service.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    queueRebuild.mockClear();

    const back = service.undo(PHOTO, saved.rev);
    expect(queueRebuild).toHaveBeenCalledTimes(1);

    service.redo(PHOTO, back.rev);
    expect(queueRebuild).toHaveBeenCalledTimes(2);
  });

  it('requeues nothing for a step that had nowhere to go', () => {
    service.undo(PHOTO, 0);

    expect(queueRebuild).not.toHaveBeenCalled();
  });

  it('refuses a photo that does not exist before touching the edits at all', () => {
    expect(() => service.get('nope')).toThrow(AppError);
    // Otherwise the foreign key reports it, on the way in, as a 500 for what is a 404.
    expect(() => service.save('nope', neutralEdits(), 0)).toThrow(AppError);
    expect(queueRebuild).not.toHaveBeenCalled();
  });
});
