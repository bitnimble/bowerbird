import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { AppError } from '../../../errors';
import { neutralEdits } from '../../../schemas/photo_edits';
import { PhotoCompositesRepository } from '../../photos/composites/photo_composites_repository';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { PhotoEditsRepository } from '../photo_edits_repository';
import { PhotoEditsService } from '../photo_edits_service';

const PHOTO = 'photo';

let db: Database;
let queueRebuild: ReturnType<typeof jest.fn>;
let service: PhotoEditsService;

/**
 * Records these stored copies as built from the settings the photograph holds now,
 * which is what a render landing does.
 *
 * The library below is SDR, so the variant the renditions pass writes is `full`; an HDR
 * one would write `full-hdr` and this would have to say so, which is the point of the
 * map being keyed by variant at all.
 */
function built(photoId: string, ...variants: string[]): void {
  for (const variant of variants) {
    db.query(
      `INSERT INTO renditions (photo_id, variant, needs_build, built_at, built_from)
         VALUES (?, ?, 0, '2026-02-01T00:00:00.000Z', (SELECT stamp FROM photo_edits WHERE photo_id = ?))
       ON CONFLICT (photo_id, variant)
         DO UPDATE SET needs_build = 0, built_at = excluded.built_at, built_from = excluded.built_from`,
    ).run(photoId, variant, photoId);
  }
}

/** Neither pass owed, and nothing recorded about what was rendered. */
function settled(photoId: string): void {
  for (const variant of ['grid', 'full']) {
    db.query(
      `INSERT INTO renditions (photo_id, variant, needs_build) VALUES (?, ?, 0)
       ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 0`,
    ).run(photoId, variant);
  }
}

/** Which photographs owe the renditions pass. */
function owingRenditions(): string[] {
  const rows = db
    .query(`SELECT photo_id FROM renditions WHERE variant = 'full' AND needs_build = 1`)
    .all() as { photo_id: string }[];
  return rows.map((row) => row.photo_id);
}

function photoProcessing(): PhotoProcessingRepository {
  return new PhotoProcessingRepository(db, new RenditionsRepository(db));
}

function photoComposites(): PhotoCompositesRepository {
  const stacks = new StackMembership(db);
  return new PhotoCompositesRepository(db, stacks, new PhotoPathsRepository(db, stacks));
}

