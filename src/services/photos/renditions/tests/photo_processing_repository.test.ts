import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { renditionCurrent } from '../../../blobs/rendition_fetch_service';
import type { RenditionVariant } from '../../../processing/renditions/renditions';
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
    expect(renditionCurrent(repo.renditionStamps('canvas', 'max')?.built_from ?? null, null)).toBe(true);

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
      { variant: 'full', needs_build: 1, built_at: '2026-01-01T00:00:00.000Z', built_from: 'edits-1' },
      { variant: 'max', needs_build: 0, built_at: '2026-06-01T00:00:00.000Z', built_from: 'edits-2' },
    ]);
    expect(db.query('SELECT rendition_source FROM photos WHERE id = ?').get('live')).toEqual({
      rendition_source: 'embedded',
    });
  });
});
