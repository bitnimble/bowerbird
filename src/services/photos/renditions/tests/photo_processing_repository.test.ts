import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { renditionCurrent } from '../../../blobs/rendition_fetch_service';
import { fileRecipe, type StoredRecipe } from '../../../../schemas/recipes';
import { formatOf } from '../../../../utils/scan';
import { rendersAhead, type RenditionVariant } from '../../../processing/renditions/renditions';
import { RenditionsRepository } from '../../../processing/renditions/renditions_repository';
import { PhotoProcessingRepository } from '../photo_processing_repository';

// A binned photo's file_path points into the bin at the library root, and only
// `deleted_from_path` still says which folder it came from (§12.3). Both queries
// here are keyed on a folder prefix, so both have to read the right column - and
// which one that is depends on whether the row is deleted.
const LIB = 'lib';

let db: Database;
let repo: PhotoProcessingRepository;

function insert(id: string, filePath: string, deletedFrom?: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted, deleted_from_path)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
  ).run(id, LIB, filePath, deletedFrom == null ? 0 : 1, deletedFrom ?? null);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new PhotoProcessingRepository(db, new RenditionsRepository(db));
  insert('live', 'Trip/a.arw');
  insert('binned', 'Bin/Trip/b.arw', 'Trip/b.arw');
  insert('elsewhere', 'Bin/Other/c.arw', 'Other/c.arw');
});