function mergeComposite(photos: PhotoCompositesRepository): string {
  return photos.insertComposite({
    libraryId: 'lib',
    kind: 'panorama',
    reference: PHOTO,
    recipe: {
      version: 1,
      sources: [PHOTO, PHOTO].map((photoId) => ({
        photoId,
        size: [100, 100] as [number, number],
        rotation: [1, 0, 0, 0] as [number, number, number, number],
        focal: 100,
        lens: { crop: 1 },
        gain: 1,
      })),
      projection: 'cylindrical' as const,
      canvas: [200, 100] as [number, number],
      centre: [100, 50] as [number, number],
      radiansPerPixel: 0.01,
      crop: [0, 0, 1, 1] as [number, number, number, number],
      reference: 0,
    },
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(
    `INSERT INTO libraries (id, root_path, name, rendition_hdr) VALUES ('lib', '/photos', 'Library', 0)`,
  ).run();
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, 'lib', '{"kind":"file","path":"a.arw"}', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(PHOTO);

  queueRebuild = jest.fn();
  const photos = {
    getById: jest.fn((id: string) => (id === PHOTO ? { id } : null)),
  } as unknown as PhotoListingRepository;
  service = new PhotoEditsService(db, new PhotoEditsRepository(db), photos, queueRebuild);
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
    const photos = photoProcessing();
    // A second photo, already rendered *after* its last edit, and a third with no edits.
    for (const id of ['rendered', 'untouched']) {
      db.query(
        `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
           VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`,
      ).run(id, `${id}.arw`);
      settled(id);
    }
    repo.save('rendered', { ...neutralEdits(), exposure: 1 }, 0);
    // Built from the settings it holds, which is what "already rendered" means.
    built('rendered', 'grid', 'full');

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    settled(PHOTO);

    expect(photos.queueEditedSince()).toBe(1);

    // The predicate is the mechanism rather than a filter on one: it is true however
    // the photo got that way, which is what lets the sweep at startup catch an editor
    // that never got to say it had closed. And it clears itself - `rendered` was built
    // after its edit, so it does not match.
    expect(owingRenditions()).toEqual([PHOTO]);
  });

  // **A variant's entry is a claim about the world, not a cache key.** The predicate above
  // reads it as "this copy is of these settings", and it is the only thing that queues a
  // rebuild - for the editor saying it has closed and for the sweep at startup alike. So an
  // entry written for any *other* reason retires that photo's edit silently and permanently:
  // the sweep asks the same question afterwards and gets the same wrong answer, and the
  // gallery keeps showing the frame as it was.
  //
  // Written from the hazard rather than from a caller because the caller is whoever comes
  // next: a rebuilt `max` moved the shared column once, to make the viewer's cached URL
  // miss, and cost every edit made just before one. Nothing but a real render may claim one.
  it('a claim made by anything but a render retires the edit it was hiding', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = photoProcessing();

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    settled(PHOTO);
    expect(photos.queueEditedSince([PHOTO])).toBe(1);

    // Back to where the edit left it, and now something claims the settings without having
    // built either derived file.
    settled(PHOTO);
    built(PHOTO, 'grid', 'full');

    expect(photos.queueEditedSince([PHOTO])).toBe(0);
    expect(owingRenditions()).toEqual([]);
  });

  /**
   * Each pass answers for itself, because the two files are written at different
   * moments.
   *
   * A `full` built on request records what it rendered and builds no tile. Asked off
   * that one entry, the sweep afterwards compares the edit against the pass that *did*
   * run, finds nothing owed, and leaves the tile where it was - so the grid shows the
   * pre-edit frame for good, nothing revisiting a tile already on disk. It is reachable
   * without anything failing: an editor closed by killing the tab never queues, and the
   * viewer asking for `full` is what builds next.
   */
  it('queues the tile when only the renditions pass recorded the edit', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = photoProcessing();

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    settled(PHOTO);
    built(PHOTO, 'full');

    expect(photos.queueEditedSince([PHOTO])).toBe(1);

    const owed = db
      .query(`SELECT variant, needs_build FROM renditions WHERE photo_id = ? ORDER BY variant`)
      .all(PHOTO);
    expect(owed).toEqual([
      { variant: 'full', needs_build: 0 },
      { variant: 'grid', needs_build: 1 },
    ]);
  });

  /**
   * A frame's edit makes the panorama it belongs to stale, not only itself.
   *
   * **Nothing else was reaching the composite.** Its own copies are keyed by its own id and the
   * predicate asked about its own document, so developing a frame left the canvas exactly as it
   * was - and if its tile had been composited from the cameras' JPEGs, that tile could not carry
   * the edit at all. The frame is what moved; what has to be rebuilt is everything made of it.
   */
  it('queues the composites a frame belongs to when the frame is edited', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = photoProcessing();
    const panorama = mergeComposite(photoComposites());
    settled(PHOTO);
    settled(panorama);
    // Built from its recipe, as the merge that made it records.
    db.query('UPDATE renditions SET built_from = ? WHERE photo_id = ?').run(photos.builtFromOf(panorama), panorama);
    expect(photos.queueEditedSince()).toBe(0);

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);

    // Both: the frame's own copies, and the canvas made of it.
    expect(photos.queueEditedSince([PHOTO])).toBe(2);
    expect(owingRenditions().sort()).toEqual([panorama, PHOTO].sort());
  });

  // Which settles, or the sweep would rebuild every panorama of an edited frame for good: a
  // composite records the newest document behind it, its own or a frame's, exactly as a
  // photograph records its own (`processing_service::newest`).
  it('stops asking once the composite has been built from that document', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = photoProcessing();
    const panorama = mergeComposite(photoComposites());
    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    settled(PHOTO);
    settled(panorama);
    expect(photos.queueEditedSince()).toBe(2);

    // The frame's stamp, which is what the composite was rendered from.
    const stamp = (db.query('SELECT stamp FROM photo_edits WHERE photo_id = ?').get(PHOTO) as {
      stamp: string;
    }).stamp;
    for (const [id, variant] of [
      [PHOTO, 'grid'],
      [PHOTO, 'full'],
      [panorama, 'grid'],
      [panorama, 'full'],
    ] as const) {
      db.query(
        `UPDATE renditions SET needs_build = 0, built_from = ? WHERE photo_id = ? AND variant = ?`,
      ).run(stamp, id, variant);
    }

    expect(photos.queueEditedSince()).toBe(0);
  });

  // And the URL version cannot do it, which is the point of its being a separate column: a
  // `max` rebuild moving the version a client builds its URL from says nothing about which
  // settings `full` was rendered from, so an edit survives that rebuild.
  it('is not retired by the version a client builds its URL from', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = photoProcessing();

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);
    settled(PHOTO);
    db.query(
      `UPDATE renditions SET built_at = '2099-01-01T00:00:00.000Z'
        WHERE photo_id = ? AND variant = 'full'`,
    ).run(PHOTO);

    expect(photos.queueEditedSince([PHOTO])).toBe(1);
  });

  it('marks the photo as edited, which is what stops the viewer opening at the camera JPEG', () => {
    const repo = new PhotoEditsRepository(db);
    const photos = new PhotoListingRepository(db);
    expect(photos.getById(PHOTO)?.is_edited).toBe(false);

    repo.save(PHOTO, { ...neutralEdits(), exposure: 1.5 }, 0);

    // `photo_read_service` reads this to pick `shown_rendition`: an embedded library
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
