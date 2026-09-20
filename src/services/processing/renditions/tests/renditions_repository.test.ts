import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { RenditionsRepository, type Made } from '../renditions_repository';

const LIB = 'lib';
const PHOTO = 'photo';

let db: Database;
let renditions: RenditionsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(`INSERT INTO libraries (id, root_path, name, rendition_hdr) VALUES (?, '/photos', 'Library', 0)`).run(LIB);
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, '{"kind":"file","path":"a.arw"}', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(PHOTO, LIB);
  renditions = new RenditionsRepository(db);
});

const owed = (): number => new PhotoProcessingRepository(db, new RenditionsRepository(db)).countPendingProcessing(LIB);

describe('RenditionsRepository', () => {
  // The whole reason an import writes no rendition rows: a photograph that has just
  // arrived owes every one of them, and a row appears when one is built or queued.
  it('reads a photograph with no rows at all as owing both passes', () => {
    expect(owed()).toBe(1);
    expect(renditions.stamps(PHOTO, 'grid')).toEqual({ built_at: null, built_from: null });
  });

  it('stops owing a pass once that pass has landed', () => {
    renditions.markBuilt(PHOTO, 'grid', '2026-02-01T00:00:00.000Z', 'edits-1', { from: 'render', matched: false });
    // Still the renditions pass, which is a different file written at a different moment.
    expect(owed()).toBe(1);

    renditions.markBuilt(PHOTO, 'full', '2026-02-01T00:00:01.000Z', 'edits-1', { from: 'render', matched: false });
    expect(owed()).toBe(0);
    expect(renditions.versions(PHOTO)).toEqual({
      grid: '2026-02-01T00:00:00.000Z',
      full: '2026-02-01T00:00:01.000Z',
    });
  });

  // Whether the file on disk is the camera's own picture of the whole frame, which the library's
  // own setting cannot say: a tile is written from the camera's JPEG at import and rewritten from
  // the render when the queue reaches it, and only a render the match warped is still that
  // picture. The panorama alignment searches one when it is, and the RAW when it is not.
  it('says whether the tile is still the camera’s own picture', () => {
    const built = (at: string, made: Made | null, edits: string | null = null): void =>
      renditions.markBuilt(PHOTO, 'grid', at, edits, made);

    expect(renditions.cameraTile(PHOTO)).toBe(false);

    built('2026-02-01T00:00:00.000Z', { from: 'embedded', matched: false });
    expect(renditions.cameraTile(PHOTO)).toBe(true);

    // The render that replaces it, warped into the camera's geometry by the match: the same
    // picture, so still a plane the recipe's lens table starts in.
    built('2026-02-01T00:00:01.000Z', { from: 'render', matched: true });
    expect(renditions.cameraTile(PHOTO)).toBe(true);

    // And unwarped, which is our own geometry and is not.
    built('2026-02-01T00:00:02.000Z', { from: 'render', matched: false });
    expect(renditions.cameraTile(PHOTO)).toBe(false);

    // A fetched copy is somebody else's render of a file this device may not hold, so it says
    // nothing rather than guessing - and nothing is what the alignment refuses.
    built('2026-02-01T00:00:03.000Z', null);
    expect(renditions.cameraTile(PHOTO)).toBe(false);

    // A tile built from an edit document is part of a frame wherever the crop was, and the
    // alignment needs the whole one.
    built('2026-02-01T00:00:04.000Z', { from: 'embedded', matched: false }, 'edits-1');
    expect(renditions.cameraTile(PHOTO)).toBe(false);

    // And one owed again describes the photograph as it was before whatever queued it.
    built('2026-02-01T00:00:05.000Z', { from: 'embedded', matched: false });
    renditions.queue(PHOTO, ['grid']);
    expect(renditions.cameraTile(PHOTO)).toBe(false);
  });

  // The one thing an absent row cannot say. Left owed, a photograph whose decode
  // failed is picked up by every batch for the life of the library and fails again.
  it('settles a failure without claiming anything was built', () => {
    renditions.unqueue(PHOTO, ['grid', 'full']);

    expect(owed()).toBe(0);
    expect(renditions.versions(PHOTO)).toEqual({});
  });

  it('queues a variant again without disowning what is on disk', () => {
    renditions.markBuilt(PHOTO, 'grid', '2026-02-01T00:00:00.000Z', 'edits-1', { from: 'render', matched: false });
    renditions.queue(PHOTO, ['grid']);

    // The stamp is what a rebuilt copy is measured against, and the file it describes
    // is still there until the rebuild replaces it.
    expect(renditions.stamps(PHOTO, 'grid')).toEqual({
      built_at: '2026-02-01T00:00:00.000Z',
      built_from: 'edits-1',
    });
    expect(owed()).toBe(1);
  });
});