describe('PhotoProcessingRepository.built_from, per variant', () => {
  const AT = '2026-06-01T00:00:00.000Z';
  const EDITED = '01a0000000000000000000000000bbbb';
  const BEFORE = '01a0000000000000000000000000aaaa';

  const currentFor = (variant: RenditionVariant): boolean =>
    renditionCurrent(repo.renditionStamps('live', variant)?.built_from ?? null, EDITED);

  beforeEach(() => {
    // SDR, so the variant the renditions pass asks about is `full` rather than `full-hdr`.
    db.query(
      `INSERT INTO libraries (id, root_path, name, rendition_hdr) VALUES (?, '/photos', 'Library', 0)`,
    ).run(LIB);
    db.query(
      `INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp)
         VALUES ('live', '{}', 0, 1, '2026-05-01T00:00:00.000Z', ?)`,
    ).run(EDITED);
  });

  // Nothing sweeps beside a one-click re-render, and nothing queues a `max`, so this
  // entry is the only thing that can say the `max` on disk is behind.
  it('a full re-rendered after an edit does not vouch for the max built before it', () => {
    repo.markCopyBuilt('live', AT, BEFORE, 'max');
    repo.markRenditionsBuilt('live', AT, 'render', EDITED, 'full');

    expect(currentFor('full')).toBe(true);
    expect(currentFor('max')).toBe(false);
  });

  /**
   * **A canvas is as new as the newest document behind it, and its own never moves again.**
   *
   * The framing the merge writes is the composite's own document, so asking that alone leaves a
   * copy nothing queues - `max`, and the camera view a library serving the cameras' pictures opens
   * a panorama at - reading as current however its frames are developed afterwards. Nothing else
   * can notice: those two are built on request and no sweep visits them.
   */
  it('a frame developed after the canvas was built leaves the copies behind it', () => {
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES ('canvas', ?, json_object('kind', 'panorama', 'sources',
           json_array(json_object('photoId', 'live'))), 100, 100, '2026-01-01T00:00:00.000Z')`,
    ).run(LIB);
    repo.markCopyBuilt('canvas', AT, BEFORE, 'max');
    expect(renditionCurrent(repo.renditionStamps('canvas', 'max')?.built_from ?? null, null)).toBe(
      true,
    );

    // The frame's own document is `live`'s, which the composite names as a source: the canvas has
    // none of its own here, so a rule reading only that would see nothing at all.
    expect(
      renditionCurrent(
        repo.renditionStamps('canvas', 'max')?.built_from ?? null,
        repo.renditionStamps('canvas', 'max')?.edited_from ?? null,
      ),
    ).toBe(false);
  });

  // Both ranges are kept on disk, so a library whose HDR setting has been flipped has a
  // `full` of each, written at different moments.
  it('building one range of full does not vouch for the other', () => {
    repo.markRenditionsBuilt('live', AT, 'render', BEFORE, 'full');
    repo.markRenditionsBuilt('live', AT, 'render', EDITED, 'full-hdr');

    expect(currentFor('full-hdr')).toBe(true);
    expect(currentFor('full')).toBe(false);
  });
});

describe('PhotoProcessingRepository.markCopyBuilt', () => {
  it('stamps its own variant alone, leaving the renditions pass owed', () => {
    db.query(
      `UPDATE renditions SET needs_build = 1, built_at = '2026-01-01T00:00:00.000Z', built_from = 'edits-1'
        WHERE photo_id = 'live' AND variant = 'full'`,
    ).run();
    db.query(`UPDATE photos SET rendition_source = 'embedded' WHERE id = ?`).run('live');

    repo.markCopyBuilt('live', '2026-06-01T00:00:00.000Z', 'edits-2', 'max');

    // Whether the stage is finished and what the viewer is served are both claims a max
    // build cannot make, and `full` is a different file that this one did not write.
    expect(
      db
        .query(
          `SELECT variant, needs_build, built_at, built_from FROM renditions
             WHERE photo_id = ? AND variant IN ('full', 'max') ORDER BY variant`,
        )
        .all('live'),
    ).toEqual([
      {
        variant: 'full',
        needs_build: 1,
        built_at: '2026-01-01T00:00:00.000Z',
        built_from: 'edits-1',
      },
      {
        variant: 'max',
        needs_build: 0,
        built_at: '2026-06-01T00:00:00.000Z',
        built_from: 'edits-2',
      },
    ]);
    expect(db.query('SELECT rendition_source FROM photos WHERE id = ?').get('live')).toEqual({
      rendition_source: 'embedded',
    });
  });
});

describe('PhotoProcessingRepository.pendingWork', () => {
  beforeEach(() => {
    db.query(
      `INSERT INTO libraries (id, root_path, name, rendition_hdr) VALUES (?, '/photos', 'Library', 0)`,
    ).run(LIB);
    insert('other', 'Trip/d.arw');
    db.query('UPDATE renditions SET needs_build = 0').run();
  });
  const owe = (id: string, variant: RenditionVariant): void =>
    void db
      .query(
        `INSERT INTO renditions (photo_id, variant, needs_build) VALUES (?, ?, 1)
         ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 1`,
      )
      .run(id, variant);

  it('counts each kind of owed work on its own', () => {
    expect(repo.pendingWork(LIB)).toEqual({ thumbnails: 0, reading: 0, rendering: 0 });

    db.query("UPDATE photos SET media_image_id = 7 WHERE id = 'other'").run();
    owe('other', 'grid');
    owe('live', 'grid');
    expect(repo.pendingWork(LIB)).toEqual({ thumbnails: 1, reading: 1, rendering: 0 });
  });

  it('counts a render only where the renditions pass posts one', () => {
    db.query("UPDATE libraries SET rendition_source = 'embedded' WHERE id = ?").run(LIB);
    owe('live', 'full');
    expect(repo.pendingWork(LIB).rendering).toBe(0);

    db.query("UPDATE libraries SET rendition_source = 'render' WHERE id = ?").run(LIB);
    expect(repo.pendingWork(LIB).rendering).toBe(1);

    db.query("UPDATE libraries SET rendition_source = 'embedded' WHERE id = ?").run(LIB);
    db.query("UPDATE photos SET rendition_source = 'render' WHERE id = 'live'").run();
    expect(repo.pendingWork(LIB).rendering).toBe(1);
  });

  it('counts a render for exactly the rows `rendersAhead` renders', () => {
    db.query('DELETE FROM renditions').run();
    const files = ['a.arw', 'a.dng', 'a.jpg', 'a.png', 'a.heic', 'a.avif'];
    for (const [i, file] of files.entries()) {
      insert(`p${i}`, file);
      db.query('UPDATE photos SET format = ? WHERE id = ?').run(formatOf(file), `p${i}`);
      owe(`p${i}`, 'full');
    }
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES ('canvas', ?, json_object('kind', 'panorama', 'sources',
           json_array(json_object('photoId', 'p2'))), 100, 100, '2026-01-01T00:00:00.000Z')`,
    ).run(LIB);
    owe('canvas', 'full');
    const ids = [...files.map((_, i) => `p${i}`), 'canvas'];
    const rows = [
      ...files.map((file) => ({ recipe: fileRecipe(file), inputs: [file] })),
      { recipe: { kind: 'panorama' } as StoredRecipe, inputs: ['a.jpg'] },
    ];

    const counted: number[] = [];
    for (const librarySource of ['render', 'embedded'] as const) {
      for (const photoSource of [null, 'render', 'embedded'] as const) {
        for (const edited of [false, true]) {
          db.query('UPDATE libraries SET rendition_source = ? WHERE id = ?').run(
            librarySource,
            LIB,
          );
          db.query('UPDATE photos SET rendition_source = ?').run(photoSource);
          db.query('DELETE FROM photo_edits').run();
          for (const id of ids.filter(() => edited)) {
            db.query(
              `INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp)
                 VALUES (?, '{}', 1, 1, '2026-05-01T00:00:00.000Z', 'stamp')`,
            ).run(id);
          }
          const ahead = rows.filter((row) =>
            rendersAhead({ ...row, edited, photoSource, librarySource }),
          ).length;
          expect(repo.pendingWork(LIB).rendering).toBe(ahead);
          counted.push(ahead);
        }
      }
    }
    expect(new Set(counted)).toEqual(new Set([0, 3, 7]));
  });
});

describe('PhotoProcessingRepository.deviceTileImageId', () => {
  const made = (from: 'embedded' | 'render'): { from: typeof from; matched: boolean } => ({
    from,
    matched: false,
  });

  it('is the device thumbnail until a render replaces the tile, and again after', () => {
    db.query("UPDATE photos SET media_image_id = 7 WHERE id = 'live'").run();
    expect(repo.deviceTileImageId('live')).toBe(7);

    repo.markTileBuilt('live', '2026-06-01T00:00:00.000Z', null, made('embedded'));
    expect(repo.deviceTileImageId('live')).toBe(7);

    repo.markTileBuilt('live', '2026-06-01T00:00:01.000Z', 'edits-1', made('render'));
    expect(repo.deviceTileImageId('live')).toBeNull();
    expect(repo.mediaImageIdOf('live')).toBe(7);

    repo.markTileBuilt('live', '2026-06-01T00:00:02.000Z', 'edits-2', made('embedded'));
    expect(repo.deviceTileImageId('live')).toBe(7);
  });

  it("moves a thumbnail's version without settling the tile pass it still owes", () => {
    repo.markTileArrived('live', '2026-06-01T00:00:00.000Z');

    expect(
      db
        .query(
          "SELECT needs_build, built_at FROM renditions WHERE photo_id = 'live' AND variant = 'grid'",
        )
        .get(),
    ).toEqual({ needs_build: 1, built_at: '2026-06-01T00:00:00.000Z' });
  });

  it('is never a row the media index did not catalogue, or one dropped from it', () => {
    expect(repo.deviceTileImageId('binned')).toBeNull();

    db.query("UPDATE photos SET media_image_id = 7 WHERE id = 'live'").run();
    repo.dropDeviceTile('live');
    expect(repo.deviceTileImageId('live')).toBeNull();
  });
});
